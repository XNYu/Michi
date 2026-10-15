import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import { streamMessage, subscribeBackground } from './api';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('background SSE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens one fixed background endpoint and routes tagged self-turn frames by chatId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.turnStart,
        data: { chatId: 'chat-self', turnId: 'self-turn', assistantId: 'self-a', nodeId: 'node-self', userText: '', selfInitiated: true },
      }),
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.done,
        data: { chatId: 'chat-self', turnId: 'self-turn', assistantId: 'self-a', persisted: true },
      }),
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const start = vi.fn();
    const done = vi.fn();
    subscribeBackground(() => ({ onTurnStart: start, onDone: done }), {
      cursors: { 'chat-self': { turnId: 'previous-turn', seq: 7 } },
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/chats\/background\/subscribe$/), expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      cursors: { 'chat-self': { turnId: 'previous-turn', seq: 7 } },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ selfInitiated: true }));
  });

  it('surfaces a replay gap control frame before normal background events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: background_sync_required\ndata: ${JSON.stringify({
        chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
      })}\n\n`,
    ])));
    const onReplayGap = vi.fn();

    subscribeBackground(() => ({}), { onReplayGap });
    await vi.waitFor(() => expect(onReplayGap).toHaveBeenCalledTimes(1));
    expect(onReplayGap).toHaveBeenCalledWith({
      chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
    }, expect.any(AbortSignal));
  });

  it('treats replay-gap reconciliation as a delivery barrier', async () => {
    let releaseGap!: () => void;
    const gapBarrier = new Promise<void>((resolve) => { releaseGap = resolve; });
    const gapFrame = `event: background_sync_required\ndata: ${JSON.stringify({
        chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
      })}\n\n`;
    const liveFrame = encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.chunk,
        data: {
          chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-live', seq: 1,
          assistantId: 'assistant-live', text: 'must wait for reconciliation',
        },
      });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([gapFrame + liveFrame])));
    const chunk = vi.fn();
    const onReplayGap = vi.fn(() => gapBarrier);

    subscribeBackground(() => ({ onChunk: chunk }), {
      onReplayGap,
    });
    await vi.waitFor(() => expect(onReplayGap).toHaveBeenCalledTimes(1));
    expect(chunk).not.toHaveBeenCalled();

    releaseGap();
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
  });

  it('disconnects and leaves later frames unapplied when gap reconciliation fails', async () => {
    const gapFrame = `event: background_sync_required\ndata: ${JSON.stringify({
      chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-durable', seq: 12,
    })}\n\n`;
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: {
        chatId: 'chat-gap', nodeId: 'node-gap', turnId: 'turn-live', seq: 13,
        assistantId: 'assistant-live', text: 'must not pass a failed barrier',
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([gapFrame + liveFrame])));
    const chunk = vi.fn();
    const onDisconnect = vi.fn();

    subscribeBackground(() => ({ onChunk: chunk }), {
      onReplayGap: async () => { throw new Error('snapshot failed'); },
      onDisconnect,
    });

    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
    expect(chunk).not.toHaveBeenCalled();
  });

  it('resumes a disconnected direct turn from its last accepted seq without using background SSE', async () => {
    const first = sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.turnStart,
        data: { turnId: 'turn-1', seq: 0, assistantId: 'a-1', nodeId: 'n-1', userText: 'hello' },
      }),
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.chunk, data: { turnId: 'turn-1', seq: 1, assistantId: 'a-1', text: 'partial' } }),
    ]);
    const replay = sseResponse([
      encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { turnId: 'turn-1', seq: 2, assistantId: 'a-1', persisted: true } }),
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replay);
    vi.stubGlobal('fetch', fetchMock);
    const chunks = vi.fn();
    const done = vi.fn();
    streamMessage('n-1', 'hello', { onChunk: chunks, onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(chunks).toHaveBeenCalledWith('partial', 1, 'a-1', 'turn-1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/chats/n-1/stream?');
    expect(String(fetchMock.mock.calls[1][0])).toContain('fromTurnId=turn-1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('fromSeq=2');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('/background/');
  });

  it('shows the exact restart reason when a foreground replay is no longer available', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'interrupted', seq: 0, assistantId: 'a-interrupted', nodeId: 'node', userText: 'hello' } }),
      ]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Michi restarted while this task was running. Check the conversation before retrying.',
        code: 'backend_restarted',
      }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.fn(), done = vi.fn();
    streamMessage('node', 'hello', { onError: error, onDone: done });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(
      'Michi restarted while this task was running. Check the conversation before retrying.',
      undefined, undefined, 'backend_restarted',
    );
    expect(done).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replays the client-stamped turn when POST disconnects before its first SSE envelope', async () => {
    const replay = sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.turnStart,
        data: { turnId: 'client-turn', seq: 0, assistantId: 'a-client', nodeId: 'n-client', userText: 'hello' },
      }),
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.done,
        data: { turnId: 'client-turn', seq: 1, assistantId: 'a-client', persisted: true },
      }),
    ]);
    // The request reached the backend and it began the turn, but the response
    // closes before delivering an envelope. The replay cursor must come from
    // the POST body rather than a server frame.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([]))
      .mockResolvedValueOnce(replay);
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();

    streamMessage('n-client', 'hello', { onDone: done }, {
      turnId: 'client-turn',
    });

    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      turnId: 'client-turn',
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('fromTurnId=client-turn');
    expect(String(fetchMock.mock.calls[1][0])).toContain('fromSeq=0');
  });

  it('can resume the same foreground turn more than once with a moving seq cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'turn-many', seq: 0, assistantId: 'a-many', nodeId: 'n-many', userText: 'hello' },
        }),
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.chunk,
          data: { turnId: 'turn-many', seq: 1, assistantId: 'a-many', text: 'one' },
        }),
      ]))
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.chunk,
          data: { turnId: 'turn-many', seq: 2, assistantId: 'a-many', text: 'two' },
        }),
      ]))
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.done,
          data: { turnId: 'turn-many', seq: 3, assistantId: 'a-many', persisted: true },
        }),
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const done = vi.fn();

    streamMessage('n-many', 'hello', { onDone: done });
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(String(fetchMock.mock.calls[1][0])).toContain('fromSeq=2');
    expect(String(fetchMock.mock.calls[2][0])).toContain('fromSeq=3');
  });

  it('finalizes as aborted when Stop is pressed during a pending replay request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({
          event: CHAT_STREAM_EVENTS.turnStart,
          data: { turnId: 'turn-stop', seq: 0, assistantId: 'a-stop', nodeId: 'n-stop', userText: 'hello' },
        }),
      ]))
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAborted = vi.fn();

    const cancel = streamMessage('n-stop', 'hello', { onAborted });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    cancel();

    expect(onAborted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2][0])).toContain('/chats/n-stop/cancel');
  });
});

describe('foreground stream startup failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces POST 409 without replaying a turn that never started', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    streamMessage('n-conflict', 'retry', { onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith('stream failed: 409');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chats/n-conflict/message');
  });
});

describe('foreground send while the previous turn finishes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const busy = () => new Response(JSON.stringify({ code: 'turn_active', error: 'Still busy' }), { status: 409 });

  it('waits through repeated busy responses and sends the same payload once the runtime is ready', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(sseResponse([
        encodeChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: { persisted: true } }),
      ]));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn(), onDone = vi.fn(), onRetryStart = vi.fn(), onRetryEnd = vi.fn();
    streamMessage('n-busy', 'wire text', { onError, onDone, onRetryStart, onRetryEnd }, {
      turnId: 'waiting-turn', displayText: 'visible text',
      userMetadata: { quotedText: 'quote', attachments: [{ name: 'file', absPath: '/tmp/file' }] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRetryStart).toHaveBeenCalledExactlyOnceWith({ detail: 'Waiting for previous response to finish' });
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onRetryEnd).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    const payloads = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(new Set(payloads).size).toBe(1);
    expect(JSON.parse(String(payloads[0]))).toMatchObject({ turnId: 'waiting-turn', text: 'wire text', displayText: 'visible text' });
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/message'))).toBe(true);
  });

  it('withdraws the waiting send without cancelling the previous turn or leaving a retry timer', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => busy());
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn(), onAborted = vi.fn(), onCancelRecovery = vi.fn();
    const cancel = streamMessage('n-busy', 'next', { onError, onAborted, onCancelRecovery });
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onAborted).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onCancelRecovery).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still surfaces a real startup failure after waiting, without resending or replaying it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(new Response(JSON.stringify({
      code: 'IDENTITY_MISMATCH', error: 'Identity changed',
    }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    streamMessage('n-busy', 'next', { onError });
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledExactlyOnceWith('Identity changed', undefined, undefined, 'IDENTITY_MISMATCH');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
