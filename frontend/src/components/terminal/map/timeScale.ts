/**
 * Elastic time scale for MapTimeline.
 *
 * Core idea: active conversation intervals preserve real proportional spacing;
 * idle gaps exceeding a threshold are compressed into narrow visual breaks.
 * A piecewise-linear mapping converts raw timestamps to [0,1] fractions.
 *
 * Also provides chip collision detection for laying out overlapping chips
 * within a lane.
 */

export interface ElasticScaleBreak {
  /** Timestamp of the last event before the gap. */
  afterTime: number;
  /** Timestamp of the first event after the gap. */
  beforeTime: number;
  /** Real duration of the gap (ms). */
  realGap: number;
  /** Start fraction on the elastic axis [0,1]. */
  fracStart: number;
  /** End fraction on the elastic axis [0,1]. */
  fracEnd: number;
}

export interface ElasticScale {
  /** Map any timestamp to [0,1] on the elastic axis. Clamped. */
  frac: (t: number) => number;
  /** Break markers where idle gaps were compressed. */
  breaks: ElasticScaleBreak[];
  /** Earliest event timestamp (left edge). */
  start: number;
  /** Latest event timestamp (right edge). */
  end: number;
  /** Total virtual width units (internal, exposed for tests). */
  totalVirtual: number;
}

export interface ElasticScaleOptions {
  /** Gaps longer than this are compressed. Default 30 minutes. */
  idleMs?: number;
  /** Compressed gap width as a fraction of idleMs. Default 0.08. */
  compressedRatio?: number;
}

const DEFAULT_IDLE_MS = 30 * 60_000; // 30 minutes
const DEFAULT_COMPRESSED_RATIO = 0.08;

interface Segment {
  from: number;
  to: number;
  realDelta: number;
  virtualDelta: number;
  startVirtual: number;
}

/**
 * Build an elastic scale from a list of event timestamps.
 *
 * Segments between consecutive events that exceed `idleMs` are compressed
 * to a small fixed width. Everything else preserves real proportional spacing.
 */
export function buildElasticScale(
  allTimes: number[],
  options: ElasticScaleOptions = {},
): ElasticScale {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const compressedRatio = options.compressedRatio ?? DEFAULT_COMPRESSED_RATIO;

  if (allTimes.length === 0) {
    return { frac: () => 0, breaks: [], start: 0, end: 0, totalVirtual: 0 };
  }

  const sorted = Array.from(new Set(allTimes)).sort((a, b) => a - b);
  const start = sorted[0];
  const end = sorted[sorted.length - 1];

  if (sorted.length === 1) {
    return { frac: () => 0.5, breaks: [], start, end, totalVirtual: 1 };
  }

  // Build segments between consecutive unique event times
  const segments: Segment[] = [];
  const breaks: ElasticScaleBreak[] = [];
  let totalVirtual = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const realDelta = sorted[i + 1] - sorted[i];
    const compressed = realDelta > idleMs;
    const virtualDelta = compressed ? idleMs * compressedRatio : realDelta;

    segments.push({
      from: sorted[i],
      to: sorted[i + 1],
      realDelta,
      virtualDelta,
      startVirtual: totalVirtual,
    });

    if (compressed) {
      breaks.push({
        afterTime: sorted[i],
        beforeTime: sorted[i + 1],
        realGap: realDelta,
        fracStart: 0, // filled below
        fracEnd: 0,
      });
    }

    totalVirtual += virtualDelta;
  }

  // Fill break fractional positions
  let breakIdx = 0;
  for (const seg of segments) {
    if (breakIdx < breaks.length && breaks[breakIdx].afterTime === seg.from) {
      breaks[breakIdx].fracStart = seg.startVirtual / totalVirtual;
      breaks[breakIdx].fracEnd = (seg.startVirtual + seg.virtualDelta) / totalVirtual;
      breakIdx++;
    }
  }

  function frac(t: number): number {
    if (t <= start) return 0;
    if (t >= end) return 1;
    // Binary search for the segment containing t
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const seg = segments[mid];
      if (t < seg.from) {
        hi = mid - 1;
      } else if (t > seg.to) {
        lo = mid + 1;
      } else {
        // t is in this segment
        const progress = (t - seg.from) / seg.realDelta;
        const virtualPos = seg.startVirtual + progress * seg.virtualDelta;
        return virtualPos / totalVirtual;
      }
    }
    // Shouldn't reach here for valid input, but fallback
    return 1;
  }

  return { frac, breaks, start, end, totalVirtual };
}

// ── Chip layout / collision detection ─────────────────────────────────────────

export interface ChipInput {
  at: number;
  /** Unique key for React rendering. */
  key: string;
  /** Optional pre-measured width in px. Uses default if not provided. */
  width?: number;
}

export interface ChipLayout {
  key: string;
  /** Horizontal pixel offset (left edge of chip). */
  x: number;
  /** Row index (0 = first row, 1 = overflow row, ...). */
  row: number;
}

export interface LayoutChipsOptions {
  /** Track width in pixels. */
  trackWidth: number;
  /** Default chip width when not measured. */
  chipWidth?: number;
  /** Minimum horizontal gap between chips (px). */
  gap?: number;
}

const DEFAULT_CHIP_WIDTH = 200;
const DEFAULT_GAP = 6;

/**
 * Given chips with fractional positions from an elastic scale, compute pixel
 * x-offsets and row assignments using a greedy scan-line algorithm.
 *
 * Chips are center-aligned on their time point: x = frac * trackWidth - chipWidth/2,
 * clamped to [0, trackWidth - chipWidth].
 */
export function layoutChips(
  chips: ChipInput[],
  scale: ElasticScale,
  options: LayoutChipsOptions,
): ChipLayout[] {
  const { trackWidth, chipWidth = DEFAULT_CHIP_WIDTH, gap = DEFAULT_GAP } = options;

  if (chips.length === 0) return [];

  // Compute x positions and sort by x
  const positioned = chips.map((c) => {
    const f = scale.frac(c.at);
    const cw = c.width ?? chipWidth;
    // Center on time point, then clamp within track bounds
    const rawX = f * trackWidth - cw / 2;
    const x = Math.max(0, Math.min(trackWidth - cw, rawX));
    return { key: c.key, x, width: cw };
  });

  positioned.sort((a, b) => a.x - b.x);

  // Greedy scan-line: assign rows
  // Each row tracks the rightmost occupied x-end
  const rowEnds: number[] = [];
  const results: ChipLayout[] = [];

  for (const chip of positioned) {
    let placed = false;
    for (let row = 0; row < rowEnds.length; row++) {
      if (chip.x >= rowEnds[row] + gap) {
        rowEnds[row] = chip.x + chip.width;
        results.push({ key: chip.key, x: chip.x, row });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const row = rowEnds.length;
      rowEnds.push(chip.x + chip.width);
      results.push({ key: chip.key, x: chip.x, row });
    }
  }

  return results;
}

// ── Axis label formatting ─────────────────────────────────────────────────────

/** Format a timestamp for axis display, adapting to span length. */
export function formatAxisLabel(at: number, span: number): string {
  const d = new Date(at);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const DAY_MS = 86_400_000;
  if (span < DAY_MS) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** Format a gap duration for break markers. */
export function formatGap(ms: number): string {
  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const MIN_MS = 60_000;
  if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(1)}d`;
  if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
  return `${Math.round(ms / MIN_MS)}min`;
}
