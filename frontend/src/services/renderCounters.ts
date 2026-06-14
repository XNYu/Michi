export interface RenderCounterEvent {
  component: string;
  key: string;
  count: number;
  at: number;
  meta?: Record<string, unknown>;
}

export interface RenderCounterSink {
  enabled?: boolean;
  counts: Record<string, number>;
  componentCounts: Record<string, number>;
  events?: RenderCounterEvent[];
  maxEvents?: number;
}

declare global {
  interface Window {
    __MICHI_RENDER_COUNTERS__?: RenderCounterSink;
  }
}

function getSink(): RenderCounterSink | null {
  if (typeof window === 'undefined') return null;
  const existing = window.__MICHI_RENDER_COUNTERS__;
  if (existing?.enabled) return existing;
  return null;
}

export function renderCountersEnabled(): boolean {
  return getSink() !== null;
}

export function countRender(
  component: string,
  key = 'global',
  meta?: Record<string, unknown>,
): void {
  const sink = getSink();
  if (!sink) return;

  const id = `${component}:${key}`;
  const count = (sink.counts[id] ?? 0) + 1;
  sink.counts[id] = count;
  sink.componentCounts[component] = (sink.componentCounts[component] ?? 0) + 1;

  if (sink.events) {
    const maxEvents = sink.maxEvents ?? 50_000;
    if (sink.events.length < maxEvents) {
      sink.events.push({
        component,
        key,
        count,
        at: performance.now(),
        meta,
      });
    }
  }
}
