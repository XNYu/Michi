import { describe, expect, it } from 'vitest';
import {
  findNextSafeBoundary,
  findNextSafeBoundaryOrNull,
  isSafeMarkdownBoundary,
} from './messageBoundary';

describe('findNextSafeBoundary — trivial cases', () => {
  it('returns text.length when offset is at end', () => {
    const t = 'hello';
    expect(findNextSafeBoundary(t, t.length)).toBe(t.length);
  });

  it('returns 0 when text is empty', () => {
    expect(findNextSafeBoundary('', 0)).toBe(0);
  });

  it('snaps to text.length when no paragraph boundary exists', () => {
    const t = 'one line of plain text';
    expect(findNextSafeBoundary(t, 5)).toBe(t.length);
  });

  it('reports null when the legacy snap only has an unsafe streaming end', () => {
    const t = 'a **streaming bold';
    expect(findNextSafeBoundary(t, 4)).toBe(t.length);
    expect(findNextSafeBoundaryOrNull(t, 4)).toBeNull();
    expect(isSafeMarkdownBoundary(t, t.length)).toBe(false);
  });

  it('treats a closed plain-text end as a safe boundary', () => {
    const t = 'one line of plain text';
    expect(findNextSafeBoundaryOrNull(t, t.length)).toBe(t.length);
    expect(isSafeMarkdownBoundary(t, t.length)).toBe(true);
  });

  it('snaps to position right after \\n\\n', () => {
    const t = 'para a\n\npara b';
    // First \n\n: indices 6 and 7. Safe position = 8 (char after second \n).
    expect(findNextSafeBoundary(t, 0)).toBe(8);
  });
});

describe('findNextSafeBoundary — inline spans', () => {
  it('snaps past unclosed ** when offset lands inside bold', () => {
    const t = 'a **bold word** rest\n\ntail';
    // \n\n at indices 20-21; safe pos = 22.
    expect(findNextSafeBoundary(t, 5)).toBe(22);
  });

  it('snaps past unclosed _italic_', () => {
    const t = 'a _it word_ rest\n\nq';
    // \n\n at 16-17, safe = 18.
    expect(findNextSafeBoundary(t, 4)).toBe(18);
  });

  it('snaps past inline `code`', () => {
    const t = 'a `co de` rest\n\nq';
    // \n\n at 14-15, safe = 16.
    expect(findNextSafeBoundary(t, 4)).toBe(16);
  });

  it('treats backslash-escaped marker as literal', () => {
    const t = 'a \\*not italic\\* rest\n\nq';
    // \n\n at 21-22, safe = 23.
    expect(findNextSafeBoundary(t, 5)).toBe(23);
  });

  it('handles nested code-in-bold by closing on outer', () => {
    const t = 'pre **a `c` b** post\n\nq';
    // \n\n at 20-21, safe = 22.
    expect(findNextSafeBoundary(t, 7)).toBe(22);
  });
});

describe('findNextSafeBoundary — block structures', () => {
  it('snaps past a fenced code block', () => {
    const t = '```ts\nfoo\nbar\n```\n\nrest';
    const idx = t.indexOf('rest');
    expect(findNextSafeBoundary(t, 7)).toBe(idx);
  });

  it('snaps past heading line (relies on \\n\\n after heading)', () => {
    const t = 'pre\n\n#### Title\n\nbody';
    const idx = t.indexOf('body');
    expect(findNextSafeBoundary(t, 9)).toBe(idx);
  });

  it('does NOT enter fence mode for mid-line backticks', () => {
    // Mid-line ``` toggles codeSpan three times (= net open). Without an
    // explicit close before EOF, no \n\n is safe and we fall to text.length.
    // The point of this test: we did NOT enter inFence (which would also
    // require a line-start ``` to close), and behavior matches an unclosed
    // inline-code-span — exactly what mid-line ``` should be treated as.
    const t = 'inline ``` not a fence\n\nq';
    expect(findNextSafeBoundary(t, 5)).toBe(t.length);
  });

  it('snaps to text.length when fence is unclosed (streaming)', () => {
    const t = '```ts\nstreaming...';
    expect(findNextSafeBoundary(t, 8)).toBe(t.length);
  });
});

describe('findNextSafeBoundary — list blocks and links', () => {
  it('snaps past entire list when offset lands inside a list item', () => {
    const t = '- a\n- b\n- c\n\nrest';
    const idx = t.indexOf('rest');
    // Offset on 'b' (inside item 2) must skip to after the whole list.
    expect(findNextSafeBoundary(t, t.indexOf('b'))).toBe(idx);
  });

  it('handles ordered list', () => {
    const t = '1. a\n2. b\n3. c\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('b'))).toBe(idx);
  });

  it('snaps past link text', () => {
    const t = 'pre [click here](https://example.com) tail\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('click'))).toBe(idx);
  });

  it('handles parens inside link URL', () => {
    const t = 'pre [t](https://x.com/page(a)b) tail\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('t]'))).toBe(idx);
  });

  it('multiple offsets in same paragraph snap to same boundary', () => {
    // Two tools landing inside the same bold span both must end up at
    // the same safe position so weaveToolCalls' sort+slice keeps them
    // adjacent rather than splitting the span.
    const t = 'a **alpha beta gamma** rest\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('alpha'))).toBe(idx);
    expect(findNextSafeBoundary(t, t.indexOf('gamma'))).toBe(idx);
  });
});
