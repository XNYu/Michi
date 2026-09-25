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
  it('drops mention when edit overlaps its range', () => {
    const m = mk(0, 'Foo');
    // "@Foo bar" -> "@Fxo bar"; replace [2,3) with "x".
    const out = reanchorMentions('@Foo bar', '@Fxo bar', [m], 2, 3);
    expect(out).toEqual([]);
  });

  it('treats edit at left seam (changeEnd == start) as outside', () => {
    const m = mk(2, 'Foo');
    // "  @Foo" -> "  X@Foo"; insert "X" at idx 2 (right before @).
    const out = reanchorMentions('  @Foo', '  X@Foo', [m], 2, 2);
    expect(out).toEqual([{ ...m, start: 3, end: 7 }]);
  });

  it('treats edit at right seam (changeStart == end) as outside', () => {
    const m = mk(0, 'Foo');
    // "@Foo" -> "@FooX"; insert "X" at idx 4 (right after chip end).
    const out = reanchorMentions('@Foo', '@FooX', [m], 4, 4);
    expect(out).toEqual([m]);
  });

  it('returns an empty array when no mentions are passed', () => {
    expect(reanchorMentions('a', 'ab', [], 1, 1)).toEqual([]);
  });
});

describe('expandMentions', () => {
  it('returns plain value when no mentions', () => {
    expect(expandMentions('hello world', [])).toBe('hello world');
  });

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
});
