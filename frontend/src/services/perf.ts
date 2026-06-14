/**
 * Frontend legacy perf instrumentation, mirroring backend/src/services/perf.ts.
 *
 * Enabled when either:
 *   - localStorage['michi:perf'] === '1'
 *   - import.meta.env.VITE_MICHI_PERF === '1'
 *
 * Output format (tagged for cross-process grep against the backend):
 *   [perf:<stage>] <durationMs>ms <key=value>*
 * or for a one-shot mark:
 *   [perf:<stage>] <key=value>*
 *
 * VITE_MICHI_METRICS=1 mirrors the same calls as structured JSONL metrics.
 * All helpers short-circuit to near-zero cost when disabled.
 */

import * as metrics from './metrics';

export function now(): number {
    return metrics.now();
}

function formatMeta(meta?: Record<string, unknown>): string {
    if (!meta) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        parts.push(`${k}=${s}`);
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

export function measure(stage: string, startTime: number, meta?: Record<string, unknown>): void {
    metrics.measure(stage, startTime, meta);
    if (!metrics.perfEnabled()) return;
    const dur = (performance.now() - startTime).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`[perf:${stage}] ${dur}ms${formatMeta(meta)}`);
}

export function mark(stage: string, meta?: Record<string, unknown>): void {
    metrics.mark(stage, meta);
    if (!metrics.perfEnabled()) return;
    // eslint-disable-next-line no-console
    console.log(`[perf:${stage}]${formatMeta(meta)}`);
}

export function enabled(): boolean {
    return metrics.perfEnabled() || metrics.enabled();
}
