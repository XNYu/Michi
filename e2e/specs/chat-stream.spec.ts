import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';

declare global {
  interface Window {
    hiddenTailStream?: ReadableStreamDefaultController<Uint8Array>;
    shortAnswerTest?: {
      stream?: ReadableStreamDefaultController<Uint8Array>;
      sample: boolean;
      prematureFrames: string[];
      sections: Set<Element>;
    };
  }
}

test.describe('chat stream', () => {
  for (const boundary of ['visible-answer', 'done'] as const) {
    test(`sending after ${boundary} silently continues while the runtime finishes`, async ({ page }) => {
      let ready = false;
      let firstTurn = true;
      const requests: Array<{ url: string; body: string }> = [];
      await installMockApi(page, { custom: async (route) => {
        const request = route.request();
        if (!/\/chats\/[^/]+\/message$/.test(new URL(request.url()).pathname)) return false;
        if (firstTurn) {
          firstTurn = false;
          await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
            { event: 'chunk', data: { text: 'The changes are ready.\n\n[FOLLOW-UP 1/3: Run the check]\n[FOLLOW-UP 2/3: Review changes]\n[FOLLOW-UP 3/3: Next step]' } },
            ...(boundary === 'done' ? [{ event: 'done' as const, data: { stopReason: 'end_turn', persisted: true } }] : []),
          ]) });
          return true;
        }
        requests.push({ url: request.url(), body: request.postData()! });
        if (!ready) {
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
            code: 'turn_active', error: 'The previous turn is still finishing',
          }) });
        } else {
          const payload = request.postDataJSON();
          const reply = payload.displayText === 'Then summarize the result' ? 'Summary delivered.' : 'Continued in this conversation.';
          await route.fulfill({ contentType: 'text/event-stream', body: sseBody([
            { event: 'chunk', data: { text: reply } },
            { event: 'done', data: { stopReason: 'end_turn', persisted: true } },
          ]) });
        }
        return true;
      } });
      // Keep the unfinished first foreground stream alive after its response
      // closes. The real backend retains its immutable turn for replay.
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
          if (/\/chats\/[^/]+\/stream$/.test(url.pathname)) {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                window.hiddenTailStream = controller;
                init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
              },
            }), { headers: { 'content-type': 'text/event-stream' } });
          }
          return originalFetch(input, init);
        };
      });
      await bootWithWorkspace(page);
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.fill('Review the current changes');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await expect(page.getByText('The changes are ready.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send (Enter)', exact: true })).toBeVisible();
      await composer.fill('Run the next check');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
      await expect(page.locator('.terminal-message-user').getByText('Run the next check', { exact: true })).toHaveCount(1);
      await expect(composer).toBeEmpty();
      await expect(page.getByText(/Waiting for|Still finishing|previous turn is still|已收到|撤回|start a branch/i)).toHaveCount(0);
      await expect(page.getByText('failed', { exact: true })).toHaveCount(0);
      await expect(page.locator('.t-pre-block')).toHaveCount(0);
      if (boundary === 'visible-answer') {
        // A further message belongs to the new foreground turn. The old
        // hidden tail's late terminal event must leave this queue intact.
        await composer.fill('Then summarize the result');
        await page.getByRole('button', { name: 'Send next (Enter). Sends after the current response', exact: true }).click();
        await expect(page.locator('.t-pre-block')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => !!window.hiddenTailStream)).toBe(true);
        await page.evaluate(async (body) => {
          window.hiddenTailStream!.enqueue(new TextEncoder().encode(body));
          window.hiddenTailStream!.close();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }, sseBody([{ event: 'done', data: { stopReason: 'end_turn', persisted: true } }]));
        await expect(page.locator('.t-pre-block')).toHaveCount(1);
      }
      ready = true;
      await expect(page.getByText('Continued in this conversation.', { exact: true })).toBeVisible();
      await expect(page.locator('.terminal-message-user').getByText('Run the next check', { exact: true })).toHaveCount(1);
      const continuationRequests = requests.filter((request) => JSON.parse(request.body).displayText === 'Run the next check');
      expect(new Set(continuationRequests.map((request) => request.body)).size).toBe(1);
      if (boundary === 'visible-answer') {
        await expect(page.getByText('Summary delivered.', { exact: true })).toBeVisible();
        await expect(page.locator('.terminal-message-user').getByText('Then summarize the result', { exact: true })).toHaveCount(1);
      }
      expect(new Set(requests.map((request) => request.url)).size).toBe(1);
    });
  }

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
