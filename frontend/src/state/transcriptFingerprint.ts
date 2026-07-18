import { computeTranscriptFingerprint as computeWireTranscriptFingerprint } from 'michi-shared';
import type { ChatMessage } from './chatTypes';
import { assistantPersistenceContent } from './assistantBlocks';

export type FingerprintMessage = ChatMessage;

const finalizedAssistantContentCache = new WeakMap<ChatMessage, string>();

function fingerprintContent(message: ChatMessage): string {
  if (message.role !== 'assistant') return message.text ?? '';
  const cached = finalizedAssistantContentCache.get(message);
  if (cached !== undefined) return cached;
  const content = assistantPersistenceContent(message);
  finalizedAssistantContentCache.set(message, content);
  return content;
}

export function computeTranscriptFingerprint(messages: readonly FingerprintMessage[]): string {
  return computeWireTranscriptFingerprint(messages.map((message) => ({
    role: message.role,
    content: fingerprintContent(message),
  })));
}
