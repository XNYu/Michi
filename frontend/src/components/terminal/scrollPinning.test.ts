import { describe, expect, it } from 'vitest';
import { nextFollowScrollTop } from './scrollPinning';

describe('nextFollowScrollTop', () => {
  it('advances toward the later anchor while following a stream', () => {
    expect(nextFollowScrollTop({
      currentScrollTop: 120,
      maxScroll: 400,
      anchor: 100,
      tail: 220,
    })).toBe(220);
  });

  it('does not chase transient upward markdown reflow while following', () => {
    expect(nextFollowScrollTop({
      currentScrollTop: 260,
      maxScroll: 400,
      anchor: 100,
      tail: 180,
    })).toBe(260);
  });

  it('clamps only to the legal maximum when content becomes shorter', () => {
    expect(nextFollowScrollTop({
      currentScrollTop: 480,
      maxScroll: 300,
      anchor: 100,
      tail: 260,
    })).toBe(300);
  });
});
