import { describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent } from '../services/chatStreamEvents';
import type { ChatStreamEvent } from '../services/chatStreamEvents';
import { createBackgroundTurnBinding } from './observeChatStream';
import type { ChatAction } from './chatTypes';

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
    const onContextSaved = vi.fn();
    const onContextUpdated = vi.fn();
    const lastTurnRef = { current: '' };
    const lastSeqRef = { current: -1 };
    const handlers = createBackgroundTurnBinding({
      chatId: 'chat-1',
      nodeId: 'node-1',
      dispatch,
      lastTurnRef,
      lastSeqRef,
      extraHandlers: { onSpawnBranches, onContextSaved, onContextUpdated },
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
      event: CHAT_STREAM_EVENTS.contextSaved,
      data: { ...envelope(2), name: 'notes', filePath: '/tmp/notes.md', size: 12 },
    }, handlers);
    dispatchChatStreamEvent({
      event: CHAT_STREAM_EVENTS.contextUpdated,
      data: { ...envelope(3), name: 'notes', filePath: '/tmp/notes.md', size: 18 },
    }, handlers);

    expect(onSpawnBranches).toHaveBeenCalledTimes(1);
    expect(onContextSaved).toHaveBeenCalledWith('notes', '/tmp/notes.md', 12, undefined);
    expect(onContextUpdated).toHaveBeenCalledWith('notes', '/tmp/notes.md', 18, undefined);
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
