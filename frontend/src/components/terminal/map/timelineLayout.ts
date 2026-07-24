// frontend/src/components/terminal/map/timelineLayout.ts

/** Gap larger than this (ms) between adjacent events folds into a narrow seam. */
export const GAP_THRESHOLD_MS = 12 * 3600_000; // 12h

export interface TimeSegment {
  start: number;       // earliest event `at` in this segment
  end: number;         // latest event `at` in this segment
  /** Folded empty duration immediately before this segment (0 for the first). */
  gapBeforeMs: number;
}

/** Partition timestamped events into active segments; big gaps fold between them. */
export function segmentTimeline(events: ReadonlyArray<{ at: number }>): TimeSegment[] {
  if (events.length === 0) return [];
  const times = events.map((e) => e.at).sort((a, b) => a - b);
  const segs: TimeSegment[] = [];
  let start = times[0];
  let prev = times[0];
  let gapBefore = 0;
  for (let i = 1; i < times.length; i++) {
    const t = times[i];
    if (t - prev > GAP_THRESHOLD_MS) {
      segs.push({ start, end: prev, gapBeforeMs: gapBefore });
      gapBefore = t - prev;
      start = t;
    }
    prev = t;
  }
  segs.push({ start, end: prev, gapBeforeMs: gapBefore });
  return segs;
}

/** Horizontal pixels allotted to one event slot inside an active segment. */
export const SLOT_PX = 168;
/** Fixed width of a folded-gap seam. */
export const SEAM_PX = 46;

export interface TimelineLayout {
  totalWidth: number;
  /** Maps an event's `at` + its global index to an x pixel (segment-uniform). */
  xForEvent: (at: number, index: number) => number;
  /** Seam bands to render (x offset + width) for each folded gap. */
  seams: Array<{ x: number; width: number }>;
}

/**
 * Lay events on a non-linear x axis: uniform spacing inside a segment,
 * fixed seams between segments. Index is the event's position in ascending order.
 */
export function layoutTimelineX(events: ReadonlyArray<{ at: number }>): TimelineLayout {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const segs = segmentTimeline(sorted);
  const xByAt = new Map<number, number>();
  const seams: Array<{ x: number; width: number }> = [];
  let cursor = 0;
  for (const seg of segs) {
    if (seg.gapBeforeMs > 0) {
      seams.push({ x: cursor, width: SEAM_PX });
      cursor += SEAM_PX;
    }
    const inSeg = sorted.filter((e) => e.at >= seg.start && e.at <= seg.end);
    inSeg.forEach((e, i) => {
      xByAt.set(e.at, cursor + i * SLOT_PX + SLOT_PX / 2);
    });
    cursor += Math.max(1, inSeg.length) * SLOT_PX;
  }
  return {
    totalWidth: cursor,
    xForEvent: (at) => xByAt.get(at) ?? 0,
    seams,
  };
}
