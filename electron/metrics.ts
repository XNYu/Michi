export type MetricAttrs = Record<string, unknown>;

const SOURCE = 'electron-main';
const GENERATED_RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ID = process.env.MICHI_METRICS_RUN_ID || process.env.MICHI_STARTUP_RUN_ID || GENERATED_RUN_ID;
const METRICS_ENABLED = process.env.MICHI_METRICS === '1';
const STARTUP_ENABLED = process.env.MICHI_STARTUP_TRACE === '1';

const emittedStartupOnce = new Set<string>();

if ((METRICS_ENABLED || STARTUP_ENABLED) && !process.env.MICHI_STARTUP_RUN_ID) {
  process.env.MICHI_STARTUP_RUN_ID = RUN_ID;
}

export function enabled(): boolean {
  return METRICS_ENABLED;
}

export function startupEnabled(): boolean {
  return STARTUP_ENABLED;
}

export function runId(): string {
  return RUN_ID;
}

export function now(): number {
  return METRICS_ENABLED ? performance.now() : 0;
}

function writeJson(row: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function metricRow(kind: string, name: string, attrs?: MetricAttrs): Record<string, unknown> {
  return {
    type: 'metric',
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
  writeJson(metricRow('mark', name, attrs));
}

export function measure(name: string, startTime: number, attrs?: MetricAttrs): void {
  if (!METRICS_ENABLED) return;
  writeJson({
    ...metricRow('measure', name, attrs),
    durMs: Number((performance.now() - startTime).toFixed(1)),
  });
}

export function counter(name: string, value = 1, attrs?: MetricAttrs): void {
  if (!METRICS_ENABLED) return;
  writeJson({
    ...metricRow('counter', name, attrs),
    value,
  });
}

export function startupMark(name: string, attrs?: MetricAttrs): void {
  if (!STARTUP_ENABLED) return;
  writeJson({
    type: 'startup',
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
  if (emittedStartupOnce.has(name)) return;
  emittedStartupOnce.add(name);
  startupMark(name, attrs);
}
