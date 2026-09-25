import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent, type ChatStreamEvent } from 'michi-shared';
import { cancelChatAndObserve, settleCancellationObservation, streamMessage } from './api';
import type { CancelRecoveryStatus } from './chatStreamEvents';

const TURN = 'original-turn';
const OWNER = 'original-owner';
const cleanups: Array<() => void> = [];
let nodeId: string;
let nextNode = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Ignore fetch abort deliberately: queued bytes can still reach reader.read(). */
function sse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const cancelled = vi.fn(() => { closed = true; });
  const close = () => {
    if (closed) return;
    closed = true;
    controller.close();
  };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel: cancelled,
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  cleanups.push(close);
  return {
    response, cancelled, close,
    emit(...events: ChatStreamEvent[]) {
      expect(closed, 'test must deliver late bytes before the reader detaches').toBe(false);
      controller.enqueue(new TextEncoder().encode(events.map(encodeChatStreamEvent).join('')));
    },
  };
}

function chunk(text = 'late output', turnId = TURN): ChatStreamEvent {
  return { event: CHAT_STREAM_EVENTS.chunk, data: { turnId, seq: 2, text } };
}

function permission(turnId = TURN): ChatStreamEvent {
  return { event: CHAT_STREAM_EVENTS.permissionRequest, data: { turnId, requestId: 1, title: 'Run command?', options: [] } };
}

function done(turnId = TURN): ChatStreamEvent {
  return { event: CHAT_STREAM_EVENTS.done, data: { turnId, stopReason: 'cancelled', persisted: true } };
}

function failure(message = 'Native recovery failed', turnId = TURN): ChatStreamEvent {
  return { event: CHAT_STREAM_EVENTS.error, data: { turnId, message } };
}

function handlers() {
  return {
    onEnvelope: vi.fn(), onChunk: vi.fn(), onThought: vi.fn(),
    onPermissionRequest: vi.fn(), onUserInputRequest: vi.fn(),
    onDone: vi.fn(), onError: vi.fn(), onAborted: vi.fn(),
    onCancelRecovery: vi.fn<(status: CancelRecoveryStatus) => void>(),
  };
}

function observe(onStatus = vi.fn<(status: CancelRecoveryStatus) => void>(), turnId: string | undefined = TURN) {
  const stop = cancelChatAndObserve(nodeId, OWNER, turnId, onStatus);
  cleanups.push(stop);
  return { onStatus, stop };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

function expectCursor(url: unknown, turnId = TURN) {
  const target = new URL(String(url), 'http://localhost');
  expect(target.pathname).toMatch(new RegExp(`/chats/${nodeId}/stream$`));
  expect(target.searchParams.get('fromTurnId')).toBe(turnId);
  expect(target.searchParams.get('fromSeq')).toBe('0');
}

beforeEach(() => {
  vi.useFakeTimers();
  nodeId = `cancel-recovery-${++nextNode}`;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await flush();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('streamMessage cancellation recovery', () => {
  it('aborts output synchronously and only once without waiting for the cancel request', async () => {
    const output = sse();
    const replay = sse();
    const request = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(output.response)
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(replay.response);
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();
    const cancel = streamMessage(nodeId, 'hello', h, OWNER, { turnId: TURN });
    await flush();
    output.emit(chunk('before cancel'));
    await flush();
    expect(h.onChunk).toHaveBeenCalledTimes(1);

    cancel();
    cancel();
    expect(h.onAborted).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/cancel$/);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ ownerToken: OWNER, turnId: TURN });
    expect(h.onCancelRecovery).not.toHaveBeenCalled();

    // No abort listener in the mock: these frames genuinely reach the reader.
    expect(output.cancelled).not.toHaveBeenCalled();
    h.onEnvelope.mockClear();
    output.emit(chunk(), permission(), failure('stale output error'), done());
    await flush();
    expect(output.cancelled).toHaveBeenCalledTimes(1);
    expect(h.onEnvelope).not.toHaveBeenCalled();
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    expect(h.onPermissionRequest).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();

    request.resolve(new Response('{}'));
    await flush();
    expectCursor(fetchMock.mock.calls[2][0]);
    expect(h.onCancelRecovery).not.toHaveBeenCalled();
    replay.emit(done());
    await flush();
    expect(h.onCancelRecovery.mock.calls).toEqual([[{ state: 'settled' }]]);
  });

  it('pins the monitor to the original turn and delivers only its actual failure once', async () => {
    const output = sse();
    const replay = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(output.response)
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(replay.response);
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();
    const cancel = streamMessage(nodeId, 'hello', h, OWNER, { turnId: TURN });
    await flush();
    cancel();
    await flush();
    expectCursor(fetchMock.mock.calls[2][0]);

    replay.emit(
      { event: CHAT_STREAM_EVENTS.turnStart, data: { turnId: 'foreign-turn', assistantId: 'foreign-assistant', nodeId, userText: 'other' } },
      chunk(), permission(), chunk('foreign output', 'foreign-turn'), permission('foreign-turn'),
      { event: CHAT_STREAM_EVENTS.userInputRequest, data: { turnId: TURN, requestId: 2, questions: [] } },
      done('foreign-turn'), failure('foreign failure', 'foreign-turn'),
    );
    await flush();
    expect(h.onCancelRecovery).not.toHaveBeenCalled();
    expect(h.onEnvelope).not.toHaveBeenCalled();
    expect(h.onChunk).not.toHaveBeenCalled();
    expect(h.onPermissionRequest).not.toHaveBeenCalled();
    expect(h.onUserInputRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.onCancelRecovery.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })]]);
    replay.emit(failure(), failure(), done());
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onCancelRecovery.mock.calls).toEqual([
      [expect.objectContaining({ state: 'pending' })],
      [{ state: 'error', detail: 'Native recovery failed' }],
    ]);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onAborted).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1]?.signal?.aborted).toBe(true);
  });

  it('drops the remaining frames when cancelled from a callback within one buffered read', async () => {
    const output = sse();
    const replay = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(output.response)
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(replay.response);
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();
    const cancel = streamMessage(nodeId, 'hello', h, OWNER, { turnId: TURN });
    h.onChunk.mockImplementation(() => cancel());
    await flush();
    output.emit(chunk('first'), chunk('must be dropped'), permission(), failure(), done());
    await flush();
    expect(h.onChunk).toHaveBeenCalledTimes(1);
    expect(h.onEnvelope).toHaveBeenCalledTimes(1);
    expect(h.onPermissionRequest).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onCancelRecovery).not.toHaveBeenCalled();
    replay.emit(done());
    await flush();
    expect(h.onCancelRecovery).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
  });

  it('cancels foreground replay immediately and uses a separate status-only observer', async () => {
    const output = sse();
    const foregroundReplay = sse();
    const monitor = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(output.response)
      .mockResolvedValueOnce(foregroundReplay.response)
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(monitor.response);
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();
    const cancel = streamMessage(nodeId, 'hello', h, OWNER, { turnId: TURN });
    output.close();
    await flush();
    expectCursor(fetchMock.mock.calls[1][0]);
    foregroundReplay.emit(chunk('before stop'));
    await flush();
    cancel();
    expect(h.onAborted).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await flush();
    expectCursor(fetchMock.mock.calls[3][0]);
    foregroundReplay.emit(chunk(), permission(), failure(), done());
    monitor.emit(failure('cleanup transport failed'), done());
    await flush();
    expect(h.onChunk).toHaveBeenCalledExactlyOnceWith('before stop', 2, undefined, TURN);
    expect(h.onPermissionRequest).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onCancelRecovery).toHaveBeenCalledExactlyOnceWith({ state: 'error', detail: 'cleanup transport failed' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['initial response', 'foreground replay'] as const)('a rejected foreign envelope on %s cannot retarget cancellation', async (source) => {
    const output = sse();
    const replay = sse();
    const monitor = sse();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(output.response);
    if (source === 'foreground replay') fetchMock.mockResolvedValueOnce(replay.response);
    fetchMock.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(monitor.response);
    vi.stubGlobal('fetch', fetchMock);
    const h = handlers();
    h.onEnvelope.mockImplementation((envelope) => envelope.turnId === TURN);
    const cancel = streamMessage(nodeId, 'hello', h, OWNER, { turnId: TURN });
    if (source === 'foreground replay') output.close();
    await flush();
    const active = source === 'foreground replay' ? replay : output;
    active.emit(chunk('foreign output', 'foreign-turn'));
    await flush();
    expect(h.onChunk).not.toHaveBeenCalled();
    cancel();
    await flush();
    const cancelIndex = source === 'foreground replay' ? 2 : 1;
    expect(JSON.parse(String(fetchMock.mock.calls[cancelIndex][1]?.body))).toEqual({ ownerToken: OWNER, turnId: TURN });
    expectCursor(fetchMock.mock.calls[cancelIndex + 1][0]);
    monitor.emit(done());
    await flush();
    expect(h.onCancelRecovery).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
  });

  it('starting the next stream detaches observation without changing either turn identity', async () => {
    const oldReplay = sse();
    const nextOutput = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(oldReplay.response)
      .mockResolvedValueOnce(nextOutput.response);
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    const h = handlers();
    streamMessage(nodeId, 'next prompt', h, OWNER, { turnId: 'next-turn' });
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await flush();
    oldReplay.emit(failure(), done());
    nextOutput.emit(chunk('new answer', 'next-turn'), done('next-turn'));
    nextOutput.close();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(h.onChunk).toHaveBeenCalledExactlyOnceWith('new answer', 2, undefined, 'next-turn');
    expect(h.onDone).toHaveBeenCalledExactlyOnceWith('cancelled', undefined, 'next-turn', true, undefined);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onAborted).not.toHaveBeenCalled();
    expect(h.onCancelRecovery).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).turnId).toBe('next-turn');
    expect(fetchMock.mock.calls[2][1]?.signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('cancelChatAndObserve deadlines and ownership', () => {
  it.each([
    { label: 'undefined ID, immediate ACK', turnId: undefined, ackDelay: 0 },
    { label: 'empty ID, delayed ACK', turnId: '', ackDelay: 1_000 },
  ])('cannot confirm cancellation without a known turn ID: $label', async ({ turnId, ackDelay }) => {
    const request = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(request.promise);
    vi.stubGlobal('fetch', fetchMock);
    const onStatus = vi.fn<(status: CancelRecoveryStatus) => void>();
    // Call directly: observe() supplies a default ID when passed undefined.
    cleanups.push(cancelChatAndObserve(nodeId, OWNER, turnId, onStatus));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ ownerToken: OWNER });
    settleCancellationObservation(nodeId, TURN, { state: 'settled' });
    settleCancellationObservation(nodeId, '', { state: 'settled' });
    expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ackDelay);
    const beforeAck = ackDelay ? [[expect.objectContaining({ state: 'pending' })]] : [];
    expect(onStatus.mock.calls).toEqual(beforeAck);

    request.resolve(new Response('{}'));
    await flush();
    expect(onStatus.mock.calls).toEqual([
      ...beforeAck,
      [{ state: 'error', detail: expect.stringContaining('original turn could not be identified') }],
    ]);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    settleCancellationObservation(nodeId, TURN, { state: 'settled' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledTimes(beforeAck.length + 1);
    expect(onStatus.mock.calls.some(([status]) => status.state === 'settled')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps 410 replay unconfirmed and retries only until the original 30-second deadline', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockReturnValueOnce(response.promise)
      .mockImplementation(async () => new Response(null, { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })]]);
    response.resolve(new Response(null, { status: 410 }));
    await flush();
    expect(onStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(28_749);
    expect(onStatus).toHaveBeenCalledTimes(1);
    for (const [url] of fetchMock.mock.calls.slice(1)) expectCursor(url);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus.mock.calls).toEqual([
      [expect.objectContaining({ state: 'pending' })],
      [{ state: 'error', detail: expect.stringContaining('could not be confirmed') }],
    ]);
    const attempts = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { state: 'settled' as const },
    { state: 'error' as const, detail: 'Shared feed cleanup failed' },
  ])('shared-feed $state settles only the matching turn while replay remains 410', async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockImplementation(async () => new Response(null, { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStatus.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })]]);

    settleCancellationObservation(nodeId, 'foreign-turn', status);
    settleCancellationObservation(`${nodeId}-other`, TURN, status);
    expect(onStatus).toHaveBeenCalledTimes(1);
    const attemptsBeforeMismatch = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(attemptsBeforeMismatch);
    expect(onStatus).toHaveBeenCalledTimes(1);

    settleCancellationObservation(nodeId, TURN, status);
    expect(onStatus.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })], [status]]);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    settleCancellationObservation(nodeId, TURN, { state: 'error', detail: 'duplicate terminal' });
    const attempts = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/cancel$/);
    // Settlement reuses the shared feed; the monitor opens only pinned replay requests.
    for (const [url] of fetchMock.mock.calls.slice(1)) expectCursor(url);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shared-feed settlement of an old turn cannot finish the one replacement monitor', async () => {
    const firstReplay = sse();
    const secondReplay = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(firstReplay.response)
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(secondReplay.response);
    vi.stubGlobal('fetch', fetchMock);
    const first = observe();
    await flush();
    const second = observe(undefined, 'replacement-turn');
    await flush();
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls[3][1]?.signal?.aborted).toBe(false);
    first.stop();
    settleCancellationObservation(nodeId, TURN, { state: 'error', detail: 'old cleanup failed' });
    expect(first.onStatus).not.toHaveBeenCalled();
    expect(second.onStatus).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[3][1]?.signal?.aborted).toBe(false);

    settleCancellationObservation(nodeId, 'replacement-turn', { state: 'settled' });
    expect(fetchMock.mock.calls[3][1]?.signal?.aborted).toBe(true);
    firstReplay.emit(failure(), done());
    secondReplay.emit(failure('late replacement error', 'replacement-turn'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.onStatus).not.toHaveBeenCalled();
    expect(second.onStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectCursor(fetchMock.mock.calls[1][0]);
    expectCursor(fetchMock.mock.calls[3][0], 'replacement-turn');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a finished subscription cannot remove a new observer registered by its terminal callback', async () => {
    const firstReplay = sse();
    const secondReplay = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(firstReplay.response)
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(secondReplay.response);
    vi.stubGlobal('fetch', fetchMock);
    let second: ReturnType<typeof observe> | undefined;
    const firstStatus = vi.fn<(status: CancelRecoveryStatus) => void>((status) => {
      if (status.state === 'settled') second = observe(undefined, 'replacement-turn');
    });
    const first = observe(firstStatus);
    await flush();
    firstReplay.emit(done(), failure('old buffered error'));
    await flush();
    expect(firstStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    expect(firstReplay.cancelled).toHaveBeenCalledTimes(1);
    expect(second).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expectCursor(fetchMock.mock.calls[3][0], 'replacement-turn');
    first.stop();
    settleCancellationObservation(nodeId, TURN, { state: 'error', detail: 'old late settlement' });
    expect(second!.onStatus).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[3][1]?.signal?.aborted).toBe(false);

    // This must still find the replacement after the old reader's finally runs.
    settleCancellationObservation(nodeId, 'replacement-turn', { state: 'settled' });
    expect(second!.onStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    expect(fetchMock.mock.calls[3][1]?.signal?.aborted).toBe(true);
    secondReplay.emit(failure('late replacement error', 'replacement-turn'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(firstStatus).toHaveBeenCalledTimes(1);
    expect(second!.onStatus).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shared-feed terminal proof settles even while the cancel request is stuck', async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(request.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await vi.advanceTimersByTimeAsync(999);
    settleCancellationObservation(nodeId, TURN, { state: 'settled' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    request.reject(new Error('late cancel rejection'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { event: done(), status: { state: 'settled' } },
    { event: failure(), status: { state: 'error', detail: 'Native recovery failed' } },
  ])('a 410 retry can finish when actual $event.event arrives', async ({ event, status }) => {
    const replay = sse();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(replay.response);
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await flush();
    expect(onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectCursor(fetchMock.mock.calls[2][0]);
    replay.emit(event);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(status);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires at 30 seconds even if the cancel request never acknowledges abort', async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(request.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onStatus.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })]]);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'error', detail: expect.stringContaining('could not be confirmed') });
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    request.resolve(new Response('{}'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes cancel latency, retry delay, and a stuck replay fetch in the same deadline', async () => {
    const cancelRequest = deferred<Response>();
    const retryRequest = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>()
      .mockReturnValueOnce(cancelRequest.promise)
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockReturnValueOnce(retryRequest.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await vi.advanceTimersByTimeAsync(12_000);
    cancelRequest.resolve(new Response('{}'));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectCursor(fetchMock.mock.calls[1][0]);
    expectCursor(fetchMock.mock.calls[2][0]);
    await vi.advanceTimersByTimeAsync(17_749);
    expect(onStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    expect(fetchMock.mock.calls[2][1]?.signal?.aborted).toBe(true);
    retryRequest.reject(new Error('late transport failure'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['EOF', '503', 'network error'] as const)('bounds repeated %s replay retries without resetting the deadline or cursor', async (mode) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}'));
    fetchMock.mockImplementation(async () => {
      if (mode === '503') return new Response(null, { status: 503 });
      if (mode === 'network error') throw new Error('offline');
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onStatus } = observe();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(onStatus.mock.calls).toEqual([[expect.objectContaining({ state: 'pending' })]]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(5);
    for (const [url] of fetchMock.mock.calls.slice(1)) expectCursor(url);
    await vi.advanceTimersByTimeAsync(1);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    const attempts = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([403, 409, 500])('surfaces refused cancel HTTP %i without subscribing or flashing pending', async (status) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status })));
    const { onStatus } = observe();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ state: 'error', detail: `Cancel request failed: ${status}` });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { stopReason: 'error', persisted: true },
    { stopReason: 'cancelled', persisted: false },
  ])('treats unsuccessful terminal confirmation as error: %j', async (terminal) => {
    const replay = sse();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(replay.response));
    const { onStatus } = observe();
    await flush();
    replay.emit({ event: CHAT_STREAM_EVENTS.done, data: { turnId: TURN, ...terminal } }, failure());
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ state: 'error', detail: expect.stringContaining('cleanup failed') });
  });
});
