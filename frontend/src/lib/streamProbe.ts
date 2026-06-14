const STREAM_PROBE_KEYS = ['michi:stream-render-probe', 'michi:stream-probe'];
let cachedRendererStreamProbeEnabled: boolean | null = null;

export function performanceNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function rendererStreamProbeEnabled(): boolean {
  if (cachedRendererStreamProbeEnabled !== null) return cachedRendererStreamProbeEnabled;
  if (typeof window === 'undefined') return false;
  try {
    cachedRendererStreamProbeEnabled = STREAM_PROBE_KEYS.some((key) => window.localStorage.getItem(key) === '1');
    return cachedRendererStreamProbeEnabled;
  } catch {
    cachedRendererStreamProbeEnabled = false;
    return false;
  }
}

export function writeRendererStreamProbe(row: Record<string, unknown>): void {
  if (!rendererStreamProbeEnabled()) return;
  // Text content is intentionally excluded; log only cadence and sizes.
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ type: 'stream_probe', source: 'renderer', ...row }));
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function hasCjkText(text: string): boolean {
  return CJK_RE.test(text);
}
