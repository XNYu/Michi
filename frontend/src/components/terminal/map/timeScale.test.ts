import { describe, it, expect } from 'vitest';
import { buildElasticScale, layoutChips, formatAxisLabel, formatGap } from './timeScale';

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

  it('returns 0.5 for single-event input', () => {
    const s = buildElasticScale([BASE]);
    expect(s.frac(BASE)).toBe(0.5);
    expect(s.start).toBe(BASE);
    expect(s.end).toBe(BASE);
  });

  it('produces a linear mapping when all gaps are below idle threshold', () => {
    // 4 events, each 10 minutes apart — all under 30min threshold
    const times = [BASE, BASE + 10 * MIN, BASE + 20 * MIN, BASE + 30 * MIN];
    const s = buildElasticScale(times);

    expect(s.breaks).toHaveLength(0);
    // Should be proportional: 10min/30min = 1/3, 20min/30min = 2/3
    expect(s.frac(times[0])).toBeCloseTo(0, 5);
    expect(s.frac(times[1])).toBeCloseTo(1 / 3, 5);
    expect(s.frac(times[2])).toBeCloseTo(2 / 3, 5);
    expect(s.frac(times[3])).toBeCloseTo(1, 5);
  });

  it('compresses a single large gap', () => {
    // 10min active, then 20h gap, then 10min active
    const times = [
      BASE,
      BASE + 10 * MIN, // end of first session
      BASE + 10 * MIN + 20 * HOUR, // start of second session (20h later)
      BASE + 20 * MIN + 20 * HOUR, // end of second session
    ];
    const s = buildElasticScale(times);

    expect(s.breaks).toHaveLength(1);
    expect(s.breaks[0].realGap).toBe(20 * HOUR);

    // The compressed gap should be tiny relative to active segments
    // Active total: 10min + 10min = 20min virtual
    // Compressed: 30min * 0.08 = 2.4min virtual
    // Total virtual = 20 + 2.4 = 22.4
    // First session spans 10/22.4, gap is 2.4/22.4, second is 10/22.4
    const firstSessionEnd = s.frac(times[1]);
    const secondSessionStart = s.frac(times[2]);
    const gapVisualWidth = secondSessionStart - firstSessionEnd;
    const activeWidth = firstSessionEnd + (1 - secondSessionStart);

    // Gap should be visually much smaller than active time
    expect(gapVisualWidth).toBeLessThan(activeWidth * 0.2);
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

  it('deduplicates identical timestamps', () => {
    const times = [BASE, BASE, BASE + 10 * MIN, BASE + 10 * MIN];
    const s = buildElasticScale(times);
    expect(s.frac(BASE)).toBe(0);
    expect(s.frac(BASE + 10 * MIN)).toBe(1);
  });

  it('clamps out-of-range timestamps', () => {
    const times = [BASE, BASE + 10 * MIN];
    const s = buildElasticScale(times);
    expect(s.frac(BASE - 1000)).toBe(0);
    expect(s.frac(BASE + 20 * MIN)).toBe(1);
  });

  it('respects custom idle threshold', () => {
    // 5min gap — should compress with idleMs=3min, not with default 30min
    const times = [BASE, BASE + 5 * MIN, BASE + 10 * MIN];
    const strict = buildElasticScale(times, { idleMs: 3 * MIN });
    const default_ = buildElasticScale(times);

    // Strict: the 5min gap is > 3min threshold → one break
    expect(strict.breaks).toHaveLength(2); // both 5min gaps exceed 3min
    // Default: 5min gap is below 30min threshold → no breaks
    expect(default_.breaks).toHaveLength(0);
  });

  it('scenario: single session under 2h has no compression', () => {
    // The user's exact requirement: "if it happened in 1 hour, no compression"
    const events = [
      BASE,
      BASE + 3 * MIN,
      BASE + 8 * MIN,
      BASE + 20 * MIN,
      BASE + 35 * MIN,
      BASE + 55 * MIN,
    ];
    const s = buildElasticScale(events);
    expect(s.breaks).toHaveLength(0);

    // Linear proportionality preserved
    const totalSpan = 55 * MIN;
    for (const t of events) {
      expect(s.frac(t)).toBeCloseTo((t - BASE) / totalSpan, 4);
    }
  });

  it('scenario: cross-day gap is compressed', () => {
    // The user's example: "yesterday two messages, today two messages, 1 day gap"
    const yesterday1 = BASE;
    const yesterday2 = BASE + 15 * MIN;
    const today1 = BASE + 20 * HOUR; // 20h later
    const today2 = BASE + 20 * HOUR + 10 * MIN;

    const s = buildElasticScale([yesterday1, yesterday2, today1, today2]);
    expect(s.breaks).toHaveLength(1);
    expect(s.breaks[0].realGap).toBe(20 * HOUR - 15 * MIN);

    // The visual proportion of yesterday's 15min and today's 10min should
    // dominate; the compressed 20h gap should be a sliver
    const yesterdaySpan = s.frac(yesterday2) - s.frac(yesterday1);
    const gapSpan = s.frac(today1) - s.frac(yesterday2);
    const todaySpan = s.frac(today2) - s.frac(today1);

    expect(gapSpan).toBeLessThan(yesterdaySpan);
    expect(gapSpan).toBeLessThan(todaySpan);
  });
});

describe('layoutChips', () => {
  const simpleScale = buildElasticScale([0, 100]);

  it('returns empty for no chips', () => {
    expect(layoutChips([], simpleScale, { trackWidth: 600 })).toHaveLength(0);
  });

  it('places non-overlapping chips on row 0', () => {
    const scale = buildElasticScale([0, 500, 1000]);
    const chips = [
      { at: 0, key: 'a' },
      { at: 500, key: 'b' },
      { at: 1000, key: 'c' },
    ];
    const result = layoutChips(chips, scale, { trackWidth: 1000, chipWidth: 100 });
    // All should be on row 0 — spread across 1000px with 100px chips
    for (const r of result) {
      expect(r.row).toBe(0);
    }
  });

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

  it('handles 4 chips at nearly the same time', () => {
    const scale = buildElasticScale([0, 1, 2, 3, 1000]);
    const chips = [
      { at: 0, key: 'a' },
      { at: 1, key: 'b' },
      { at: 2, key: 'c' },
      { at: 3, key: 'd' },
    ];
    const result = layoutChips(chips, scale, { trackWidth: 500, chipWidth: 200 });
    const maxRow = Math.max(...result.map((r) => r.row));
    expect(maxRow).toBeGreaterThanOrEqual(1); // at least 2 rows needed
  });

  it('respects custom gap parameter', () => {
    const scale = buildElasticScale([0, 600, 1000]);
    const chips = [
      { at: 0, key: 'a', width: 100 },
      { at: 600, key: 'b', width: 100 },
    ];
    // With gap=0, 300px apart (centers at 0 and 300), 100px chips → no overlap
    const tight = layoutChips(chips, scale, { trackWidth: 500, chipWidth: 100, gap: 0 });
    expect(tight.every((r) => r.row === 0)).toBe(true);
  });
});

describe('formatAxisLabel', () => {
  it('shows HH:MM for sub-day spans', () => {
    const t = new Date(2025, 5, 15, 14, 30).getTime();
    expect(formatAxisLabel(t, 2 * HOUR)).toBe('14:30');
  });

  it('shows M/D HH:MM for multi-day spans', () => {
    const t = new Date(2025, 5, 15, 14, 30).getTime();
    expect(formatAxisLabel(t, 3 * DAY)).toBe('6/15 14:30');
  });
});

describe('formatGap', () => {
  it('formats minutes', () => {
    expect(formatGap(45 * MIN)).toBe('45min');
  });

  it('formats hours', () => {
    expect(formatGap(3.5 * HOUR)).toBe('3.5h');
  });

  it('formats days', () => {
    expect(formatGap(2 * DAY)).toBe('2.0d');
  });
});
