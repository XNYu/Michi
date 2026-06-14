import type { ChatMessage } from './chatTypes';
import { assistantPersistenceContent } from './assistantBlocks';

export type FingerprintMessage = ChatMessage;

export function computeTranscriptFingerprint(messages: readonly FingerprintMessage[]): string {
  let payload = '';
  for (const m of messages) {
    const content = m.role === 'assistant' ? assistantPersistenceContent(m) : m.text ?? '';
    payload += `${m.role}\u0000${content}\u0000\u0000`;
  }
  return fnv1a32(payload);
}

function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
