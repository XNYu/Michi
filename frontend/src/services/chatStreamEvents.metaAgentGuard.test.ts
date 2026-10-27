import { encodeChatStreamEvent, META_AGENT_GUARD_ERROR_CODE } from 'michi-shared';
import { vi } from 'vitest';
import type { ChatStreamErrorPayload } from './api/stream';
import { CHAT_STREAM_EVENTS, dispatchChatStreamEvent, parseChatStreamEvent } from './chatStreamEvents';

const message = 'Meta agent restriction check failed on kiro: desk_now';

function wireFrame(): string {
  return encodeChatStreamEvent({
    event: CHAT_STREAM_EVENTS.error,
    data: { message, code: META_AGENT_GUARD_ERROR_CODE, completedAt: 5, turnId: 'T1', assistantId: 'a-1' },
  });
}

function parse(frame: string) {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  return event && data ? parseChatStreamEvent(event, data) : null;
}

describe('Meta agent restriction failure on the chat stream', () => {
  it('reaches onErrorPayload with its code', () => {
    const parsed = parse(wireFrame());
    expect(parsed).not.toBeNull();
    const received: ChatStreamErrorPayload[] = [];
    dispatchChatStreamEvent(parsed!, { onErrorPayload: (data) => received.push(data) });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message, code: META_AGENT_GUARD_ERROR_CODE, turnId: 'T1', assistantId: 'a-1' });
  });

  it('reaches the positional onError handler with its code', () => {
    const onError = vi.fn();
    dispatchChatStreamEvent(parse(wireFrame())!, { onError });
    expect(onError).toHaveBeenCalledWith(message, 'a-1', 'T1', META_AGENT_GUARD_ERROR_CODE);
  });
});
