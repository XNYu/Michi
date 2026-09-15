import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent } from '../services/chatStreamEvents';
import type { ChatStreamEvent } from '../services/chatStreamEvents';
import { createBackgroundTurnBinding } from './observeChatStream';
import type { ChatAction } from './chatTypes';
import { cancelChatAndObserve, settleCancellationObservation } from '../services/api/stream';
import { fetchStream } from '../services/api/streamTransport';

vi.mock('../services/api/streamTransport', () => ({ fetchStream: vi.fn() }));
vi.mock('../config/backendConnections', () => ({
  backendApiBase: () => 'http://localhost:3000/api',
  nodeBackendApiBase: () => 'http://localhost:3000/api',
}));

function envelope(seq: number) {
  return {
    chatId: 'chat-1',
    nodeId: 'node-1',
    turnId: 'self-turn-1',
    assistantId: 'self-a-1',
    seq,
  };
}

describe('createBackgroundTurnBinding', () => {
  it('runs the shared structural side-effect adapter exactly once per seq', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onSpawnBranches = vi.fn();
    const onArtifactSaved = vi.fn();
    const onArtifactUpdated = vi.fn();
    const lastTurnRef = { current: '' };
    const lastSeqRef = { current: -1 };
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef,
      lastSeqRef,
      extraHandlers: { onSpawnBranches, onArtifactSaved, onArtifactUpdated },
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    const spawn: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.spawnBranches,
      data: {
        ...envelope(1),
        topics: [{ chatId: 'child-chat', nodeId: 'child-node', title: 'Child', prompt: 'go' }],
      },
    };
    dispatchChatStreamEvent(spawn, handlers);
    dispatchChatStreamEvent(spawn, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.artifactSaved,
      data: { ...envelope(2), name: 'notes', filePath: '/tmp/notes.md', size: 12 },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.artifactUpdated,
      data: { ...envelope(3), name: 'notes', filePath: '/tmp/notes.md', size: 18 },
    }, handlers);

    expect(onSpawnBranches).toHaveBeenCalledTimes(1);
    expect(onArtifactSaved).toHaveBeenCalledWith('notes', '/tmp/notes.md', 12, undefined);
    expect(onArtifactUpdated).toHaveBeenCalledWith('notes', '/tmp/notes.md', 18, undefined);
    expect(lastTurnRef.current).toBe('self-turn-1');
    expect(lastSeqRef.current).toBe(3);
  });

  it('shares durable terminal semantics and completion callbacks with foreground turns', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onTurnEnd = vi.fn();
    const onStreamComplete = vi.fn();
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef: { current: '' },
      lastSeqRef: { current: -1 },
      onTurnEnd,
      onStreamComplete,
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'end_turn', persisted: true },
    }, handlers);

    expect(dispatch).toHaveBeenCalledWith({ type: 'done', nodeId: 'node-1', assistantId: 'self-a-1' });
    expect(onTurnEnd).toHaveBeenCalledWith('done', 'node-1');
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it('turns an unpersisted terminal frame into the same visible error path', () => {
    const dispatch = vi.fn<(action: ChatAction) => void>();
    const onTurnEnd = vi.fn();
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef: { current: '' },
      lastSeqRef: { current: -1 },
      onTurnEnd,
    }).createHandlers();

    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { ...envelope(0), userText: '', selfInitiated: true },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'end_turn', persisted: false },
    }, handlers);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', nodeId: 'node-1', assistantId: 'self-a-1',
    }));
    expect(onTurnEnd).toHaveBeenCalledWith('error', 'node-1');
  });
});

describe('cancellation settlement from the existing background binding', () => {
  const stops: Array<() => void> = [];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(fetchStream).mockReset().mockImplementation(async () => new Response(null, { status: 410 }));
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function observe(turnId = 'self-turn-1', chatId = 'chat-1') {
    const status = vi.fn();
    stops.push(cancelChatAndObserve(chatId, 'owner', turnId, status));
    return status;
  }

  function background() {
    return createBackgroundTurnBinding({
      chatId: 'chat-1', nodeId: 'node-1', dispatch: vi.fn(),
      lastTurnRef: { current: '' }, lastSeqRef: { current: -1 },
    }).createHandlers();
  }

  it('retries 410 without claiming success, then reports unconfirmed at 30 seconds', async () => {
    const status = observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(fetchStream).mock.calls.length).toBeGreaterThan(1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'pending' }));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(status.mock.calls.map(([value]) => value.state)).toEqual(['pending', 'error']);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringMatching(/not be confirmed/i) }));
    for (const [url] of vi.mocked(fetchStream).mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/chats/chat-1/stream');
      expect(parsed.searchParams.get('fromTurnId')).toBe('self-turn-1');
    }
    const requests = vi.mocked(fetchStream).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStream).toHaveBeenCalledTimes(requests);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('settles fast background cancellation exactly once without a pending flash or another background subscription', async () => {
    const status = observe();
    const handlers = background();
    await vi.advanceTimersByTimeAsync(0);
    const done: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.done,
      data: { ...envelope(1), stopReason: 'cancelled', persisted: true },
    };
    dispatchChatStreamEvent(done, handlers);
    dispatchChatStreamEvent(done, handlers);
    expect(status).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status).toHaveBeenCalledTimes(1);
    expect(fetchStream).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchStream).mock.calls[0][0])).toContain('/chats/chat-1/stream?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chats/chat-1/cancel');
  });

  it.each(['error', 'done-error', 'unpersisted'] as const)('reports background %s as cancellation failure', async (terminal) => {
    const status = observe();
    const handlers = background();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'pending' }));
    const event: ChatStreamEvent = terminal === 'error'
      ? { event: CHAT_STREAM_EVENTS.error, data: { ...envelope(1), message: 'Native cleanup failed' } }
      : { event: CHAT_STREAM_EVENTS.done, data: {
          ...envelope(1), stopReason: terminal === 'done-error' ? 'error' : 'cancelled',
          persisted: terminal !== 'unpersisted',
        } };
    dispatchChatStreamEvent(event, handlers);
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    if (terminal === 'error') expect(status).toHaveBeenLastCalledWith({ state: 'error', detail: 'Native cleanup failed' });
    const requests = vi.mocked(fetchStream).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status.mock.calls.map(([value]) => value.state)).toEqual(['pending', 'error']);
    expect(fetchStream).toHaveBeenCalledTimes(requests);
  });

  it('cannot settle a replacement observer using an old turn or another chat', async () => {
    const oldStatus = observe('old-turn');
    const newStatus = observe('self-turn-1');
    settleCancellationObservation('chat-1', 'old-turn', { state: 'error', detail: 'old cleanup' });
    settleCancellationObservation('another-chat', 'self-turn-1', { state: 'settled' });
    expect(oldStatus).not.toHaveBeenCalled();
    expect(newStatus).not.toHaveBeenCalled();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: {
      ...envelope(1), stopReason: 'cancelled', persisted: true,
    } }, background());
    expect(newStatus).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(oldStatus).not.toHaveBeenCalled();
    expect(newStatus).toHaveBeenCalledTimes(1);
  });

  it('accepts a background terminal before the cancel response without opening replay later', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const status = observe();
    dispatchChatStreamEvent({ event: CHAT_STREAM_EVENTS.done, data: {
      ...envelope(1), stopReason: 'cancelled', persisted: true,
    } }, background());
    expect(status).toHaveBeenCalledExactlyOnceWith({ state: 'settled' });
    release(new Response('{}', { status: 200 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStream).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
  });
});
