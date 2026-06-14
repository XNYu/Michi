export type MetricAttrs = Record<string, unknown>;

const SOURCE = "backend";
const METRICS_ENABLED = process.env.MICHI_METRICS === "1";
const PERF_ENABLED = process.env.MICHI_PERF === "1";
const STARTUP_ENABLED = process.env.MICHI_STARTUP_TRACE === "1";
const RUN_ID = process.env.MICHI_METRICS_RUN_ID || process.env.MICHI_STARTUP_RUN_ID || "";

const emittedOnce = new Set<string>();

export function enabled(): boolean {
    return METRICS_ENABLED;
}

export function perfEnabled(): boolean {
    return PERF_ENABLED;
}

export function startupEnabled(): boolean {
    return STARTUP_ENABLED;
}

export function runId(): string {
    return RUN_ID;
}

export function now(): number {
    return METRICS_ENABLED || PERF_ENABLED ? performance.now() : 0;
}

function writeJson(row: Record<string, unknown>): void {
    console.log(JSON.stringify(row));
}

function metricRow(kind: string, name: string, attrs?: MetricAttrs): Record<string, unknown> {
    return {
        type: "metric",
        runId: RUN_ID,
        source: SOURCE,
        kind,
        name,
        t: Date.now(),
        pid: process.pid,
        attrs: attrs ?? {},
    };
}

export function mark(name: string, attrs?: MetricAttrs): void {
    if (!METRICS_ENABLED) return;
    writeJson(metricRow("mark", name, attrs));
}

export function measure(name: string, startTime: number, attrs?: MetricAttrs): void {
    if (!METRICS_ENABLED) return;
    writeJson({
        ...metricRow("measure", name, attrs),
        durMs: Number((performance.now() - startTime).toFixed(1)),
    });
}

export function counter(name: string, value = 1, attrs?: MetricAttrs): void {
    if (!METRICS_ENABLED) return;
    writeJson({
        ...metricRow("counter", name, attrs),
        value,
    });
}

export function span<T>(name: string, attrs: MetricAttrs | undefined, fn: () => T): T {
    if (!METRICS_ENABLED) return fn();
    const start = performance.now();
    mark(`${name}.start`, attrs);
    try {
        const result = fn();
        const maybePromise = result as unknown as Promise<unknown>;
        if (result && typeof maybePromise.then === "function") {
            return maybePromise
                .then((value) => {
                    measure(name, start, { ...attrs, status: "ok" });
                    return value;
                })
                .catch((err) => {
                    measure(name, start, { ...attrs, status: "error", error: (err as Error).message });
                    throw err;
                }) as T;
        }
        measure(name, start, { ...attrs, status: "ok" });
        return result;
    } catch (err) {
        measure(name, start, { ...attrs, status: "error", error: (err as Error).message });
        throw err;
    }
}

export function startupMark(name: string, attrs?: MetricAttrs): void {
    if (!STARTUP_ENABLED) return;
    writeJson({
        type: "startup",
        runId: RUN_ID,
        source: SOURCE,
        name,
        t: Date.now(),
        pid: process.pid,
        ...attrs,
    });
}

export function startupMarkOnce(name: string, attrs?: MetricAttrs): void {
    if (!STARTUP_ENABLED) return;
    if (emittedOnce.has(name)) return;
    emittedOnce.add(name);
    startupMark(name, attrs);
}
