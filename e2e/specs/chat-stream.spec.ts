import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';

declare global {
  interface Window {
    shortAnswerTest?: {
      stream?: ReadableStreamDefaultController<Uint8Array>;
      sample: boolean;
      prematureFrames: string[];
      sections: Set<Element>;
    };
  }
}

test.describe('chat stream', () => {
  test('a send during runtime cleanup waits and continues in the same conversation', async ({ page }) => {
    let ready = false;
    const requests: Array<{ url: string; body: string }> = [];
    await installMockApi(page, { custom: async (route) => {
      const request = route.request();
      if (!/\/chats\/[^/]+\/message$/.test(new URL(request.url()).pathname)) return false;
      requests.push({ url: request.url(), body: request.postData()! });
      if (!ready) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
          code: 'turn_active', error: 'The previous turn is still finishing',
        }) });
      } else {
        await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
          { event: 'chunk', data: { text: 'Continued in this conversation.' } },
          { event: 'done', data: { stopReason: 'end_turn', persisted: true } },
        ]) });
      }
      return true;
    } });
    await bootWithWorkspace(page);
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('Run the next check');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.getByText('Waiting for previous response to finish', { exact: true })).toBeVisible();
    await expect(page.locator('.terminal-message-user').getByText('Run the next check', { exact: true })).toHaveCount(1);
    await expect(composer).toBeEmpty();
    await expect(page.getByText('failed', { exact: true })).toHaveCount(0);
    ready = true;
    await expect(page.getByText('Continued in this conversation.', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for previous response to finish', { exact: true })).toHaveCount(0);
    await expect(page.locator('.terminal-message-user').getByText('Run the next check', { exact: true })).toHaveCount(1);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    expect(new Set(requests.map((request) => request.url)).size).toBe(1);
  });

  test('Stop withdraws a waiting send without cancelling the previous response', async ({ page }) => {
    let messages = 0;
    let cancellations = 0;
    await installMockApi(page, { custom: async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (/\/chats\/[^/]+\/cancel$/.test(path)) cancellations++;
      if (!/\/chats\/[^/]+\/message$/.test(path)) return false;
      messages++;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'turn_active' }) });
      return true;
    } });
    await page.clock.install();
    await bootWithWorkspace(page);
    await page.locator('[contenteditable="true"]').first().fill('Wait for the next check');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.getByText('Waiting for previous response to finish', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Stop stream/ }).click();
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
    await expect(page.getByText('Waiting for previous response to finish', { exact: true })).toHaveCount(0);
    const stoppedAt = messages;
    // Advance beyond the capped retry delay to prove the waiting POST stops.
    await page.clock.fastForward(3_000);
    expect(messages).toBe(stoppedAt);
    expect(cancellations).toBe(0);
  });

  test('user message → assistant chunks rendered → title applied', async ({ page }) => {
    await installMockApi(page);
    await bootWithWorkspace(page);

    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('hello kiro');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // Chunks from defaultTurn are concatenated by the reducer.
    await expect(page.getByText('Hello from mock kiro.')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('This is a fake reply.')).toBeVisible();

    // Title event renders in multiple places (toast, sidebar, topbar) — any
    // single appearance proves the `title` SSE event reached the reducer.
    await expect(page.getByText('Mock turn').first()).toBeVisible();
  });

  test('follow-up chips render from stream metadata', async ({ page }) => {
    await installMockApi(page);
    await bootWithWorkspace(page);

    await page.locator('[contenteditable="true"]').first().fill('hi');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // FollowUpRow renders the three follow-up suggestions from defaultTurn.
    for (const fu of ['Tell me more', 'What else?', 'Stop']) {
      await expect(page.getByText(fu)).toBeVisible({ timeout: 5_000 });
    }
  });

  for (const doneTiming of ['before', 'after'] as const) {
    test(`short answer shows follow-ups once when done arrives ${doneTiming} displayed text finishes`, async ({ page }) => {
      await installMockApi(page);
      await page.addInitScript(() => {
        const state: NonNullable<Window['shortAnswerTest']> = {
          sample: false, prematureFrames: [], sections: new Set(),
        };
        window.shortAnswerTest = state;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          if (method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) { state.stream = controller; },
            });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
          }
          return originalFetch(input, init);
        };
        const sampleFrame = () => {
          if (state.sample) {
            const section = document.querySelector('.t-followups');
            if (section) {
              state.sections.add(section);
              const answer = document.querySelector('.terminal-message-assistant');
              if (!answer?.textContent?.includes('好的。')) {
                state.prematureFrames.push(answer?.textContent ?? '');
              }
            }
          }
          requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
      });
      await bootWithWorkspace(page);
      await page.locator('[contenteditable="true"]').first().fill('请简短回答');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect.poll(() => page.evaluate(() => !!window.shortAnswerTest?.stream)).toBe(true);

      await page.evaluate(body => window.shortAnswerTest!.stream!.enqueue(new TextEncoder().encode(body)), sseBody([
        { event: 'chunk', data: { text: '好' } },
      ]));
      await expect(page.getByText('好', { exact: true })).toBeVisible();
      const done = { event: 'done' as const, data: { stopReason: 'end_turn' } };
      await page.evaluate(body => {
        const state = window.shortAnswerTest!;
        state.sample = true;
        state.stream!.enqueue(new TextEncoder().encode(body));
      }, sseBody([
        { event: 'chunk', data: { text: '的。\n\n[FOLLOW-UP 1/3: 为什么？]\n[FOLLOW-UP 2/3: 举个例子？]\n[FOLLOW-UP 3/3: 下一步呢？]' } },
        ...(doneTiming === 'before' ? [done] : []),
      ]));

      await expect(page.getByText('好的。', { exact: true })).toBeVisible();
      const section = page.getByRole('region', { name: 'Suggested follow-ups' });
      await expect(section.locator('.t-followup-row')).toHaveCount(3);
      if (doneTiming === 'after') {
        await page.evaluate(body => window.shortAnswerTest!.stream!.enqueue(new TextEncoder().encode(body)), sseBody([done]));
      }
      await page.evaluate(async () => {
        window.shortAnswerTest!.stream!.close();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const samples = await page.evaluate(() => {
        const state = window.shortAnswerTest!;
        state.sample = false;
        return { prematureFrames: state.prematureFrames, sections: state.sections.size };
      });
      expect(samples.prematureFrames).toEqual([]);
      expect(samples.sections).toBe(1);
    });
  }
});
