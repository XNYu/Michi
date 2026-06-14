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
  it('shifts mention forward when text inserted before it', () => {
    // "  @Foo bar" -> "X  @Foo bar"; insert "X" at idx 0, len 1.
    const m = mk(2, 'Foo');
    const out = reanchorMentions('  @Foo bar', 'X  @Foo bar', [m], 0, 0);
    expect(out).toEqual([{ ...m, start: 3, end: 7 }]);
  });

  it('leaves mention unchanged when text inserted after it', () => {
    const m = mk(0, 'Foo');
    // "@Foo bar" -> "@Foo barX"; insert "X" at idx 8.
    const out = reanchorMentions('@Foo bar', '@Foo barX', [m], 8, 8);
    expect(out).toEqual([m]);
  });

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

  it('shifts mention back when text deleted before it', () => {
    const m = mk(4, 'Foo');
    // "abc @Foo" -> "a @Foo"; delete [1,3).
    const out = reanchorMentions('abc @Foo', 'a @Foo', [m], 1, 3);
    expect(out).toEqual([{ ...m, start: 2, end: 6 }]);
  });

  it('drops mention when its range is fully deleted', () => {
    const m = mk(0, 'Foo');
    // "@Foo bar" -> " bar"; delete [0,4).
    const out = reanchorMentions('@Foo bar', ' bar', [m], 0, 4);
    expect(out).toEqual([]);
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

  it('returns an empty array when no mentions are passed', () => {
    expect(reanchorMentions('a', 'ab', [], 1, 1)).toEqual([]);
  });

  it('handles reversed selection (start > end) the same as normal direction', () => {
    const m = mk(0, 'Foo');
    // Same edit as "drops mention when edit overlaps its range" but with
    // selection passed in reversed order.
    const out = reanchorMentions('@Foo bar', '@Fxo bar', [m], 3, 2);
    expect(out).toEqual([]);
  });
});

describe('expandMentions', () => {
  it('returns plain value when no mentions', () => {
    expect(expandMentions('hello world', [])).toBe('hello world');
  });

  it('rewrites a node mention to @node:<id>', () => {
    const m: MentionRecord = {
      start: 4, end: 4 + 1 + 14, kind: 'node',
      refId: 'n-abc', label: 'Witnessing the',
    };
    expect(expandMentions('see @Witnessing the more', [m]))
      .toBe('see @node:n-abc more');
  });

  it('keeps a context mention as @<name> on the wire', () => {
    const m: MentionRecord = {
      start: 0, end: 1 + 7, kind: 'context',
      refId: 'c-1', label: 'api-doc',
    };
    expect(expandMentions('@api-doc here', [m]))
      .toBe('@api-doc here');
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
