import { CHAT_STREAM_EVENTS, META_AGENT_GUARD_ERROR_CODE } from 'michi-shared';
import type { BackgroundSubscriber } from '../../agents/chatHub';
import { recordAssistantGuardCheck } from '../../assistant/binding';

interface BackgroundSource {
  subscribeBackground(sub: BackgroundSubscriber): () => void;
}

/**
 * Records the chat window's restriction check from its turns: a turn that
 * fails the check stores the failure, a completed turn stores ok. Claude, Pi
 * and Kiro check inside the turn, so the session-open path alone misses them.
 * Non-assistant conversations are ignored by recordAssistantGuardCheck.
 */
export function watchAssistantGuardChecks(hub: BackgroundSource): () => void {
  return hub.subscribeBackground({
    send: (chatId, event) => {
      try {
        if (event.event === CHAT_STREAM_EVENTS.error) {
          const data = event.data as { message?: string; code?: string };
          if (data.code !== META_AGENT_GUARD_ERROR_CODE) return;
          recordAssistantGuardCheck(chatId, new Error(data.message ?? ''));
        } else if (event.event === CHAT_STREAM_EVENTS.done) {
          const data = event.data as { stopReason?: string };
          if (data.stopReason === 'cancelled') return;
          recordAssistantGuardCheck(chatId, null);
        }
      } catch (err) {
        console.error('Failed to record the chat window restriction check:', err);
      }
    },
    close: () => {},
  });
}
