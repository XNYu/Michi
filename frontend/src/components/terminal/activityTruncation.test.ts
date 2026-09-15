import { describe, it, expect } from 'vitest';
import { truncateActivityBuckets } from './activityTruncation';

type B = 'now' | 'today' | 'yesterday' | 'earlier';
const ORDER: B[] = ['now', 'today', 'yesterday', 'earlier'];
const NOW_EXEMPT = new Set<B>(['now']);

function range(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe('truncateActivityBuckets', () => {
  it('passes everything through when under the limit', () => {
    const groups = new Map<B, string[]>([
      ['today', range('t', 3)],
      ['earlier', range('e', 2)],
    ]);
    const { visible, hidden } = truncateActivityBuckets(groups, ORDER, 20, NOW_EXEMPT);
    expect(hidden).toBe(0);
    expect(visible.get('today')).toEqual(range('t', 3));
    expect(visible.get('earlier')).toEqual(range('e', 2));
  });

  it('caps across buckets in order, keeping the head of the walk', () => {
    const groups = new Map<B, string[]>([
      ['today', range('t', 15)],
      ['yesterday', range('y', 10)],
      ['earlier', range('e', 30)],
    ]);
    const { visible, hidden } = truncateActivityBuckets(groups, ORDER, 20, NOW_EXEMPT);
    expect(visible.get('today')).toHaveLength(15);
    expect(visible.get('yesterday')).toEqual(range('y', 5));
    // A bucket with nothing left is omitted, not rendered as an empty header.
    expect(visible.has('earlier')).toBe(false);
    expect(hidden).toBe(5 + 30);
  });

  it('never counts or truncates exempt buckets', () => {
    const groups = new Map<B, string[]>([
      ['now', range('n', 7)],
      ['today', range('t', 25)],
    ]);
    const { visible, hidden } = truncateActivityBuckets(groups, ORDER, 20, NOW_EXEMPT);
    expect(visible.get('now')).toHaveLength(7);
    expect(visible.get('today')).toHaveLength(20);
    expect(hidden).toBe(5);
  });

  it('a raised limit reveals the next page', () => {
    const groups = new Map<B, string[]>([['earlier', range('e', 45)]]);
    const first = truncateActivityBuckets(groups, ORDER, 20, NOW_EXEMPT);
    const second = truncateActivityBuckets(groups, ORDER, 40, NOW_EXEMPT);
    const third = truncateActivityBuckets(groups, ORDER, 60, NOW_EXEMPT);
    expect(first.hidden).toBe(25);
    expect(second.visible.get('earlier')).toHaveLength(40);
    expect(second.hidden).toBe(5);
    expect(third.hidden).toBe(0);
  });

  it('skips buckets absent from the map', () => {
    const groups = new Map<B, string[]>([['yesterday', range('y', 2)]]);
    const { visible } = truncateActivityBuckets(groups, ORDER, 20, NOW_EXEMPT);
    expect([...visible.keys()]).toEqual(['yesterday']);
  });
});
