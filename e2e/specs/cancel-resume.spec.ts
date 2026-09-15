import { test, expect, type Locator, type Page } from '@playwright/test';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';

const waitingLabel = 'Waiting for cancellation to finish';
const cleanupError = 'Pi session cleanup timed out. Original history retained; retry when cleanup finishes.';
const originalReply = 'Original partial response.';
const staleChunk = 'STALE cancelled-turn output';
const staleTitle = 'STALE cancelled-turn title';
const stalePermission = 'STALE cancelled-turn permission';

interface ControlledStream {
  url: string;
  turnId: string;
  aborted: boolean;
  readerCancelled: boolean;
  headersReleased: boolean;
  fetchRejected: boolean;
  releaseHeaders?: () => void;
  write: (body: string, close?: boolean) => void;
}

declare global {
  interface Window {
    __cancelResume: {
      messages: ControlledStream[];
      observers: ControlledStream[];
      cancellations: Array<{ url: string; turnId: string; acknowledge: () => void }>;
    };
  }
}

async function installCancellationStreams(page: Page, deferFirstMessageHeaders = false) {
  await installMockApi(page);
  await page.addInitScript((deferFirstMessageHeaders) => {
    const originalFetch = window.fetch.bind(window);
    const state: Window['__cancelResume'] = { messages: [], observers: [], cancellations: [] };
    window.__cancelResume = state;

    function responseStream(url: string, turnId: string, signal: AbortSignal | null | undefined, observer: boolean) {
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream: ControlledStream = {
        url, turnId, aborted: false, readerCancelled: false, headersReleased: true, fetchRejected: false,
        write(body, close = false) {
          controller.enqueue(encoder.encode(body));
          if (close) controller.close();
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() { stream.readerCancelled = true; },
      });
      const abort = () => {
        stream.aborted = true;
        // Keep observer reads pending to deliver already-buffered bytes after
        // abort. The frontend must reject them even when transport teardown lags.
        if (!observer) controller.error(new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      (observer ? state.observers : state.messages).push(stream);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }

    window.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const endpoint = url.pathname.match(/^\/api\/chats\/[^/]+\/(message|cancel|stream)$/)?.[1];
      if (method === 'POST' && (endpoint === 'message' || endpoint === 'cancel')) {
        const payload = JSON.parse(String(init?.body));
        if (endpoint === 'message') {
          const response = responseStream(url.href, payload.turnId, signal, false);
          if (!deferFirstMessageHeaders || state.messages.length !== 1) return response;
          const message = state.messages[0];
          message.headersReleased = false;
          return new Promise<Response>((resolve, reject) => {
            message.releaseHeaders = () => {
              message.headersReleased = true;
              resolve(response);
            };
            const abort = () => {
              message.fetchRejected = true;
              reject(new DOMException('Aborted before response headers', 'AbortError'));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return new Promise<Response>((resolve, reject) => {
          state.cancellations.push({
            url: url.href,
            turnId: payload.turnId,
            acknowledge: () => resolve(Response.json({ ok: true })),
          });
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      if (method === 'GET' && endpoint === 'stream') {
        return responseStream(url.href, url.searchParams.get('fromTurnId') ?? '', signal, true);
      }
      return originalFetch(input, init);
    };
  }, deferFirstMessageHeaders);
}

async function startAndStop(page: Page) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill('start the long turn');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => page.evaluate(() => window.__cancelResume.messages.length)).toBe(1);
  const first = await page.evaluate(() => {
    const { url, turnId } = window.__cancelResume.messages[0];
    return { url, turnId };
  });
  expect(first.turnId).toBeTruthy();
  await page.evaluate((body) => window.__cancelResume.messages[0].write(body), sseBody([
    { event: 'chunk', data: { text: originalReply, turnId: first.turnId, seq: 0 } },
  ]));
  await expect(page.getByText(originalReply, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Stop stream/ }).click();
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await expect(composer).toBeEditable();
  await expect.poll(() => page.evaluate(() => window.__cancelResume.messages[0].aborted)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__cancelResume.cancellations.length)).toBe(1);
  expect(await page.evaluate(() => window.__cancelResume.cancellations[0].turnId)).toBe(first.turnId);
  expect(await page.evaluate(() => window.__cancelResume.observers.length)).toBe(0);
  return first;
}

async function acknowledgeCancel(page: Page, first: { url: string; turnId: string }) {
  await page.evaluate(() => window.__cancelResume.cancellations[0].acknowledge());
  await expect.poll(() => page.evaluate(() => window.__cancelResume.observers.length)).toBe(1);
  const url = new URL(await page.evaluate(() => window.__cancelResume.observers[0].url));
  expect(url.pathname).toBe(new URL(first.url).pathname.replace(/\/message$/, '/stream'));
  expect(url.searchParams.get('fromTurnId')).toBe(first.turnId);
  expect(url.searchParams.get('fromSeq')).toBe('0');
}

function ignoredOutput(turnId: string) {
  return sseBody([
    { event: 'chunk', data: { text: staleChunk, turnId, seq: 1 } },
    { event: 'title', data: { title: staleTitle, turnId, seq: 2 } },
    { event: 'permission_request', data: {
      requestId: 901, title: stalePermission, turnId, seq: 3,
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    } },
  ]);
}

async function expectNoStaleOutput(page: Page) {
  for (const text of [staleChunk, staleTitle, stalePermission]) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
}

async function expectContained(locator: Locator, width: number) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  await expect.poll(() => locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

test('cancel before message headers aborts the pending fetch and the next message gets a clean reply', async ({ page }) => {
  await installCancellationStreams(page, true);
  await bootWithWorkspace(page);
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill('cancel before response headers');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  // Stop can appear during ensure-session; explicitly wait for POST /message.
  await expect.poll(() => page.evaluate(() => window.__cancelResume.messages.length)).toBe(1);
  const first = await page.evaluate(() => {
    const { url, turnId, headersReleased } = window.__cancelResume.messages[0];
    return { url, turnId, headersReleased };
  });
  expect(first.turnId).toBeTruthy();
  expect(first.headersReleased).toBe(false);
  await page.evaluate((body) => window.__cancelResume.messages[0].write(body, true), sseBody([
    { event: 'chunk', data: { text: staleChunk, turnId: first.turnId, seq: 0 } },
    { event: 'done', data: { stopReason: 'end_turn', turnId: first.turnId, seq: 1 } },
  ]));
  await expect(page.getByText(staleChunk)).toHaveCount(0);
  await page.getByRole('button', { name: /Stop stream/ }).click();
  await expect.poll(() => page.evaluate(() => {
    const first = window.__cancelResume.messages[0];
    return { aborted: first.aborted, rejected: first.fetchRejected, headersReleased: first.headersReleased };
  })).toEqual({ aborted: true, rejected: true, headersReleased: false });
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await expect(composer).toBeEditable();
  await expect.poll(() => page.evaluate(() => window.__cancelResume.cancellations.length)).toBe(1);
  expect(await page.evaluate(() => window.__cancelResume.cancellations[0].turnId)).toBe(first.turnId);
  await acknowledgeCancel(page, first);
  await page.evaluate((body) => window.__cancelResume.observers[0].write(body, true), sseBody([
    { event: 'done', data: { stopReason: 'cancelled', persisted: true, turnId: first.turnId, seq: 0 } },
  ]));
  await expect.poll(() => page.evaluate(() => window.__cancelResume.observers[0].aborted)).toBe(true);

  await composer.fill('second turn after early cancellation');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect.poll(() => page.evaluate(() => window.__cancelResume.messages.length)).toBe(2);
  const secondTurnId = await page.evaluate(() => window.__cancelResume.messages[1].turnId);
  expect(secondTurnId).toBeTruthy();
  expect(secondTurnId).not.toBe(first.turnId);
  await page.evaluate(() => window.__cancelResume.messages[0].releaseHeaders!());
  await expect(page.getByRole('button', { name: /Stop stream/ })).toBeVisible();
  await page.evaluate((body) => window.__cancelResume.messages[1].write(body, true), sseBody([
    { event: 'chunk', data: { text: 'FRESH reply after early cancellation', turnId: secondTurnId, seq: 0 } },
    { event: 'done', data: { stopReason: 'end_turn', persisted: true, turnId: secondTurnId, seq: 1 } },
  ]));
  await expect(page.getByText('FRESH reply after early cancellation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  await expect(page.getByRole('status', { name: waitingLabel, exact: true })).toHaveCount(0);
  await expectNoStaleOutput(page);
});

test.describe('cancel + resume', () => {
  test.beforeEach(async ({ page }) => {
    await installCancellationStreams(page);
    await bootWithWorkspace(page);
  });

  test('slow cleanup unlocks the composer and exposes the exact failure without refresh', async ({ page }, info) => {
    const first = await startAndStop(page);
    const pending = page.getByRole('status', { name: waitingLabel, exact: true });
    await expect(pending).toHaveCount(0);
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('Retry when cleanup finishes');
    await expect(page.getByRole('button', { name: /Send \(Enter\)/ })).toBeEnabled();
    await expect(pending).toBeVisible();
    // The status also covers a slow POST; observation must wait for its reply.
    expect(await page.evaluate(() => window.__cancelResume.observers.length)).toBe(0);
    await acknowledgeCancel(page, first);
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectContained(pending, width);
      await expect(composer).toBeEditable();
      await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`cancel-pending-${width}.png`), animations: 'disabled' });
    }
    await page.evaluate((body) => window.__cancelResume.observers[0].write(body, true),
      ignoredOutput(first.turnId) + sseBody([
        { event: 'cancel_phase', data: { phase: 'acknowledged', turnId: first.turnId, seq: 4 } },
        { event: 'error', data: { message: cleanupError, turnId: first.turnId, seq: 5 } },
        { event: 'done', data: { stopReason: 'cancelled', turnId: first.turnId, seq: 6 } },
      ]));
    await expect(page.getByText(cleanupError, { exact: true }).first()).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(page.getByText(originalReply, { exact: true })).toBeVisible();
    await expect(composer).toHaveText('Retry when cleanup finishes');
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
    await expectNoStaleOutput(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectContained(page.getByText(cleanupError, { exact: true }).first(), width);
      await expect(composer).toBeEditable();
      await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`cancel-cleanup-error-${width}.png`), animations: 'disabled' });
    }
  });

  test('successful cleanup clears the idle status and preserves the draft and original reply', async ({ page }) => {
    const first = await startAndStop(page);
    await acknowledgeCancel(page, first);
    const pending = page.getByRole('status', { name: waitingLabel, exact: true });
    await expect(pending).toBeVisible();
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('Continue after cleanup');
    await page.evaluate((body) => window.__cancelResume.observers[0].write(body, true), sseBody([
      { event: 'cancel_phase', data: { phase: 'settled', turnId: first.turnId, seq: 1 } },
      { event: 'done', data: { stopReason: 'cancelled', persisted: true, turnId: first.turnId, seq: 2 } },
    ]));
    await expect(pending).toHaveCount(0);
    await expect(page.getByText(cleanupError, { exact: true })).toHaveCount(0);
    await expect(page.getByText(originalReply, { exact: true })).toBeVisible();
    await expect(composer).toHaveText('Continue after cleanup');
    await expect(composer).toBeEditable();
    await expect(page.getByRole('button', { name: /Send \(Enter\)/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
  });

  test('an immediate next send detaches the old observer and rejects its delayed events', async ({ page }) => {
    const first = await startAndStop(page);
    await acknowledgeCancel(page, first);
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('second turn');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect.poll(() => page.evaluate(() => window.__cancelResume.messages.length)).toBe(2);
    await expect.poll(() => page.evaluate(() => window.__cancelResume.observers[0].aborted)).toBe(true);
    const secondTurnId = await page.evaluate(() => window.__cancelResume.messages[1].turnId);
    expect(secondTurnId).toBeTruthy();
    expect(secondTurnId).not.toBe(first.turnId);
    await page.evaluate((body) => window.__cancelResume.observers[0].write(body),
      ignoredOutput(first.turnId) + sseBody([
        { event: 'retry_start', data: { detail: waitingLabel, turnId: first.turnId, seq: 4 } },
        { event: 'error', data: { message: cleanupError, turnId: first.turnId, seq: 5 } },
        { event: 'done', data: { stopReason: 'cancelled', turnId: first.turnId, seq: 6 } },
      ]));
    // Wait until the delayed read has actually been consumed and discarded.
    await expect.poll(() => page.evaluate(() => window.__cancelResume.observers[0].readerCancelled)).toBe(true);
    await expect(page.getByRole('button', { name: /Stop stream/ })).toBeVisible();
    await expect(page.getByRole('status', { name: waitingLabel, exact: true })).toHaveCount(0);
    await expect(page.getByText(cleanupError, { exact: true })).toHaveCount(0);
    await expectNoStaleOutput(page);
    await page.evaluate((body) => window.__cancelResume.messages[1].write(body, true), sseBody([
      { event: 'chunk', data: { text: 'FRESH reply after cancel', turnId: secondTurnId, seq: 0 } },
      { event: 'done', data: { stopReason: 'end_turn', persisted: true, turnId: secondTurnId, seq: 1 } },
    ]));
    await expect(page.getByText('FRESH reply after cancel', { exact: true })).toBeVisible();
    await expect(page.getByText(originalReply, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Stop stream/ })).toHaveCount(0);
    await expect(page.getByRole('status', { name: waitingLabel, exact: true })).toHaveCount(0);
    await expect(page.getByText(cleanupError, { exact: true })).toHaveCount(0);
    await expectNoStaleOutput(page);
  });
});
