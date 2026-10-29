import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { log } from './logger';

const contexts = new AsyncLocalStorage<string>();
let nextContext = 0;
const recent: Array<{ operation: string; durationMs: number; context?: string; endedAt: number }> = [];
type Sink = (event: string, details: Record<string, unknown>) => void;
const sink: Sink = (event, details) => log.warn('performance', event, details);
// Diagnostics must never replace a successful result or the original failure.
function reportSafely(report: Sink, event: string, details: Record<string, unknown>): void {
  try { report(event, details); } catch { /* Logging failure cannot break database operations. */ }
}
export function nextPerformanceContext(): string { return `request-${++nextContext}`; }
export function withPerformanceContext<T>(id: string, action: () => T): T { return contexts.run(id, action); }

/** Time actual synchronous work, without recording SQL parameters or credential commands. */
export function timedSync<T>(operation: string, action: () => T, report: Sink = sink, thresholdMs = 100): T {
  const start = performance.now();
  let failed = false;
  try { return action(); }
  catch (error) { failed = true; throw error; }
  finally {
    const durationMs = performance.now() - start;
    if (durationMs >= thresholdMs) {
      const detail = { operation, durationMs: Math.round(durationMs), context: contexts.getStore(), endedAt: Date.now() };
      recent.push(detail); if (recent.length > 16) recent.shift();
      // Stack identifies the owning code; SQL strings and their values stay private.
      const stack = new Error().stack?.split('\n').slice(2, 7).join('\n');
      reportSafely(report, 'slow synchronous operation', { ...detail, failed, stack });
    }
  }
}

const instrumented = new WeakSet<DatabaseSync>();
export function instrumentDatabase(database: DatabaseSync, name: string, report: Sink = sink, thresholdMs = 100): DatabaseSync {
  if (instrumented.has(database)) return database;
  instrumented.add(database);
  const prepare = database.prepare.bind(database);
  const exec = database.exec.bind(database);
  const label = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 12);
  database.exec = sql => timedSync(`${name}.exec:${label(sql)}`, () => exec(sql), report, thresholdMs);
  database.prepare = sql => {
    const query = label(sql);
    const statement = timedSync(`${name}.prepare:${query}`, () => prepare(sql), report, thresholdMs);
    for (const method of ['get', 'all', 'run'] as const) {
      const original = statement[method].bind(statement);
      // Native SQLite methods require the native receiver. Preserve overloads
      // while timing both direct prepares and the application's statement cache.
      Object.defineProperty(statement, method, { value: (...args: unknown[]) => timedSync(
        `${name}.${method}:${query}`, () => Reflect.apply(original, statement, args), report, thresholdMs,
      ), configurable: true });
    }
    return statement;
  };
  return database;
}

/** Logs long event-loop stalls alongside recent synchronous operations, including idle stalls. */
export function startEventLoopDiagnostics(report: Sink = sink, intervalMs = 1000, thresholdMs = 250): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previous = performance.now();
  let previousUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now();
    const delayMs = Math.max(histogram.max / 1e6, now - previous - intervalMs);
    const utilization = performance.eventLoopUtilization(previousUtilization);
    previousUtilization = performance.eventLoopUtilization();
    previous = now; histogram.reset();
    if (delayMs >= thresholdMs) reportSafely(report, 'event loop stalled', {
      delayMs: Math.round(delayMs), utilization: utilization.utilization,
      recentSync: recent.filter(item => Date.now() - item.endedAt < 60_000),
    });
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
