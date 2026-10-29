import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MetaAgentTodayMetrics, MetaAgentUsageToday } from 'michi-shared';
import { getDbPath } from './db';
import { LOCAL_AGENT_OWNER_ID } from './agentOwner';
import { log } from './logger';
import { startOfLocalDay } from './metaAgent/todayUsage';

declare const __MICHIBUNDLE__: boolean | undefined;
export interface MetaAgentMetricsSnapshot { dayStart: number; today: MetaAgentTodayMetrics; usage: MetaAgentUsageToday }
const FRESH_MS = 30_000;
const MAX_STALE_MS = 5 * 60_000;
const DEADLINE_MS = 10_000;

/** Bounded, owner/day-scoped read cache. Never falls back to a main-thread scan. */
export class MetaAgentMetricsReader {
  private worker: Worker | null = null;
  private stopping: Promise<void> | null = null;
  private nextId = 0;
  private closed = false;
  private retryAfter = 0;
  private pending = new Map<number, { resolve: (value: MetaAgentMetricsSnapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private cache = new Map<string, { result?: MetaAgentMetricsSnapshot; at: number; flight?: Promise<MetaAgentMetricsSnapshot> }>();

  constructor(private readonly dbPath: string, private readonly options: {
    clock?: () => number;
    workerFactory?: (dbPath: string) => Worker;
    deadlineMs?: number;
  } = {}) {}

  private clock(): number { return (this.options.clock ?? Date.now)(); }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.retryAfter = this.clock() + 5_000;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    // Native SQLite work can outlive the JS deadline. Do not start another
    // expensive reader until termination of this one has actually completed.
    this.stopping = worker.terminate().then(() => {}, () => {}).finally(() => { this.stopping = null; });
  }

  private start(): Worker {
    if (this.closed) throw new Error('Statistics reader is closed');
    if (this.worker) return this.worker;
    if (this.stopping || this.clock() < this.retryAfter) throw new Error('Statistics reader is recovering');
    const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
    const worker = this.options.workerFactory?.(this.dbPath) ?? new Worker(path.join(__dirname, bundled ? 'metaAgentMetricsWorker.js' : 'metaAgentMetricsWorker.ts'), {
      workerData: { dbPath: this.dbPath },
      ...(!bundled ? { execArgv: ['--require', 'ts-node/register/transpile-only'] } : {}),
    });
    this.worker = worker;
    worker.on('message', (message: { id: number; result: MetaAgentMetricsSnapshot; error?: string; durationMs: number }) => {
      if (this.worker !== worker) return;
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.durationMs >= 100) log.warn('http', 'background statistics slow', { durationMs: Math.round(message.durationMs) });
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
      if (this.pending.size === 0) worker.unref();
    });
    worker.on('error', error => this.fail(worker, error));
    worker.on('exit', code => this.fail(worker, new Error(`Statistics worker exited (${code})`)));
    return worker;
  }

  read(ownerUserId: string, now = Date.now()): Promise<MetaAgentMetricsSnapshot> {
    if (this.closed) return Promise.reject(new Error('Statistics reader is closed'));
    const dayStart = startOfLocalDay(now);
    const key = JSON.stringify([ownerUserId, dayStart]);
    let entry = this.cache.get(key);
    if (!entry) {
      // The production caller has one local owner; keep the reusable API bounded.
      if (this.cache.size >= 16) {
        const unused = [...this.cache].find(([, value]) => !value.flight);
        if (!unused) return Promise.reject(new Error('Statistics queue is full'));
        this.cache.delete(unused[0]);
      }
      entry = { at: 0 }; this.cache.set(key, entry);
    }
    const age = this.clock() - entry.at;
    if (entry.result && age < FRESH_MS) return Promise.resolve(entry.result);
    if (!entry.flight) {
      const target = entry;
      target.flight = new Promise<MetaAgentMetricsSnapshot>((resolve, reject) => {
        const worker = this.start();
        const id = ++this.nextId;
        const timer = setTimeout(() => this.fail(worker, new Error('Statistics read timed out')), this.options.deadlineMs ?? DEADLINE_MS);
        this.pending.set(id, { resolve, reject, timer });
        worker.ref();
        try { worker.postMessage({ id, ownerUserId, now }); }
        catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error))); }
      }).then(result => { target.result = result; target.at = this.clock(); return result; })
        .finally(() => { target.flight = undefined; });
      // Background refresh errors retain a previously good snapshot until its age limit.
      void target.flight.catch(error => log.warn('http', 'statistics refresh failed', { error: error instanceof Error ? error.message : String(error) }));
    }
    return entry.result && age < MAX_STALE_MS ? Promise.resolve(entry.result) : entry.flight!;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) this.fail(worker, new Error('Statistics reader stopped'));
    await this.stopping;
    this.cache.clear();
  }
}

let reader: MetaAgentMetricsReader | null = null;
let readerPath: string | null = null;
let timer: NodeJS.Timeout | null = null;
export function readMetaAgentMetrics(ownerUserId: string, now = Date.now()): Promise<MetaAgentMetricsSnapshot> {
  const dbPath = getDbPath();
  if (!reader || readerPath !== dbPath) {
    void reader?.close(); reader = new MetaAgentMetricsReader(dbPath); readerPath = dbPath;
  }
  return reader.read(ownerUserId, now);
}

/** Warm independently of HTTP reads and continue refreshing while the server runs. */
export function startMetaAgentMetrics(): void {
  if (timer) return;
  const refresh = () => { void readMetaAgentMetrics(LOCAL_AGENT_OWNER_ID).catch(() => {}); };
  refresh(); timer = setInterval(refresh, FRESH_MS); timer.unref();
}

export async function stopMetaAgentMetrics(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const previous = reader; reader = null; readerPath = null;
  await previous?.close();
}
