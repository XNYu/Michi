export interface MentionRecord {
  /** Inclusive: index of the leading '@' in the textarea value. */
  start: number;
  /** Exclusive: index of the first char after the chip body. */
  end: number;
  kind: 'context' | 'node';
  /** contextId for kind='context'; nodeId for kind='node'. */
  refId: string;
  /** Display label (without leading @). What the chip renders. */
  label: string;
}

/**
 * Adjust mention ranges after a textarea edit.
 *
 * Treats `[prevSelStart, prevSelEnd)` in `prevValue` as the change region. For
 * each mention, shifts the range when the change is fully outside, drops the
 * mention when the change overlaps. Edits exactly at a boundary
 * (`changeEnd == m.start` or `changeStart == m.end`) are treated as outside.
 */
export function reanchorMentions(
  prevValue: string,
  nextValue: string,
  mentions: MentionRecord[],
  prevSelStart: number,
  prevSelEnd: number,
): MentionRecord[] {
  const delta = nextValue.length - prevValue.length;
  // Browsers may hand us a reversed selection (right-to-left drag);
  // normalize so the algorithm only needs to reason about a single direction.
  const changeStart = Math.min(prevSelStart, prevSelEnd);
  const changeEnd = Math.max(prevSelStart, prevSelEnd);
  const out: MentionRecord[] = [];
  for (const m of mentions) {
    if (changeEnd <= m.start) {
      out.push({ ...m, start: m.start + delta, end: m.end + delta });
    } else if (changeStart >= m.end) {
      out.push(m);
    } else {
      // overlap → drop
    }
  }
  return out;
}

/**
 * Convert a draft `(value, mentions)` into the wire string sent to the agent.
 * Context mentions are kept as `@<name>` (already in the value), node mentions
 * are rewritten to `@node:<id>`.
 *
 * Assumes mentions are sorted by `start` and non-overlapping.
 */
export function expandMentions(value: string, mentions: MentionRecord[]): string {
  if (mentions.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const m of mentions) {
    out += value.slice(cursor, m.start);
    if (m.kind === 'context') {
      out += `@${m.label}`;
    } else {
      out += `@node:${m.refId}`;
    }
    cursor = m.end;
  }
  out += value.slice(cursor);
  return out;
}
