// frontend/src/components/terminal/map/timelineLayout.test.ts
import { describe, it, expect } from 'vitest';
import { segmentTimeline, GAP_THRESHOLD_MS, layoutTimelineX, SEAM_PX, SLOT_PX } from './timelineLayout';

describe('segmentTimeline', () => {
  it('groups events within threshold into one segment', () => {
    const segs = segmentTimeline([{ at: 0 }, { at: 1000 }, { at: 2000 }]);
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(2000);
  });

  it('splits when gap exceeds threshold, records gap between', () => {
    const big = GAP_THRESHOLD_MS + 1;
    const segs = segmentTimeline([{ at: 0 }, { at: big }, { at: big + 1000 }]);
    expect(segs).toHaveLength(2);
    expect(segs[0].end).toBe(0);
    expect(segs[1].start).toBe(big);
    expect(segs[1].gapBeforeMs).toBe(big); // folded gap duration before seg 2
    expect(segs[0].gapBeforeMs).toBe(0);   // first segment has no gap before
  });

  it('handles empty input', () => {
    expect(segmentTimeline([])).toEqual([]);
  });

  it('handles unsorted input', () => {
    const segs = segmentTimeline([{ at: 2000 }, { at: 0 }, { at: 1000 }]);
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(0);
  });
});

describe('layoutTimelineX', () => {
  it('places events within a segment at equal spacing', () => {
    const events = [{ at: 0 }, { at: 5 }, { at: 9 }]; // one segment, 3 events
    const { xForEvent } = layoutTimelineX(events);
    const xs = events.map((e, i) => xForEvent(e.at, i));
    expect(xs[1] - xs[0]).toBe(xs[2] - xs[1]); // equal spacing, NOT proportional to at
  });

  it('inserts a fixed seam between segments', () => {
    const big = 20 * 3600_000;
    const events = [{ at: 0 }, { at: big }];
    const { seams } = layoutTimelineX(events);
    expect(seams).toHaveLength(1);
    expect(seams[0].width).toBe(SEAM_PX);
  });

  it('total width grows with slot count', () => {
    const a = layoutTimelineX([{ at: 0 }, { at: 1 }]);
    const b = layoutTimelineX([{ at: 0 }, { at: 1 }, { at: 2 }, { at: 3 }]);
    expect(b.totalWidth).toBeGreaterThan(a.totalWidth);
  });
});
