import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePaneId, encodePaneId } from 'michi-shared';
import type { PaneFeedEventV1 } from 'michi-shared';
import {
  PaneInspectionClientError,
  inspectPane,
  readPaneOutput,
  subscribePanes,
} from './paneInspection';
import * as streamTransport from './streamTransport';

const BASE = 'http://localhost:3000/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Builds an SSE byte stream from `event:`/`data:` frames, matching the backend's
 *  `res.write(\`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n\`)` framing exactly
 *  (backend/src/routes/paneInspection.ts's /panes/subscribe handler). */
function sseResponse(frames: Array<{ event: string; data: unknown }>, status = 200): Response {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** A response whose body never closes on its own — lets a test hold the stream open long enough
 *  to call the unsubscribe function and assert the underlying fetch's AbortSignal fired, without
 *  racing the stream's own natural end. */
function openSseResponse(): { response: Response; controller: ReadableStreamDefaultController<Uint8Array> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  return { response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }), controller };
}

function snapshotEvent(paneId: string, cursor: string): PaneFeedEventV1 {
  return {
    version: 1,
    type: 'snapshot',
    paneId,
    cursor,
    emittedAt: 1_000,
    descriptor: { version: 1 } as unknown as PaneFeedEventV1 extends { descriptor: infer D } ? D : never,
  };
}

describe('paneInspection frontend API client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('inspectPane', () => {
    it('builds a flat query with exactly the locator given, and JSON-encodes executionRef', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: 1 }));
      await inspectPane(BASE, {
        locator: { nodeId: 'node-1' },
        executionRef: { kind: 'chat_turn', nodeId: 'node-1', turnId: 'turn-1' },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(`${BASE}/panes/inspect`);
      expect(parsed.searchParams.get('nodeId')).toBe('node-1');
      expect(parsed.searchParams.has('paneId')).toBe(false);
      expect(parsed.searchParams.has('runId')).toBe(false);
      expect(JSON.parse(parsed.searchParams.get('executionRef')!)).toEqual({
        kind: 'chat_turn', nodeId: 'node-1', turnId: 'turn-1',
      });
      expect(init).toMatchObject({ signal: undefined });
    });

    it('throws before any fetch when two locators are given', async () => {
      await expect(
        inspectPane(BASE, { locator: { nodeId: 'a', paneId: 'b' } as never }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps NAVIGATION_DISABLED (403) to a typed error with that code', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { code: 'NAVIGATION_DISABLED', message: 'inspect: navigation is disabled' }));
      await expect(inspectPane(BASE, { locator: { nodeId: 'n' } })).rejects.toMatchObject({
        code: 'NAVIGATION_DISABLED',
        status: 403,
        message: 'inspect: navigation is disabled',
      });
    });

    it('surfaces a 500 with { code: INTERNAL } as INTERNAL without leaking body fragments', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { code: 'INTERNAL', message: 'stack trace or SQL leaked here' }));
      const error = await inspectPane(BASE, { locator: { nodeId: 'n' } }).catch((e) => e);
      expect(error).toBeInstanceOf(PaneInspectionClientError);
      expect(error.code).toBe('INTERNAL');
      expect(error.status).toBe(500);
      expect(error.message).not.toContain('stack trace or SQL leaked here');
    });

    it('produces a typed error rather than crashing on an empty error body', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      const error = await inspectPane(BASE, { locator: { nodeId: 'n' } }).catch((e) => e);
      expect(error).toBeInstanceOf(PaneInspectionClientError);
      expect(error.code).toBe('INTERNAL');
      expect(error.status).toBe(503);
    });

    it('rejects and issues no retry when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      fetchMock.mockImplementationOnce(() => {
        const err = new DOMException('Aborted', 'AbortError');
        return Promise.reject(err);
      });
      await expect(inspectPane(BASE, { locator: { nodeId: 'n' } }, controller.signal)).rejects.toBeInstanceOf(PaneInspectionClientError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('readPaneOutput', () => {
    it('sends selection and passes limitBytes through unclamped', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        outputId: 'o1', execution: null, kind: 'answer', text: 'hi',
        outputRevision: 'r1', updatedAt: null, partial: false, truncated: false,
      }));
      await readPaneOutput(BASE, { locator: { runId: 'run-1' }, selection: 'latest', limitBytes: 999_999 });

      const [url] = fetchMock.mock.calls[0] as [string];
      const parsed = new URL(url);
      expect(parsed.pathname.endsWith('/panes/output')).toBe(true);
      expect(parsed.searchParams.get('selection')).toBe('latest');
      expect(parsed.searchParams.get('limitBytes')).toBe('999999');
      expect(parsed.searchParams.get('runId')).toBe('run-1');
    });

    it('sends pageCursor and outputId when provided, and returns nextPageCursor from the body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        outputId: 'o1', execution: null, kind: 'answer', text: 'chunk',
        outputRevision: 'r2', updatedAt: 123, partial: true, truncated: true,
        nextPageCursor: 'cursor-2',
      }));
      const result = await readPaneOutput(BASE, {
        locator: { nodeId: 'n1' }, selection: 'execution',
        executionRef: { kind: 'agent_run', runId: 'r1' },
        outputId: 'o1', pageCursor: 'cursor-1',
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      const parsed = new URL(url);
      expect(parsed.searchParams.get('outputId')).toBe('o1');
      expect(parsed.searchParams.get('pageCursor')).toBe('cursor-1');
      expect(JSON.parse(parsed.searchParams.get('executionRef')!)).toEqual({ kind: 'agent_run', runId: 'r1' });
      expect(result.nextPageCursor).toBe('cursor-2');
    });

    it('throws before any fetch when two locators are given', async () => {
      await expect(
        readPaneOutput(BASE, { locator: { nodeId: 'a', runId: 'b' } as never, selection: 'latest' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps OUTPUT_CHANGED (409) to a typed error with that code', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { code: 'OUTPUT_CHANGED', message: 'output moved' }));
      await expect(
        readPaneOutput(BASE, { locator: { nodeId: 'n' }, selection: 'latest', pageCursor: 'stale' }),
      ).rejects.toMatchObject({ code: 'OUTPUT_CHANGED', status: 409 });
    });

    it('does not auto-follow nextPageCursor — the caller must loop explicitly', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {
        outputId: 'o1', execution: null, kind: 'answer', text: 'part1',
        outputRevision: 'r1', updatedAt: null, partial: true, truncated: false,
        nextPageCursor: 'cursor-2',
      }));
      await readPaneOutput(BASE, { locator: { nodeId: 'n' }, selection: 'latest' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects and issues no retry when fetch itself rejects (aborted signal)', async () => {
      const controller = new AbortController();
      fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
      controller.abort();
      await expect(
        readPaneOutput(BASE, { locator: { nodeId: 'n' }, selection: 'latest' }, controller.signal),
      ).rejects.toBeInstanceOf(PaneInspectionClientError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('id mapping (re-exported shared codec)', () => {
    it('encodes a bare nodeId target and round-trips through decodePaneId', () => {
      const paneId = encodePaneId({ kind: 'node', nodeId: 'node-abc' });
      expect(paneId).toBe('node:node-abc');
      expect(decodePaneId(paneId)).toEqual({ kind: 'node', nodeId: 'node-abc' });
    });

    it('encodes an agent-run target and round-trips through decodePaneId', () => {
      const paneId = encodePaneId({ kind: 'agent_run', runId: 'run:with:colons' });
      expect(decodePaneId(paneId)).toEqual({ kind: 'agent_run', runId: 'run:with:colons' });
    });

    it('encodes a surface registrationId target and round-trips through decodePaneId', () => {
      const paneId = encodePaneId({ kind: 'surface', registrationId: 'reg-123' });
      expect(paneId).toBe('surface:reg-123');
      expect(decodePaneId(paneId)).toEqual({ kind: 'surface', registrationId: 'reg-123' });
    });
  });

  it('builds the URL from the passed-in gateway base, not a hardcoded API_BASE_URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { version: 1 }));
    const remoteBase = 'http://localhost:3000/api/backend-connections/remote-1/proxy';
    await inspectPane(remoteBase, { locator: { nodeId: 'n' } });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith(`${remoteBase}/panes/inspect?`)).toBe(true);
  });
});

describe('subscribePanes', () => {
  let fetchStreamSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // subscribePanes MUST go through fetchStream (the shared WS-with-HTTP-SSE-fallback gateway),
    // never bare `fetch` — spying on the module export, not stubGlobal('fetch'), is what actually
    // proves that requirement rather than merely proving *some* HTTP call happened.
    fetchStreamSpy = vi.spyOn(streamTransport, 'fetchStream');
  });

  afterEach(() => {
    fetchStreamSpy.mockRestore();
  });

  it('calls fetchStream (not bare fetch) with paneIds and cursors JSON-encoded as query params', async () => {
    fetchStreamSpy.mockResolvedValueOnce(sseResponse([]));
    const onEvent = vi.fn();
    const unsubscribe = subscribePanes(BASE, {
      paneIds: ['node:n1', 'run:r1'],
      cursors: { 'node:n1': 'cursor-a' },
      onEvent,
    });
    await vi.waitFor(() => expect(fetchStreamSpy).toHaveBeenCalledTimes(1));
    unsubscribe();

    const [url, init] = fetchStreamSpy.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${BASE}/panes/subscribe`);
    expect(JSON.parse(parsed.searchParams.get('paneIds')!)).toEqual(['node:n1', 'run:r1']);
    expect(JSON.parse(parsed.searchParams.get('cursors')!)).toEqual({ 'node:n1': 'cursor-a' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws before any network call when paneIds is empty', () => {
    expect(() => subscribePanes(BASE, { paneIds: [], cursors: {}, onEvent: vi.fn() }))
      .toThrow(PaneInspectionClientError);
    expect(fetchStreamSpy).not.toHaveBeenCalled();
  });

  it('throws before any network call when paneIds exceeds the 32-item max', () => {
    const paneIds = Array.from({ length: 33 }, (_, i) => `node:n${i}`);
    let caught: unknown;
    try {
      subscribePanes(BASE, { paneIds, cursors: {}, onEvent: vi.fn() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaneInspectionClientError);
    expect((caught as PaneInspectionClientError).code).toBe('INVALID_ARGUMENT');
    expect(fetchStreamSpy).not.toHaveBeenCalled();
  });

  it('throws before any network call when paneIds contains a duplicate, via the shared parser', () => {
    let caught: unknown;
    try {
      subscribePanes(BASE, { paneIds: ['node:n1', 'node:n1'], cursors: {}, onEvent: vi.fn() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PaneInspectionClientError);
    expect((caught as PaneInspectionClientError).code).toBe('INVALID_ARGUMENT');
    expect(fetchStreamSpy).not.toHaveBeenCalled();
  });

  it('makes zero network calls when the external signal is already aborted, and leaves no listener attached', async () => {
    const controller = new AbortController();
    controller.abort();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const onEvent = vi.fn();
    const onError = vi.fn();
    const unsubscribe = subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent, onError, signal: controller.signal });

    // No microtask queue flush needed: the abort must be observed synchronously, before any
    // fetchStream call is ever scheduled.
    expect(fetchStreamSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    unsubscribe();
    expect(removeSpy).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call onError when a LATER external abort fires, and detaches its own listener', async () => {
    const { response } = openSseResponse();
    fetchStreamSpy.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }) as Promise<Response>;
      void response;
    });
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent: vi.fn(), onError, signal: controller.signal });
    await vi.waitFor(() => expect(fetchStreamSpy).toHaveBeenCalledTimes(1));

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onError).not.toHaveBeenCalled();
    // The abort listener registered on the external signal must be detached once its purpose is
    // over (either by its own `{ once: true }` self-removal or this module's explicit detach) —
    // asserted defensively since a leaked listener would not otherwise be observable.
    expect(removeSpy).toHaveBeenCalled();
  });

  it('parses snapshot/changed/heartbeat SSE frames into typed PaneFeedEventV1 and dispatches each to onEvent', async () => {
    const events: PaneFeedEventV1[] = [
      snapshotEvent('node:n1', 'cursor-1'),
      { version: 1, type: 'heartbeat', paneId: 'node:n1', cursor: 'cursor-1', emittedAt: 2_000 },
      {
        version: 1, type: 'changed', paneId: 'node:n1', cursor: 'cursor-2', emittedAt: 3_000,
        changedSections: ['activity'], descriptor: { version: 1 } as unknown as PaneFeedEventV1 extends { descriptor: infer D } ? D : never,
      },
    ];
    fetchStreamSpy.mockResolvedValueOnce(sseResponse(events.map((e) => ({ event: e.type, data: e }))));
    const onEvent = vi.fn();
    const unsubscribe = subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(3));
    unsubscribe();

    expect(onEvent.mock.calls.map((c) => c[0])).toEqual(events);
  });

  it('treats malformed JSON as a terminal protocol failure: reports once, and never dispatches a later well-formed frame', async () => {
    const good = snapshotEvent('node:n1', 'cursor-2');
    fetchStreamSpy.mockResolvedValueOnce(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {not valid json\n\n'));
          controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(good)}\n\n`));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('treats an invalid PaneFeedEventV1 shape as a terminal protocol failure: reports once, never dispatches later frames', async () => {
    const good = snapshotEvent('node:n1', 'cursor-2');
    fetchStreamSpy.mockResolvedValueOnce(sseResponse([
      { event: 'snapshot', data: { version: 1, type: 'snapshot', paneId: 'node:n1' /* missing cursor/emittedAt/descriptor */ } },
      { event: 'snapshot', data: good },
    ]));
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects a frame whose paneId was not in the requested set as a terminal protocol failure', async () => {
    const foreign = snapshotEvent('node:other', 'cursor-1');
    const own = snapshotEvent('node:n1', 'cursor-2');
    fetchStreamSpy.mockResolvedValueOnce(sseResponse([
      { event: 'snapshot', data: foreign },
      { event: 'snapshot', data: own },
    ]));
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent, onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as PaneInspectionClientError).code).toBe('INTERNAL');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('accepts a frame for any paneId in a deduplicated multi-pane subscription', async () => {
    const events = [snapshotEvent('node:n1', 'c1'), snapshotEvent('run:r1', 'c2')];
    fetchStreamSpy.mockResolvedValueOnce(sseResponse(events.map((e) => ({ event: e.type, data: e }))));
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1', 'run:r1'], cursors: {}, onEvent, onError });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));

    expect(onError).not.toHaveBeenCalled();
  });

  it('unsubscribe aborts the underlying fetchStream signal and stops further dispatch', async () => {
    const { response, controller } = openSseResponse();
    fetchStreamSpy.mockResolvedValueOnce(response);
    const onEvent = vi.fn();
    const unsubscribe = subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent });
    await vi.waitFor(() => expect(fetchStreamSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchStreamSpy.mock.calls[0] as [string, RequestInit];
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    unsubscribe();
    expect(signal.aborted).toBe(true);

    // Frames written after unsubscribe must never reach onEvent.
    controller.enqueue(new TextEncoder().encode(
      `event: heartbeat\ndata: ${JSON.stringify(snapshotEvent('node:n1', 'cursor-late'))}\n\n`,
    ));
    controller.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('supports an external AbortSignal in addition to the returned unsubscribe function', async () => {
    fetchStreamSpy.mockResolvedValueOnce(sseResponse([]));
    const controller = new AbortController();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent: vi.fn(), signal: controller.signal });
    await vi.waitFor(() => expect(fetchStreamSpy).toHaveBeenCalledTimes(1));
    const [, init] = fetchStreamSpy.mock.calls[0] as [string, RequestInit];
    controller.abort();
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });

  it('calls onError with a typed PaneInspectionClientError on a non-2xx response, without retrying', async () => {
    fetchStreamSpy.mockResolvedValueOnce(jsonResponse(429, { code: 'RATE_LIMITED', message: 'too many subscribers' }));
    const onError = vi.fn();
    const unsubscribe = subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    unsubscribe();

    expect(fetchStreamSpy).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0][0] as PaneInspectionClientError;
    expect(error).toBeInstanceOf(PaneInspectionClientError);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.status).toBe(429);
  });

  it('calls onError with a typed INTERNAL error when fetchStream itself rejects (network failure)', async () => {
    fetchStreamSpy.mockRejectedValueOnce(new Error('socket hang up'));
    const onError = vi.fn();
    subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    const error = onError.mock.calls[0][0] as PaneInspectionClientError;
    expect(error).toBeInstanceOf(PaneInspectionClientError);
    expect(error.code).toBe('INTERNAL');
  });

  it('does not call onError when the stream is aborted intentionally via unsubscribe', async () => {
    const { response } = openSseResponse();
    fetchStreamSpy.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }) as Promise<Response>;
      void response;
    });
    const onError = vi.fn();
    const unsubscribe = subscribePanes(BASE, { paneIds: ['node:n1'], cursors: {}, onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(fetchStreamSpy).toHaveBeenCalledTimes(1));
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range cursors map entry the same way the shared parser would (defensive, client-side)', () => {
    let caught: unknown;
    try {
      subscribePanes(BASE, { paneIds: ['node:n1'], cursors: { 'node:n2': 'x' }, onEvent: vi.fn() });
    } catch (err) {
      caught = err;
    }
    // A cursor keyed to a paneId that is not in paneIds is not itself invalid per the shared
    // parser (parseSubscribePanesRequestV1 accepts any cursors map), so this must NOT throw —
    // documents that the client does not over-validate beyond what the server actually rejects.
    expect(caught).toBeUndefined();
  });
});
