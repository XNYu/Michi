import { useRef, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { hasCjkText, performanceNowMs, rendererStreamProbeEnabled, writeRendererStreamProbe } from '../lib/streamProbe';

const ASSUMED_FRAME_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = 100;
const INITIAL_BUFFER_MS = 120;
const TARGET_BUFFER_MS = 120;
const MAX_TYPEWRITER_CPS = 600;
const RATE_EMA_ALPHA = 0.28;
const FALLBACK_BOOTSTRAP_CPS = 30;
const BACKGROUND_STALL_SNAP_MS = 1000;
const BURST_GAP_MS = 200;
const MIN_CONTINUOUS_SAMPLE_MS = 8;
type FrameHandle = number | ReturnType<typeof globalThis.setTimeout>;

// --- Diagnostic logging ---
// Enable by running in DevTools: localStorage.setItem('michi:smooth-diag', '1')
// Disable: localStorage.removeItem('michi:smooth-diag')
// No caching — reads live so you can toggle mid-session without refresh.
function smoothDiagEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('michi:smooth-diag') === '1';
  } catch { return false; }
}
let _lastDiagLogAt = 0;

export type StreamSmoothingProfile = 'default' | 'kiro' | 'claude';

type SmoothConfigName = 'default' | 'kiro' | 'kiro-cjk' | 'claude';

interface SmoothConfig {
  name: SmoothConfigName;
  initialBufferMs: number;
  resumeBufferMs: number;
  targetLagMs: number;
  finishLagMs: number;
  minTypewriterCps: number;
  maxTypewriterCps: number;
}

const DEFAULT_SMOOTH_CONFIG: SmoothConfig = {
  name: 'default',
  initialBufferMs: INITIAL_BUFFER_MS,
  resumeBufferMs: INITIAL_BUFFER_MS,
  targetLagMs: TARGET_BUFFER_MS,
  finishLagMs: 80,
  minTypewriterCps: 0,
  maxTypewriterCps: MAX_TYPEWRITER_CPS,
};

const KIRO_SMOOTH_CONFIG: SmoothConfig = {
  name: 'kiro',
  // Kiro ACP commonly arrives as small 100ms micro-bursts. Hold only the first
  // burst, then keep a thicker backlog and avoid repeatedly re-buffering after
  // the typewriter catches up to an empty queue.
  initialBufferMs: 220,
  resumeBufferMs: 0,
  targetLagMs: 500,
  finishLagMs: 160,
  minTypewriterCps: 8,
  maxTypewriterCps: 1200,
};

const KIRO_CJK_SMOOTH_CONFIG: SmoothConfig = {
  name: 'kiro-cjk',
  // Kiro CJK currently arrives as sparse ~0.7-1.7s bursts. Hold a short
  // post-gap window so the burst can accumulate, then use the backlog size
  // itself to keep visible lag around 0.5s. Huge bursts are allowed to catch
  // up very quickly instead of dragging out for many seconds.
  initialBufferMs: 160,
  resumeBufferMs: 120,
  targetLagMs: 500,
  finishLagMs: 140,
  minTypewriterCps: 8,
  maxTypewriterCps: Number.POSITIVE_INFINITY,
};

const CLAUDE_SMOOTH_CONFIG: SmoothConfig = {
  name: 'claude',
  // Bedrock Cross-Region Streaming flushes ~16 events every ~950ms.
  // The shared hybrid leaky controller replaces the proportional formula.
  // That formula (cps = backlog/T) decays exponentially within each burst
  // cycle, causing visible speed oscillation (fast→slow→fast). The leaky controller keeps
  // a near-constant release rate with a weak correction term for stability.
  initialBufferMs: 250,
  resumeBufferMs: 0,       // no re-buffer pauses — leaky controller handles gaps
  targetLagMs: 1050,       // fallback for cold-start before throughput EMA stabilizes
  finishLagMs: 80,
  minTypewriterCps: 8,
  maxTypewriterCps: 1200,
};

/**
 * Runtime-tuned parameters for the shared hybrid leaky controller.
 *
 * Steady-state output uses a leaky constant-rate controller. When backlog is
 * far above the desired buffer, a blended proportional overdrive catches up
 * large bursts without bringing proportional slowdown into the visible tail.
 *
 * - throughputEma: observed steady-state arrival rate (graphemes/sec), EMA-tracked
 * - targetBacklog: ideal buffer level = throughputEma × targetLagMs / 1000
 * - correctionTau: time constant for buffer correction (higher = smoother)
 *
 * This keeps normal output close to constant speed while preserving Kiro CJK's
 * ability to drain unusually large bursts quickly.
 */
interface LeakyControllerConfig {
  correctionTauMs: number;
  throughputEmaAlpha: number;
  minBurstsForLeaky: number;
  minContinuousSamplesForLeaky: number;
  minCpsFraction: number;
  overdriveBacklogMultiplier: number;
  minOverdriveBacklog: number;
}

const LEAKY_CONTROLLER_CONFIGS: Record<SmoothConfigName, LeakyControllerConfig> = {
  default: {
    correctionTauMs: 2000,
    throughputEmaAlpha: 0.2,
    minBurstsForLeaky: 2,
    minContinuousSamplesForLeaky: 3,
    minCpsFraction: 0.75,
    overdriveBacklogMultiplier: 3,
    minOverdriveBacklog: 24,
  },
  kiro: {
    correctionTauMs: 3000,
    throughputEmaAlpha: 0.18,
    minBurstsForLeaky: 2,
    minContinuousSamplesForLeaky: 3,
    minCpsFraction: 0.7,
    overdriveBacklogMultiplier: 2.5,
    minOverdriveBacklog: 24,
  },
  'kiro-cjk': {
    correctionTauMs: 2500,
    throughputEmaAlpha: 0.18,
    minBurstsForLeaky: 2,
    minContinuousSamplesForLeaky: 3,
    minCpsFraction: 0.7,
    overdriveBacklogMultiplier: 2,
    minOverdriveBacklog: 20,
  },
  claude: {
    correctionTauMs: 5000,
    throughputEmaAlpha: 0.15,
    minBurstsForLeaky: 2,
    minContinuousSamplesForLeaky: 3,
    minCpsFraction: 0.7,
    overdriveBacklogMultiplier: 2.5,
    minOverdriveBacklog: 64,
  },
};

function configForProfile(profile: StreamSmoothingProfile, source: string): SmoothConfig {
  if (profile === 'claude') return CLAUDE_SMOOTH_CONFIG;
  if (profile === 'kiro') {
    return hasCjkText(source) ? KIRO_CJK_SMOOTH_CONFIG : KIRO_SMOOTH_CONFIG;
  }
  return DEFAULT_SMOOTH_CONFIG;
}

export function smoothingProfileForRuntime(runtimeId?: string | null): StreamSmoothingProfile {
  if (runtimeId === 'claude') return 'claude';
  if (runtimeId === 'kiro') return 'kiro';
  return 'default';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function nowMs(): number {
  return performanceNowMs();
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function segmentGraphemes(text: string): number[] {
  const segmenterCtor = typeof Intl !== 'undefined'
    ? (Intl as typeof Intl & { Segmenter?: new (...args: any[]) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter
    : undefined;
  const boundaries: number[] = [];
  if (segmenterCtor) {
    let offset = 0;
    const segmenter = new segmenterCtor(undefined, { granularity: 'grapheme' });
    for (const item of segmenter.segment(text)) {
      offset += item.segment.length;
      boundaries.push(offset);
    }
    return boundaries;
  }
  let offset = 0;
  for (const char of Array.from(text)) {
    offset += char.length;
    boundaries.push(offset);
  }
  return boundaries;
}

const REWIND_GRAPHEMES = 8; // re-segment a small trailing window so a grapheme
                            // cluster split across the prev/tail boundary (ZWJ
                            // emoji, combining marks) is never miscounted. Any
                            // single Unicode grapheme cluster, when truncated,
                            // yields at most ~2 wrong boundary entries under
                            // Intl.Segmenter (UAX #29), so 8 is conservatively
                            // safe.

/**
 * Incrementally extend a grapheme-boundary array. `source` usually grows as a
 * monotonic prefix of itself across streamed frames, so we re-segment only the
 * appended tail plus a short rewind window. Falls back to a full segmentation
 * when `source` is not an extension of `prev.source` (e.g. sentinel stripping
 * retracted the visible prefix).
 */
export function segmentGraphemesIncremental(
  prev: { source: string; boundaries: readonly number[] },
  source: string,
): number[] {
  if (prev.source.length === 0 || !source.startsWith(prev.source)) {
    return segmentGraphemes(source);
  }
  const keep = Math.max(0, prev.boundaries.length - REWIND_GRAPHEMES);
  const rewindOffset = keep === 0 ? 0 : prev.boundaries[keep - 1];
  const tailBoundaries = segmentGraphemes(source.slice(rewindOffset));
  const out = prev.boundaries.slice(0, keep);
  for (const b of tailBoundaries) out.push(b + rewindOffset);
  return out;
}

function displayedGraphemeCount(boundaries: readonly number[], displayedLength: number): number {
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (boundaries[mid] <= displayedLength) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nextTypewriterCps(
  _agentCps: number,
  backlogChars: number,
  opts?: {
    targetLagMs?: number;
    finishLagMs?: number;
    streaming?: boolean;
    minTypewriterCps?: number;
    maxTypewriterCps?: number;
  },
): number {
  const maxTypewriterCps = opts?.maxTypewriterCps ?? MAX_TYPEWRITER_CPS;
  if (backlogChars <= 0) return 0;

  const targetLagMs = Math.max(1, opts?.targetLagMs ?? TARGET_BUFFER_MS);
  const finishLagMs = Math.max(1, opts?.finishLagMs ?? Math.min(targetLagMs, 160));
  const lagMs = opts?.streaming === false ? finishLagMs : targetLagMs;
  const minTypewriterCps = opts?.minTypewriterCps ?? 0;

  // Backlog-delay controller: reveal fast enough that the current visible
  // backlog represents roughly `lagMs` of output. In steady state this
  // naturally matches the upstream arrival rate; on large bursts it overdrives
  // instead of letting the UI trail many seconds behind.
  const lagDrivenCps = (backlogChars * 1000) / lagMs;
  return clamp(lagDrivenCps, minTypewriterCps, maxTypewriterCps);
}

export function nextHybridTypewriterCps(
  baseCps: number,
  backlogChars: number,
  opts: {
    targetLagMs: number;
    finishLagMs: number;
    streaming: boolean;
    minTypewriterCps: number;
    maxTypewriterCps: number;
    correctionTauMs: number;
    minCpsFraction: number;
    overdriveBacklogMultiplier: number;
    minOverdriveBacklog: number;
  },
): number {
  if (backlogChars <= 0) return 0;
  if (baseCps <= 0) {
    return nextTypewriterCps(baseCps, backlogChars, opts);
  }

  const targetBacklog = Math.max(1, baseCps * opts.targetLagMs / 1000);
  const overdriveStart = Math.max(
    opts.minOverdriveBacklog,
    targetBacklog * opts.overdriveBacklogMultiplier,
  );
  const proportionalCps = (backlogChars * 1000) /
    Math.max(1, opts.streaming ? opts.targetLagMs : opts.finishLagMs);

  let steadyCps: number;
  if (opts.streaming) {
    const correction = (backlogChars - targetBacklog) / opts.correctionTauMs * 1000;
    const minCps = Math.max(opts.minTypewriterCps, baseCps * opts.minCpsFraction);
    steadyCps = clamp(baseCps + correction, minCps, opts.maxTypewriterCps);
  } else {
    // Segment/end-of-turn drain: accelerate up to 2× the learned rate, but keep
    // the learned rate as a floor so the final few graphemes do not decelerate.
    steadyCps = clamp(
      Math.max(baseCps, Math.min(baseCps * 2, proportionalCps)),
      opts.minTypewriterCps,
      opts.maxTypewriterCps,
    );
  }

  // Blend into proportional catch-up only when backlog is materially above the
  // target. The blend removes the abrupt speed step at the overdrive boundary.
  const overdriveWeight = clamp(
    (backlogChars - overdriveStart) / Math.max(1, overdriveStart),
    0,
    1,
  );
  const overdriveCps = Math.max(steadyCps, proportionalCps);
  return clamp(
    steadyCps + (overdriveCps - steadyCps) * overdriveWeight,
    opts.minTypewriterCps,
    opts.maxTypewriterCps,
  );
}

function requestFrame(cb: FrameRequestCallback): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(cb);
  }
  return globalThis.setTimeout(() => cb(Date.now()), ASSUMED_FRAME_MS);
}

function cancelFrame(id: FrameHandle): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id);
}

/**
 * Smooths bursty streaming text into a typewriter-style visual flow.
 *
 * `source` is the full accumulated text (grows monotonically with each chunk).
 * `streaming` indicates whether new text is still arriving.
 *
 * Returns `displayed` — a prefix of `source` that grows one grapheme at a
 * time, plus `isSmoothing` (still catching up to source).
 *
 * The scheduler holds a tiny initial buffer, estimates the agent's arrival
 * rate from source growth, and then reveals at roughly that rate while keeping
 * a small backlog so bursty chunks still look continuous.
 */
export function useSmooth(
  source: string,
  streaming: boolean,
  profile: StreamSmoothingProfile = 'default',
): { displayed: string; isSmoothing: boolean } {
  const config = configForProfile(profile, source);
  const configRef = useRef(config);
  const profileRef = useRef(profile);
  const streamingRef = useRef(streaming);
  const probeIdRef = useRef<string | null>(null);
  const [displayed, setDisplayed] = useState(source);
  const displayedRef = useRef(source);
  const sourceRef = useRef(source);
  const segCacheRef = useRef<{ source: string; boundaries: number[] }>({ source: '', boundaries: [] });
  const boundariesRef = useRef<number[]>([]);
  const cursorRef = useRef(0);
  const sourceCountRef = useRef(0);
  const sourceCharCountRef = useRef(source.length);
  // A message that mounts already complete is fully visible and will never
  // enter the typewriter loop unless its source later grows. Avoid building
  // and retaining one grapheme boundary per character for that common path.
  const shouldSegment =
    streaming || displayedRef.current !== source || segCacheRef.current.source.length > 0;
  const sourceBoundaries = useMemo(
    () => shouldSegment ? segmentGraphemesIncremental(segCacheRef.current, source) : [],
    [shouldSegment, source],
  );
  if (
    shouldSegment &&
    segCacheRef.current.source.length === 0 &&
    boundariesRef.current.length === 0
  ) {
    // Segmentation was deferred on mount. Reconstruct the cursor from the
    // text already on screen before processing any appended streaming tail.
    const displayedCount = displayedGraphemeCount(sourceBoundaries, displayedRef.current.length);
    cursorRef.current = displayedCount;
    sourceCountRef.current = displayedCount;
    sourceCharCountRef.current = displayedRef.current.length;
  }
  useLayoutEffect(() => {
    if (!shouldSegment) return;
    segCacheRef.current = { source, boundaries: sourceBoundaries };
  }, [source, sourceBoundaries, shouldSegment]);
  const frameRef = useRef<FrameHandle | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const budgetRef = useRef(0);
  const firstBufferedAtRef = useRef<number | null>(null);
  const activeBufferWindowMsRef = useRef(config.initialBufferMs);
  const lastArrivalAtRef = useRef<number | null>(null);
  const lastSourceProbeAtRef = useRef<number | null>(null);
  const lastDisplayProbeAtRef = useRef<number | null>(null);
  const lastStallProbeAtRef = useRef<number | null>(null);
  const agentCpsRef = useRef(0);
  const hasRateEstimateRef = useRef(false);
  const isBackgroundedRef = useRef(false);
  const wasBackgroundedRef = useRef(false);

  // Hybrid leaky-controller throughput state.
  const throughputEmaRef = useRef(0);       // graphemes/sec, EMA of sustained throughput
  const burstCountRef = useRef(0);          // number of bursts observed (for cold-start gate)
  const continuousRateSamplesRef = useRef(0); // stable sub-200ms arrival samples
  const leakyReadyRef = useRef(false);      // sticky across tool-call segment gaps
  const totalGraphemesRef = useRef(0);      // total graphemes received since streaming start
  const streamStartAtRef = useRef<number | null>(null); // when streaming started
  const lastBurstAtRef = useRef<number | null>(null);   // timestamp of previous burst boundary
  const graphemesAtLastBurstRef = useRef(0);            // totalGraphemes at last burst boundary

  configRef.current = config;
  profileRef.current = profile;
  streamingRef.current = streaming;
  sourceRef.current = source;
  boundariesRef.current = sourceBoundaries;

  function writeSmoothProbe(phase: string, row: Record<string, unknown> = {}) {
    if (!rendererStreamProbeEnabled()) return;
    if (probeIdRef.current === null) {
      probeIdRef.current = `smooth-${Math.random().toString(36).slice(2, 8)}`;
    }
    const cfg = configRef.current;
    const src = sourceRef.current;
    const boundaries = boundariesRef.current;
    const displayedGraphemes = cursorRef.current;
    writeRendererStreamProbe({
      phase,
      subsystem: 'smooth',
      probeId: probeIdRef.current,
      profile: profileRef.current,
      smoothProfile: cfg.name,
      streaming: streamingRef.current,
      cjk: hasCjkText(src),
      sourceChars: src.length,
      sourceGraphemes: boundaries.length,
      displayedGraphemes,
      backlogGraphemes: Math.max(0, boundaries.length - displayedGraphemes),
      agentCps: Math.round(agentCpsRef.current * 10) / 10,
      hasRateEstimate: hasRateEstimateRef.current,
      ...row,
    });
  }

  function maybeWriteSmoothStall(timestamp: number, reason: string, row: Record<string, unknown> = {}) {
    if (!rendererStreamProbeEnabled()) return;
    const lastDisplayAt = lastDisplayProbeAtRef.current ?? firstBufferedAtRef.current ?? timestamp;
    const displayGapMs = timestamp - lastDisplayAt;
    if (displayGapMs < 250) return;
    const lastStallAt = lastStallProbeAtRef.current;
    if (lastStallAt !== null && timestamp - lastStallAt < 250) return;
    lastStallProbeAtRef.current = timestamp;
    writeSmoothProbe('smooth_stall', {
      reason,
      displayGapMs: Math.round(displayGapMs),
      ...row,
    });
  }

  function stopFrame() {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
    lastFrameAtRef.current = null;
    budgetRef.current = 0;
  }

  function resetArrivalTracking() {
    firstBufferedAtRef.current = null;
    activeBufferWindowMsRef.current = configRef.current.initialBufferMs;
    lastArrivalAtRef.current = null;
    agentCpsRef.current = 0;
    hasRateEstimateRef.current = false;
    // Reset leaky controller state
    throughputEmaRef.current = 0;
    burstCountRef.current = 0;
    continuousRateSamplesRef.current = 0;
    leakyReadyRef.current = false;
    totalGraphemesRef.current = 0;
    streamStartAtRef.current = null;
    lastBurstAtRef.current = null;
    graphemesAtLastBurstRef.current = 0;
  }

  function snapToSource(reason = 'snap_to_source', row: Record<string, unknown> = {}) {
    const src = sourceRef.current;
    const boundaries = boundariesRef.current;
    writeSmoothProbe('smooth_snap', { reason, ...row });
    stopFrame();
    cursorRef.current = boundaries.length;
    sourceCountRef.current = boundaries.length;
    sourceCharCountRef.current = src.length;
    displayedRef.current = src;
    setDisplayed((cur) => (cur === src ? cur : src));
    resetArrivalTracking();
  }

  function startFrame() {
    if (frameRef.current !== null) return;
    frameRef.current = requestFrame(tick);
  }

  function revealOne(): boolean {
    const boundaries = boundariesRef.current;
    const src = sourceRef.current;
    if (cursorRef.current >= boundaries.length) return false;
    cursorRef.current += 1;
    const nextOffset = boundaries[cursorRef.current - 1] ?? src.length;
    const nextDisplayed = src.slice(0, nextOffset);
    displayedRef.current = nextDisplayed;
    return true;
  }

  function flushDisplayed() {
    const next = displayedRef.current;
    setDisplayed((cur) => (cur === next ? cur : next));
  }

  function tick(timestamp: number) {
    frameRef.current = null;

    const boundaries = boundariesRef.current;
    if (cursorRef.current >= boundaries.length) {
      lastFrameAtRef.current = null;
      budgetRef.current = 0;
      firstBufferedAtRef.current = null;
      return;
    }

    const previousFrameAt = lastFrameAtRef.current;
    const rawElapsedMs = previousFrameAt === null
      ? ASSUMED_FRAME_MS
      : Math.max(0, timestamp - previousFrameAt);
    lastFrameAtRef.current = timestamp;
    if (previousFrameAt !== null && rawElapsedMs > BACKGROUND_STALL_SNAP_MS) {
      snapToSource('frame_stall', { rawElapsedMs: Math.round(rawElapsedMs) });
      return;
    }

    const firstBufferedAt = firstBufferedAtRef.current;
    if (firstBufferedAt !== null && timestamp - firstBufferedAt < activeBufferWindowMsRef.current) {
      if (rendererStreamProbeEnabled()) {
        maybeWriteSmoothStall(timestamp, 'buffer_wait', {
          bufferWindowMs: activeBufferWindowMsRef.current,
          remainingBufferMs: Math.round(activeBufferWindowMsRef.current - (timestamp - firstBufferedAt)),
        });
      }
      startFrame();
      return;
    }

    const backlog = boundaries.length - cursorRef.current;
    const backlogBefore = backlog;

    // First post-buffer frame: bootstrap agentCps from observed buffer fill.
    // Backlog graphemes accumulated over the initial buffer window approximate
    // the live agent rate.
    if (firstBufferedAt !== null && !hasRateEstimateRef.current) {
      const observedWindowMs = Math.max(1, activeBufferWindowMsRef.current);
      const observedCps = (backlog * 1000) / observedWindowMs;
      agentCpsRef.current = clamp(observedCps, 0, configRef.current.maxTypewriterCps);
      hasRateEstimateRef.current = true;
      firstBufferedAtRef.current = null;
    }

    const cfg = configRef.current;
    const effectiveAgentCps = hasRateEstimateRef.current
      ? agentCpsRef.current
      : FALLBACK_BOOTSTRAP_CPS;

    // Use the shared hybrid leaky controller after either burst-average or
    // continuous-arrival throughput has stabilized. Cold-start stays on the
    // proportional controller so one sparse burst is never mistaken for CPS.
    let cps: number;
    const leakyCfg = LEAKY_CONTROLLER_CONFIGS[cfg.name];
    const burstRateStable = burstCountRef.current >= leakyCfg.minBurstsForLeaky
      && throughputEmaRef.current > 0;
    const continuousRateStable = continuousRateSamplesRef.current >= leakyCfg.minContinuousSamplesForLeaky
      && agentCpsRef.current > 0;
    if (burstRateStable || continuousRateStable) leakyReadyRef.current = true;
    const useLeakyController = leakyReadyRef.current
      && (throughputEmaRef.current > 0 || agentCpsRef.current > 0);

    if (useLeakyController) {
      const baseCps = burstRateStable || agentCpsRef.current <= 0
        ? throughputEmaRef.current
        : agentCpsRef.current;
      cps = nextHybridTypewriterCps(baseCps, backlog, {
        targetLagMs: cfg.targetLagMs,
        finishLagMs: cfg.finishLagMs,
        streaming: streamingRef.current,
        minTypewriterCps: cfg.minTypewriterCps,
        maxTypewriterCps: cfg.maxTypewriterCps,
        correctionTauMs: leakyCfg.correctionTauMs,
        minCpsFraction: leakyCfg.minCpsFraction,
        overdriveBacklogMultiplier: leakyCfg.overdriveBacklogMultiplier,
        minOverdriveBacklog: leakyCfg.minOverdriveBacklog,
      });
    } else {
      cps = nextTypewriterCps(effectiveAgentCps, backlog, {
        targetLagMs: cfg.targetLagMs,
        finishLagMs: cfg.finishLagMs,
        streaming: streamingRef.current,
        minTypewriterCps: cfg.minTypewriterCps,
        maxTypewriterCps: cfg.maxTypewriterCps,
      });
    }
    const elapsedMs = Math.min(rawElapsedMs, MAX_FRAME_DELTA_MS);

    budgetRef.current += cps * (elapsedMs / 1000);

    const cursorBefore = cursorRef.current;
    while (budgetRef.current >= 1) {
      budgetRef.current -= 1;
      if (!revealOne()) {
        budgetRef.current = 0;
        break;
      }
    }

    flushDisplayed();
    const displayedDeltaGraphemes = cursorRef.current - cursorBefore;

    // --- Diagnostic console log (5Hz) ---
    if (smoothDiagEnabled() && timestamp - _lastDiagLogAt > 200) {
      _lastDiagLogAt = timestamp;
      const backlogNow = Math.max(0, boundaries.length - cursorRef.current);
      const lagEstMs = cps > 0 ? Math.round((backlogNow / cps) * 1000) : (backlogNow > 0 ? 9999 : 0);
      const state = backlogNow === 0
        ? (streamingRef.current ? 'CAUGHT_UP' : 'IDLE')
        : (displayedDeltaGraphemes === 0 ? 'BUFFERING' : 'DRAINING');
      const controllerType = useLeakyController ? 'HYBRID_LEAKY' : 'PROPORTIONAL';
      // eslint-disable-next-line no-console
      console.log(
        `[SMOOTH] cps=${Math.round(cps)} backlog=${backlogNow} ` +
        `source=${boundaries.length} displayed=${cursorRef.current} ` +
        `lagEst=${lagEstMs}ms state=${state} ` +
        `profile=${configRef.current.name} controller=${controllerType} ` +
        `throughputEma=${Math.round(throughputEmaRef.current)} ` +
        `agentCps=${Math.round(agentCpsRef.current)} ` +
        `budget=${budgetRef.current.toFixed(2)} ` +
        `elapsedMs=${Math.round(elapsedMs)} revealed=${displayedDeltaGraphemes}`,
      );
    }

    if (displayedDeltaGraphemes > 0) {
      if (rendererStreamProbeEnabled()) {
        const lastDisplayAt = lastDisplayProbeAtRef.current;
        writeSmoothProbe('smooth_display', {
          displayedDeltaGraphemes,
          dtMs: lastDisplayAt === null ? 0 : Math.round(timestamp - lastDisplayAt),
          rawElapsedMs: Math.round(rawElapsedMs),
          elapsedMs: Math.round(elapsedMs),
          cps: Math.round(cps * 10) / 10,
          budget: Math.round(budgetRef.current * 100) / 100,
          backlogBefore,
          backlogAfter: Math.max(0, boundariesRef.current.length - cursorRef.current),
        });
        lastDisplayProbeAtRef.current = timestamp;
      }
    } else if (backlogBefore > 0) {
      if (rendererStreamProbeEnabled()) {
        maybeWriteSmoothStall(timestamp, 'no_display_budget', {
          rawElapsedMs: Math.round(rawElapsedMs),
          elapsedMs: Math.round(elapsedMs),
          cps: Math.round(cps * 10) / 10,
          budget: Math.round(budgetRef.current * 100) / 100,
          backlogBefore,
        });
      }
    }

    if (cursorRef.current < boundariesRef.current.length) {
      startFrame();
    } else {
      lastFrameAtRef.current = null;
      budgetRef.current = 0;
      firstBufferedAtRef.current = null;
      // --- Diagnostic: buffer exhausted ---
      if (smoothDiagEnabled() && streamingRef.current) {
        // eslint-disable-next-line no-console
        console.warn(
          `[SMOOTH:EMPTY] Buffer exhausted while streaming! ` +
          `profile=${configRef.current.name} agentCps=${Math.round(agentCpsRef.current)} ` +
          `This is the stall the user sees.`,
        );
      }
    }
  }

  // Start/stop the drain loop based on streaming state.
  useEffect(() => {
    if (!streaming) {
      if (cursorRef.current < boundariesRef.current.length) {
        startFrame();
      } else {
        stopFrame();
      }
      return;
    }
    if (cursorRef.current < boundariesRef.current.length) startFrame();
    return stopFrame;
  }, [streaming, profile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register visibility/focus listeners only while the smoothing loop is
  // active (streaming or draining). Completed messages skip registration
  // entirely, avoiding hundreds of redundant listeners in long threads.
  useEffect(() => {
    if (!streaming && cursorRef.current >= boundariesRef.current.length) {
      return; // fully displayed — no listener needed
    }

    const markBackgrounded = () => {
      isBackgroundedRef.current = true;
      wasBackgroundedRef.current = true;
      snapToSource('window_backgrounded');
    };
    const markForegrounded = () => {
      if (isDocumentHidden()) return;
      isBackgroundedRef.current = false;
      if (wasBackgroundedRef.current) snapToSource('window_foregrounded');
    };
    const onVisibilityChange = () => {
      if (isDocumentHidden()) markBackgrounded();
      else markForegrounded();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', markBackgrounded);
      window.addEventListener('focus', markForegrounded);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('blur', markBackgrounded);
        window.removeEventListener('focus', markForegrounded);
      }
    };
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // When new text arrives, estimate agent speed and ensure the frame loop runs.
  useEffect(() => {
    const boundaries = boundariesRef.current;
    const previousCount = sourceCountRef.current;
    const previousChars = sourceCharCountRef.current;
    const nextCount = boundaries.length;
    const nextChars = source.length;

    if (isDocumentHidden() || isBackgroundedRef.current || wasBackgroundedRef.current) {
      snapToSource('source_while_backgrounded');
      if (!isDocumentHidden() && !isBackgroundedRef.current) {
        wasBackgroundedRef.current = false;
      }
      return;
    }

    const wasCaughtUp = cursorRef.current >= previousCount;
    sourceCountRef.current = nextCount;
    sourceCharCountRef.current = nextChars;

    const delta = nextCount - previousCount;
    const deltaChars = nextChars - previousChars;
    if (rendererStreamProbeEnabled() && (delta !== 0 || deltaChars !== 0)) {
      const now = nowMs();
      const lastSourceAt = lastSourceProbeAtRef.current;
      writeSmoothProbe('smooth_source', {
        deltaGraphemes: delta,
        deltaChars,
        dtMs: lastSourceAt === null ? 0 : Math.round(now - lastSourceAt),
        wasCaughtUp,
        cursorBefore: cursorRef.current,
        sourceCountBefore: previousCount,
        sourceCharsBefore: previousChars,
      });
      lastSourceProbeAtRef.current = now;
    }

    if (!source.startsWith(displayedRef.current)) {
      writeSmoothProbe('smooth_reset', { reason: 'source_not_prefix' });
      cursorRef.current = nextCount;
      displayedRef.current = source;
      setDisplayed((cur) => (cur === source ? cur : source));
      resetArrivalTracking();
      return;
    }

    cursorRef.current = Math.min(
      cursorRef.current,
      displayedGraphemeCount(boundaries, displayedRef.current.length),
    );

    if (delta > 0) {
      const now = nowMs();
      const lastArrival = lastArrivalAtRef.current;

      // Track stream start time for throughput calculation
      if (streamStartAtRef.current === null) {
        streamStartAtRef.current = now;
      }
      totalGraphemesRef.current += delta;

      // --- Diagnostic: source arrival ---
      if (smoothDiagEnabled()) {
        const gapMs = lastArrival !== null ? Math.round(now - lastArrival) : 0;
        const backlogNow = Math.max(0, sourceBoundaries.length - cursorRef.current);
        if (gapMs > 200 || lastArrival === null) {
          // eslint-disable-next-line no-console
          console.log(
            `[SMOOTH:BURST] +${delta} graphemes after ${gapMs}ms gap. ` +
            `backlog=${backlogNow} wasCaughtUp=${wasCaughtUp} ` +
            `profile=${configRef.current.name} ` +
            `throughputEma=${Math.round(throughputEmaRef.current)} ` +
            `burstCount=${burstCountRef.current}`,
          );
        }
      }

      if (lastArrival !== null && hasRateEstimateRef.current) {
        const dt = now - lastArrival;
        if (dt > 0) {
          const instant = clamp((delta * 1000) / dt, 0, configRef.current.maxTypewriterCps);
          agentCpsRef.current =
            agentCpsRef.current * (1 - RATE_EMA_ALPHA) + instant * RATE_EMA_ALPHA;
        }

        if (dt >= MIN_CONTINUOUS_SAMPLE_MS && dt <= BURST_GAP_MS) {
          continuousRateSamplesRef.current += 1;
        } else if (dt > BURST_GAP_MS) {
          continuousRateSamplesRef.current = 0;
          burstCountRef.current += 1;
          // Calculate throughput from the interval between this burst and the last.
          // This responds quickly to burst-size changes (CJK vs ASCII, code vs prose)
          // instead of being anchored by the cold-start average.
          const lastBurstAt = lastBurstAtRef.current;
          if (lastBurstAt !== null) {
            const intervalMs = now - lastBurstAt;
            const intervalGraphemes = totalGraphemesRef.current - graphemesAtLastBurstRef.current;
            if (intervalMs > 100 && intervalGraphemes > 0) {
              const intervalThroughput = (intervalGraphemes * 1000) / intervalMs;
              const alpha = LEAKY_CONTROLLER_CONFIGS[configRef.current.name].throughputEmaAlpha;
              if (throughputEmaRef.current === 0) {
                throughputEmaRef.current = intervalThroughput;
              } else {
                throughputEmaRef.current =
                  throughputEmaRef.current * (1 - alpha) + intervalThroughput * alpha;
              }
            }
          }
          lastBurstAtRef.current = now;
          graphemesAtLastBurstRef.current = totalGraphemesRef.current;
        }
      }
      lastArrivalAtRef.current = now;
      if (wasCaughtUp && firstBufferedAtRef.current === null && cursorRef.current < nextCount) {
        const cfg = configRef.current;
        const windowMs = hasRateEstimateRef.current ? cfg.resumeBufferMs : cfg.initialBufferMs;
        activeBufferWindowMsRef.current = windowMs;
        firstBufferedAtRef.current = windowMs > 0 ? now : null;
        // --- Diagnostic: re-buffer triggered ---
        if (smoothDiagEnabled() && windowMs > 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[SMOOTH:REBUFFER] Caught up → re-buffering for ${windowMs}ms. ` +
            `This pauses display! profile=${cfg.name}`,
          );
        }
      }
    }

    if (cursorRef.current < nextCount) {
      startFrame();
    }
  }, [source, streaming, profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSmoothing = cursorRef.current < boundariesRef.current.length;
  return { displayed, isSmoothing };
}
