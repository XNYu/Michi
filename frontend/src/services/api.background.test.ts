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

  it('delivers scheduled run control frames without blocking chat events', async () => {
    const event = {
      phase: 'started', runId: 'run-1', jobId: 'job-1', jobName: 'Digest', workspaceId: 'ws-1',
      nodeId: 'n-1', treeId: 't-1', status: 'running', summary: null, error: null, notify: true, at: 1,
    };
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: { chatId: 'chat-x', nodeId: 'node-x', turnId: 'turn-x', seq: 1, assistantId: 'a-x', text: 'after' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: scheduled_job_run\ndata: ${JSON.stringify(event)}\n\n`,
      'event: scheduled_job_run\ndata: {"phase":"bogus"}\n\n',
      liveFrame,
    ])));
    const onScheduledJobRun = vi.fn();
    const chunk = vi.fn();
    subscribeBackground(() => ({ onChunk: chunk }), { onScheduledJobRun });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
    expect(onScheduledJobRun).toHaveBeenCalledTimes(1);
    expect(onScheduledJobRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', nodeId: 'n-1', phase: 'started' }));
  });

  it('delivers job change frames separately from run frames and chat events', async () => {
    const change = { change: 'created', jobId: 'job-1', workspaceId: 'ws-1', at: 1 };
    const liveFrame = encodeChatStreamEvent({
      event: CHAT_STREAM_EVENTS.chunk,
      data: { chatId: 'chat-x', nodeId: 'node-x', turnId: 'turn-x', seq: 1, assistantId: 'a-x', text: 'after' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      `event: scheduled_jobs_changed\ndata: ${JSON.stringify(change)}\n\n`,
      'event: scheduled_jobs_changed\ndata: {"change":"renamed"}\n\n',
      'event: scheduled_jobs_changed\ndata: not json\n\n',
      liveFrame,
    ])));
    const onScheduledJobsChanged = vi.fn();
    const onScheduledJobRun = vi.fn();
    const chunk = vi.fn();
    subscribeBackground(() => ({ onChunk: chunk }), { onScheduledJobsChanged, onScheduledJobRun });
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledTimes(1));
    expect(onScheduledJobsChanged).toHaveBeenCalledTimes(1);
    expect(onScheduledJobsChanged).toHaveBeenCalledWith(change);
    expect(onScheduledJobRun).not.toHaveBeenCalled();
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

  it('silently waits through repeated busy responses and sends the same payload once the runtime is ready', async () => {
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
    expect(onRetryStart).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onRetryEnd).not.toHaveBeenCalled();
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
