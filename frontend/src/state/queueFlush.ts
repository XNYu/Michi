import type { MentionRecord } from '../components/mentions';
import type { AttachmentRef } from '../lib/composerAttachments';
import type { PendingQueuedMessage } from './chatTypes';

const SEPARATOR = '\n\n';

export interface FlushPayload {
  /** Combined literal text (chip labels intact). */
  value: string;
  /** Mention offsets recomputed for the combined string. */
  mentions: MentionRecord[];
  /** All attachments concatenated in queue order. */
  attachments: AttachmentRef[];
}

/**
 * Combine a non-empty queue into a single payload ready for sendMessage.
 * Returns null for an empty queue. Single-entry queue passes through
 * with no separator added.
 */
export function buildFlushPayload(queue: readonly PendingQueuedMessage[]): FlushPayload | null {
  if (queue.length === 0) return null;
  if (queue.length === 1) {
    const only = queue[0];
    return {
      value: only.value,
      mentions: [...only.mentions],
      attachments: [...only.attachments],
    };
  }
  let value = '';
  const mentions: MentionRecord[] = [];
  const attachments: AttachmentRef[] = [];
  queue.forEach((q, idx) => {
    if (idx > 0) value += SEPARATOR;
    const start = value.length;
    value += q.value;
    for (const m of q.mentions) {
      mentions.push({ ...m, start: m.start + start, end: m.end + start });
    }
    for (const a of q.attachments) attachments.push(a);
  });
  return { value, mentions, attachments };
}
