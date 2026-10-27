import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from 'michi-shared';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent } from './chatStreamEvents';
import type { StreamHandlers } from './chatStreamEvents';

describe('dispatchChatStreamEvent turn_start/envelope', () => {
  it('routes turn_start to onTurnStart with its payload', () => {
    const onTurnStart = vi.fn();
    const ev: ChatStreamEvent = {
      event: CHAT_STREAM_EVENTS.turnStart,
      data: { turnId: 'T1', assistantId: 'a-n1-T1', nodeId: 'n1', userText: 'hi' },
    };

    dispatchChatStreamEvent(ev, { onTurnStart });

    expect(onTurnStart).toHaveBeenCalledWith({
      turnId: 'T1',
      assistantId: 'a-n1-T1',
      nodeId: 'n1',
      userText: 'hi',
    });
  });

  it('passes seq, assistantId, turnId, and observedAt through chunk handlers', () => {
    const onChunk = vi.fn();
    const handlers: StreamHandlers = { onChunk };

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.chunk,
        data: { text: 'hi', seq: 5, turnId: 'T1', assistantId: 'a-n1-T1', observedAt: 1_234 },
      },
      handlers,
    );

    expect(onChunk).toHaveBeenCalledWith('hi', 5, 'a-n1-T1', 'T1', 1_234);
  });

  it('passes observedAt through thought handlers', () => {
    const onThought = vi.fn();

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.thought,
        data: { text: 'hmm', seq: 6, turnId: 'T1', assistantId: 'a-n1-T1', observedAt: 1_300 },
      },
      { onThought },
    );

    expect(onThought).toHaveBeenCalledWith('hmm', 6, 'a-n1-T1', 'T1', 1_300);
  });

  it('keeps chunk envelope args undefined for back-compat frames', () => {
    const onChunk = vi.fn();

    dispatchChatStreamEvent(
      { event: CHAT_STREAM_EVENTS.chunk, data: { text: 'hi' } },
      { onChunk },
    );

    expect(onChunk).toHaveBeenCalledWith('hi', undefined, undefined, undefined, undefined);
  });

  it('passes assistantId and turnId through terminal events', () => {
    const onDone = vi.fn();

    dispatchChatStreamEvent(
      {
        event: CHAT_STREAM_EVENTS.done,
        data: { stopReason: 'end_turn', assistantId: 'a-n1-T1', turnId: 'T1' },
      },
      { onDone },
    );

    expect(onDone).toHaveBeenCalledWith('end_turn', 'a-n1-T1', 'T1', undefined, undefined);
  });
});
