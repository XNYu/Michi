import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_STREAM_EVENTS, META_AGENT_GUARD_ERROR_CODE, type ChatStreamEvent } from 'michi-shared';
import type { BackgroundSubscriber } from '../src/agents/chatHub';
import { watchAssistantGuardChecks } from '../src/services/metaAgent/chatGuardWatcher';

function fakeHub() {
  let sub: BackgroundSubscriber | null = null;
  return {
    hub: { subscribeBackground: (s: BackgroundSubscriber) => { sub = s; return () => { sub = null; }; } },
    emit: (chatId: string, event: string, data: Record<string, unknown>) => sub!.send(chatId, { event, data } as unknown as ChatStreamEvent),
    get subscribed() { return sub !== null; },
  };
}

describe('watchAssistantGuardChecks', () => {
  test('subscribes and survives events for unknown or ordinary chats', () => {
    const hub = fakeHub();
    const stop = watchAssistantGuardChecks(hub.hub);
    assert.equal(hub.subscribed, true);
    assert.doesNotThrow(() => hub.emit('n-unknown', CHAT_STREAM_EVENTS.error, { message: 'x', code: META_AGENT_GUARD_ERROR_CODE }));
    assert.doesNotThrow(() => hub.emit('n-unknown', CHAT_STREAM_EVENTS.done, { stopReason: 'end_turn' }));
    assert.doesNotThrow(() => hub.emit('n-unknown', CHAT_STREAM_EVENTS.error, { message: 'other failure' }));
    stop();
    assert.equal(hub.subscribed, false);
  });
});
