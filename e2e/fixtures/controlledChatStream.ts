import type { Page } from '@playwright/test';
import { sseBody, type SseEvent } from './mockApi';

interface ControlledStream {
  requests: Array<{ url: string; body: Record<string, unknown> }>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  closed: boolean;
}

type StreamWindow = Window & { __michiControlledStream: ControlledStream };

/**
 * A browser-local HTTP response seam, not an application event seam. Unlike
 * route.fulfill(), ReadableStream can remain open between assertions. All SSE
 * bytes still pass through production fetchStream/readSseStream/runChatStream.
 * No real backend, provider, database or user data is accessed.
 */
export async function installControlledChatStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: ControlledStream = { requests: [], controller: null, closed: true };
    (window as StreamWindow).__michiControlledStream = state;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method !== 'POST' || !/\/api\/chats\/[^/]+\/message(?:\?|$)/.test(url)) return realFetch(input, init);
      if (!state.closed) throw new Error('This fixture supports one active chat stream');
      state.requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      state.closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { state.controller = controller; },
        cancel() { state.closed = true; state.controller = null; },
      });
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      signal?.addEventListener('abort', () => {
        if (state.closed) return;
        state.closed = true;
        state.controller?.error(new DOMException('Aborted', 'AbortError'));
        state.controller = null;
      }, { once: true });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    };
  });
}

export async function controlledStreamState(page: Page) {
  return page.evaluate(() => {
    const state = (window as StreamWindow).__michiControlledStream;
    return { requests: state.requests, closed: state.closed };
  });
}

/** Write genuine encoded backend frames; deliberately permits duplicate/out-of-order seq values. */
export async function pushChatStream(page: Page, events: SseEvent[], close = false): Promise<void> {
  await page.evaluate(({ body, finish }) => {
    const state = (window as StreamWindow).__michiControlledStream;
    if (!state.controller || state.closed) throw new Error('No active response stream');
    state.controller.enqueue(new TextEncoder().encode(body));
    if (finish) {
      state.controller.close();
      state.closed = true;
      state.controller = null;
    }
  }, { body: sseBody(events), finish: close });
}
