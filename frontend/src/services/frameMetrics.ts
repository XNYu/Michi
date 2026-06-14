import * as metrics from './metrics';

function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

function readLocalStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env;
  } catch {
    return undefined;
  }
}

function frameMetricsEnabled(): boolean {
  const params = readSearchParams();
  const env = readEnv();
  return (
    metrics.enabled() &&
    (
      params?.get('frameMetrics') === '1' ||
      readLocalStorage('michi:frame-metrics') === '1' ||
      env?.VITE_MICHI_FRAME_METRICS === '1'
    )
  );
}

function frameWindowMs(): number {
  const env = readEnv();
  const raw =
    readSearchParams()?.get('frameMetricsWindowMs') ||
    readLocalStorage('michi:frame-metrics-window-ms') ||
    env?.VITE_MICHI_FRAME_METRICS_WINDOW_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 500 ? parsed : 2000;
}

export function startFrameMetrics(): (() => void) | null {
  if (!frameMetricsEnabled()) return null;
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return null;

  const windowMs = frameWindowMs();
  const targetFrameMs = 1000 / 60;
  let cancelled = false;
  let rafId = 0;
  let windowStart = performance.now();
  let lastFrame = windowStart;
  let frames = 0;
  let longFrames = 0;
  let droppedFrames = 0;
  let maxFrameMs = 0;

  const reset = (now: number) => {
    windowStart = now;
    lastFrame = now;
    frames = 0;
    longFrames = 0;
    droppedFrames = 0;
    maxFrameMs = 0;
  };

  const tick = (now: number) => {
    if (cancelled) return;
    const delta = now - lastFrame;
    lastFrame = now;
    frames += 1;
    maxFrameMs = Math.max(maxFrameMs, delta);
    if (delta >= 50) longFrames += 1;
    droppedFrames += Math.max(0, Math.round(delta / targetFrameMs) - 1);

    const elapsed = now - windowStart;
    if (elapsed >= windowMs) {
      const fps = frames * 1000 / elapsed;
      metrics.mark('frontend.frame_rate', {
        durMs: Math.round(elapsed),
        fps: Number(fps.toFixed(1)),
        frames,
        longFrames,
        droppedFrames,
        maxFrameMs: Number(maxFrameMs.toFixed(1)),
      });
      reset(now);
    }

    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    if (rafId) window.cancelAnimationFrame(rafId);
  };
}
