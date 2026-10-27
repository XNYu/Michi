import { describe, expect, it } from 'vitest';
import {
  findNextSafeBoundary,
  findNextSafeBoundaryOrNull,
  isSafeMarkdownBoundary,
} from './messageBoundary';

describe('findNextSafeBoundary — trivial cases', () => {
  it('reports null when the legacy snap only has an unsafe streaming end', () => {
    const t = 'a **streaming bold';
    expect(findNextSafeBoundary(t, 4)).toBe(t.length);
    expect(findNextSafeBoundaryOrNull(t, 4)).toBeNull();
    expect(isSafeMarkdownBoundary(t, t.length)).toBe(false);
  });
});

describe('findNextSafeBoundary — inline spans', () => {
  it('snaps past unclosed _italic_', () => {
    const t = 'a _it word_ rest\n\nq';
    // \n\n at 16-17, safe = 18.
    expect(findNextSafeBoundary(t, 4)).toBe(18);
  });

  it('treats backslash-escaped marker as literal', () => {
    const t = 'a \\*not italic\\* rest\n\nq';
    // \n\n at 21-22, safe = 23.
    expect(findNextSafeBoundary(t, 5)).toBe(23);
  });
});

describe('findNextSafeBoundary — block structures', () => {
  it('snaps past a fenced code block', () => {
    const t = '```ts\nfoo\nbar\n```\n\nrest';
    const idx = t.indexOf('rest');
    expect(findNextSafeBoundary(t, 7)).toBe(idx);
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
  it('handles ordered list', () => {
    const t = '1. a\n2. b\n3. c\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('b'))).toBe(idx);
  });

  it('handles parens inside link URL', () => {
    const t = 'pre [t](https://x.com/page(a)b) tail\n\nq';
    const idx = t.indexOf('q');
    expect(findNextSafeBoundary(t, t.indexOf('t]'))).toBe(idx);
  });
});
