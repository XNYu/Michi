import { describe, it, expect } from 'vitest';
import { truncateActivityBuckets } from './activityTruncation';

type B = 'now' | 'today' | 'yesterday' | 'earlier';
const ORDER: B[] = ['now', 'today', 'yesterday', 'earlier'];
const NOW_EXEMPT = new Set<B>(['now']);

function range(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

describe('truncateActivityBuckets', () => {
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
});
