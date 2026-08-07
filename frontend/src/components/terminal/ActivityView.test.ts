import { describe, it, expect } from 'vitest';

// We need to test the data derivation logic. Since it's internal to the
// component file, we'll extract and test the key helper separately.
// For now, test the time bucket logic by inlining it.

type TimeBucket = 'now' | 'today' | 'yesterday' | 'earlier';

function getTimeBucket(lastActiveAt: number, isStreaming: boolean): TimeBucket {
  if (isStreaming) return 'now';
  const now = Date.now();
  const d = new Date(lastActiveAt);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (lastActiveAt >= today.getTime()) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (lastActiveAt >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

describe('ActivityView time bucketing', () => {
  it('streaming trees always go to "now"', () => {
    // Even if lastActiveAt is old, streaming = "now"
    expect(getTimeBucket(0, true)).toBe('now');
    expect(getTimeBucket(Date.now() - 86400_000 * 5, true)).toBe('now');
  });

  it('recent activity today goes to "today"', () => {
    const fiveMinAgo = Date.now() - 5 * 60_000;
    expect(getTimeBucket(fiveMinAgo, false)).toBe('today');
  });

  it('activity yesterday goes to "yesterday"', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterdayNoon = today.getTime() - 12 * 3600_000;
    expect(getTimeBucket(yesterdayNoon, false)).toBe('yesterday');
  });

  it('old activity goes to "earlier"', () => {
    const threeDaysAgo = Date.now() - 3 * 86400_000;
    expect(getTimeBucket(threeDaysAgo, false)).toBe('earlier');
  });
});
