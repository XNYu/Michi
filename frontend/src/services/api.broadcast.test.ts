import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from 'michi-shared';
import { subscribeChat } from './api';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('foreground stream api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('subscribeChat opens the immutable turn replay cursor without posting cancel', async () => {
    const onTurnStart = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      encodeChatStreamEvent({
        event: CHAT_STREAM_EVENTS.turnStart,
        data: { turnId: 'T1', seq: 5, assistantId: 'a-n1-T1', nodeId: 'n1', userText: 'hi' },
      }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    subscribeChat('chat1', { onTurnStart }, { turnId: 'T0', seq: 4 });
    await vi.waitFor(() => expect(onTurnStart).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/chats\/chat1\/stream\?fromSeq=4&fromTurnId=T0$/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
