import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { metaAgentMetricsSnapshot } from './metaAgent/todayUsage';

if (!parentPort) throw new Error('Statistics must run in a worker');
// No migrations, writes or work on the durable-turn writer's queue.
const database = new DatabaseSync(workerData.dbPath, { readOnly: true });
database.exec('PRAGMA query_only=ON');
database.exec('PRAGMA busy_timeout=1000');
parentPort.on('message', ({ id, ownerUserId, now }: { id: number; ownerUserId: string; now: number }) => {
  const started = performance.now();
  try {
    database.exec('BEGIN');
    const result = metaAgentMetricsSnapshot(ownerUserId, now, database);
    database.exec('COMMIT');
    parentPort!.postMessage({ id, result, durationMs: performance.now() - started });
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* BEGIN may have failed */ }
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error), durationMs: performance.now() - started });
  }
});
