import { describe, it, expect } from 'vitest';
import { relativeTime } from './relativeTime';

const NOW = new Date('2026-05-07T12:00:00Z').getTime();

describe('relativeTime', () => {
  it('returns hours (1h..23h)', () => {
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1h');
    expect(relativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h');
  });

  it('returns "yesterday" between 24h and 48h', () => {
    expect(relativeTime(NOW - 25 * 60 * 60_000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 47 * 60 * 60_000, NOW)).toBe('yesterday');
  });

  it('returns days (2d..6d)', () => {
    expect(relativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d');
    expect(relativeTime(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe('6d');
  });
});
