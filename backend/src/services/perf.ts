/**
 * Lightweight perf instrumentation.
 *
 * Legacy text perf instrumentation. `MICHI_PERF=1` prints grep-friendly text;
 * `MICHI_METRICS=1` mirrors the same calls as structured JSONL metrics.
 * When both are disabled, every helper short-circuits to near-zero cost.
 *
 * Output format (tagged for easy grep):
 *   [perf:<stage>] <label> <durationMs>ms <key=value>*
 *
 * Typical usage:
 *   const t0 = perf.now();
 *   ... work ...
 *   perf.measure('acp:spawn', t0, { cwd });
 *
 * Or for a one-shot mark (no duration):
 *   perf.mark('acp:first_chunk', { chatId });
 */

import * as metrics from "./metrics";

/** High-resolution-ish timestamp (ms, float). Works even when MICHI_PERF is off — caller decides. */
export function now(): number {
    return metrics.now();
}

function formatMeta(meta?: Record<string, unknown>): string {
    if (!meta) return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(meta)) {
        if (v === undefined) continue;
        const s = typeof v === "string" ? v : JSON.stringify(v);
        parts.push(`${k}=${s}`);
    }
    return parts.length > 0 ? " " + parts.join(" ") : "";
}

/**
 * Record an elapsed duration. `startTime` should come from `perf.now()`.
 * No-op when perf is disabled.
 */
export function measure(
    stage: string,
    startTime: number,
    meta?: Record<string, unknown>,
): void {
    metrics.measure(stage, startTime, meta);
    if (!metrics.perfEnabled()) return;
    const dur = (performance.now() - startTime).toFixed(1);
    console.log(`[perf:${stage}] ${dur}ms${formatMeta(meta)}`);
}

/**
 * Record a one-shot event (no duration). Useful for "first chunk arrived at X".
 * No-op when perf is disabled.
 */
export function mark(stage: string, meta?: Record<string, unknown>): void {
    metrics.mark(stage, meta);
    if (!metrics.perfEnabled()) return;
    console.log(`[perf:${stage}]${formatMeta(meta)}`);
}

/** Whether perf logging is active. Prefer calling the functions above; this
 *  is only for cases where building the meta is itself expensive. */
export function enabled(): boolean {
    return metrics.perfEnabled() || metrics.enabled();
}
