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
