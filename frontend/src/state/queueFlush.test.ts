import { describe, expect, it } from 'vitest';
import { buildFlushPayload } from './queueFlush';
import type { PendingQueuedMessage } from './chatTypes';
import type { MentionRecord } from '../components/mentions';
import type { AttachmentRef } from '../lib/composerAttachments';

const q = (
  id: string,
  value: string,
  mentions: MentionRecord[] = [],
  attachments: AttachmentRef[] = [],
): PendingQueuedMessage => ({
  id,
  value,
  mentions,
  attachments,
  queuedAt: 0,
});

describe('buildFlushPayload', () => {
  it('returns null for an empty queue', () => {
    expect(buildFlushPayload([])).toBeNull();
  });

  it('passes a single entry through verbatim (no separator added)', () => {
    const out = buildFlushPayload([q('1', 'hello')]);
    expect(out).toEqual({ value: 'hello', mentions: [], attachments: [] });
  });

  it('joins multiple entries with \\n\\n', () => {
    const out = buildFlushPayload([q('1', 'first'), q('2', 'second'), q('3', 'third')]);
    expect(out?.value).toBe('first\n\nsecond\n\nthird');
  });

  it('shifts subsequent mention offsets by combined prefix length', () => {
    const a = q('1', 'first @one', [{ start: 6, end: 10, kind: 'context', refId: 'one', label: 'one' }]);
    const b = q('2', '@two more', [{ start: 0, end: 4, kind: 'context', refId: 'two', label: 'two' }]);
    const out = buildFlushPayload([a, b]);
    // 'first @one' is 10 chars; '\n\n' adds 2; second entry starts at offset 12.
    expect(out?.mentions).toEqual([
      { start: 6, end: 10, kind: 'context', refId: 'one', label: 'one' },
      { start: 12, end: 16, kind: 'context', refId: 'two', label: 'two' },
    ]);
  });

  it('concatenates attachments preserving order', () => {
    const a = q('1', 'a', [], [{ name: 'one.txt', absPath: '/p/one.txt' }]);
    const b = q('2', 'b', [], [{ name: 'two.txt', absPath: '/p/two.txt' }]);
    const out = buildFlushPayload([a, b]);
    expect(out?.attachments).toEqual([
      { name: 'one.txt', absPath: '/p/one.txt' },
      { name: 'two.txt', absPath: '/p/two.txt' },
    ]);
  });
});
