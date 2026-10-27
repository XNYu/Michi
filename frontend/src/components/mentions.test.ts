import { describe, expect, it } from 'vitest';
import { reanchorMentions, expandMentions, type MentionRecord } from './mentions';

const mk = (start: number, label: string): MentionRecord => ({
  start,
  end: start + 1 + label.length,
  kind: 'node',
  refId: 'n1',
  label,
});

describe('reanchorMentions', () => {
  it('treats edit at right seam (changeStart == end) as outside', () => {
    const m = mk(0, 'Foo');
    // "@Foo" -> "@FooX"; insert "X" at idx 4 (right after chip end).
    const out = reanchorMentions('@Foo', '@FooX', [m], 4, 4);
    expect(out).toEqual([m]);
  });

  it('handles multiple mentions independently', () => {
    const a = mk(0, 'A');     // [0, 2)
    const b = mk(5, 'BB');    // [5, 8)
    // "@A @BB" -> "X@A @BB"; insert "X" at idx 0.
    const out = reanchorMentions('@A @BB', 'X@A @BB', [a, b], 0, 0);
    expect(out).toEqual([
      { ...a, start: 1, end: 3 },
      { ...b, start: 6, end: 9 },
    ]);
  });
});

describe('expandMentions', () => {
  it('handles two mentions in order', () => {
    const a: MentionRecord = {
      start: 0, end: 4, kind: 'context', refId: 'c-1', label: 'foo',
    };
    const b: MentionRecord = {
      start: 5, end: 5 + 1 + 3, kind: 'node', refId: 'n-1', label: 'Bar',
    };
    expect(expandMentions('@foo @Bar tail', [a, b]))
      .toBe('@foo @node:n-1 tail');
  });

  it('encodes remote identity only in the expanded text, leaving the draft reference intact', () => {
    const mention: MentionRecord = {
      start: 0, end: 7, kind: 'node', refId: 'remote:ssh%3Aa:n-1', label: 'Remote',
    };
    expect(expandMentions('@Remote.', [mention])).toBe('@node:remote%3Assh%253Aa%3An-1.');
    expect(mention.refId).toBe('remote:ssh%3Aa:n-1');
  });
});
