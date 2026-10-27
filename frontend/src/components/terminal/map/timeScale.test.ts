import { describe, it, expect } from 'vitest';
import { buildElasticScale, layoutChips, formatAxisLabel } from './timeScale';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = 1_700_000_000_000; // arbitrary base epoch ms

describe('buildElasticScale', () => {
  it('returns a no-op scale for empty input', () => {
    const s = buildElasticScale([]);
    expect(s.frac(12345)).toBe(0);
    expect(s.breaks).toHaveLength(0);
    expect(s.totalVirtual).toBe(0);
  });

  it('handles multiple gaps (multi-day research)', () => {
    const times = [
      BASE, // day 1 start
      BASE + 25 * MIN, // day 1 end
      BASE + DAY, // day 2 start (24h gap)
      BASE + DAY + 8 * MIN, // day 2 end
      BASE + 3 * DAY, // day 4 start (2 day gap)
      BASE + 3 * DAY + 15 * MIN, // day 4 end
    ];
    const s = buildElasticScale(times);

    expect(s.breaks).toHaveLength(2);
    expect(s.breaks[0].realGap).toBeCloseTo(DAY - 25 * MIN);
    expect(s.breaks[1].realGap).toBeCloseTo(2 * DAY - 8 * MIN);

    // Verify ordering is preserved
    const fracs = times.map((t) => s.frac(t));
    for (let i = 1; i < fracs.length; i++) {
      expect(fracs[i]).toBeGreaterThan(fracs[i - 1]);
    }
  });
});

describe('layoutChips', () => {
  const simpleScale = buildElasticScale([0, 100]);

  it('pushes overlapping chips to higher rows', () => {
    // Two events at very close times → overlapping chips
    const scale = buildElasticScale([0, 10, 1000]);
    const chips = [
      { at: 0, key: 'a' },
      { at: 10, key: 'b' }, // basically the same x position
    ];
    const result = layoutChips(chips, scale, { trackWidth: 500, chipWidth: 200 });
    const rows = result.map((r) => r.row);
    expect(rows).toContain(0);
    expect(rows).toContain(1); // second chip pushed to row 1
  });
});

describe('formatAxisLabel', () => {
  it('shows M/D HH:MM for multi-day spans', () => {
    const t = new Date(2025, 5, 15, 14, 30).getTime();
    expect(formatAxisLabel(t, 3 * DAY)).toBe('6/15 14:30');
  });
});
