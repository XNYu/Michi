import * as metrics from './metrics';

export function startupTraceEnabled(): boolean {
  return metrics.startupEnabled();
}

export function startupRunId(): string {
  return metrics.runId();
}

export function startupMark(name: string, extra?: Record<string, unknown>): void {
  metrics.startupMark(name, extra);
}

export function startupMarkOnce(name: string, extra?: Record<string, unknown>): void {
  metrics.startupMarkOnce(name, extra);
}

export function withStartupTraceQuery(rawUrl: string): string {
  const metricsEnabled = metrics.enabled();
  const frameMetricsEnabled = process.env.MICHI_FRAME_METRICS === '1';
  if (!startupTraceEnabled() && !metricsEnabled && !frameMetricsEnabled) return rawUrl;
  const url = new URL(rawUrl);
  if (startupTraceEnabled()) {
    url.searchParams.set('startupTrace', '1');
    url.searchParams.set('startupRunId', metrics.runId());
  }
  if (metricsEnabled) {
    url.searchParams.set('metrics', '1');
    url.searchParams.set('metricsRunId', metrics.runId());
  }
  if (frameMetricsEnabled) {
    url.searchParams.set('frameMetrics', '1');
    if (process.env.MICHI_FRAME_METRICS_WINDOW_MS) {
      url.searchParams.set('frameMetricsWindowMs', process.env.MICHI_FRAME_METRICS_WINDOW_MS);
    }
  }
  return url.toString();
}

export function startupTraceFileQuery(): Record<string, string> | undefined {
  const query: Record<string, string> = {};
  if (startupTraceEnabled()) {
    query.startupTrace = '1';
    query.startupRunId = metrics.runId();
  }
  if (metrics.enabled()) {
    query.metrics = '1';
    query.metricsRunId = metrics.runId();
  }
  if (process.env.MICHI_FRAME_METRICS === '1') {
    query.frameMetrics = '1';
    if (process.env.MICHI_FRAME_METRICS_WINDOW_MS) {
      query.frameMetricsWindowMs = process.env.MICHI_FRAME_METRICS_WINDOW_MS;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

export function isStartupTraceLine(message: string): boolean {
  if (!startupTraceEnabled() && !metrics.enabled()) return false;
  const start = message.indexOf('{');
  if (start === -1) return false;
  try {
    const parsed = JSON.parse(message.slice(start));
    return parsed?.type === 'startup' || parsed?.type === 'metric';
  } catch {
    return false;
  }
}
