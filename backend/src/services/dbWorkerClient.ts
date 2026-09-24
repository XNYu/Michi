/**
 * Database Worker Client
 *
 * Async interface to the database worker thread. The main Express thread
 * calls these functions instead of the synchronous originals, freeing the
 * event loop while SQLite writes execute on the worker.
 *
 * Usage:
 *   import { initDbWorker, dbWorker } from './dbWorkerClient';
 *   await initDbWorker(dbPath);         // once at startup
 *   const result = await dbWorker.ensureDurableGraphNode(input);
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { EnsureDurableGraphNodeInput, EnsureDurableGraphNodeResult } from './graphCommands';
import type { DurableTurnSnapshot } from 'michi-shared';

declare const __MICHIBUNDLE__: boolean | undefined;

let _worker: Worker | null = null;
let _nextId = 1;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let _readyPromise: Promise<void> | null = null;

/**
 * Resolve the worker thread entry point.
 *
 * Dev (ts-node): __dirname = .../backend/src/services, file = dbWorkerThread.ts.
 * Bundled: esbuild flattens to dist/server.js, so __dirname = .../backend/dist.
 * The build script needs to emit a separate bundle for the worker entry point
 * at dist/dbWorkerThread.js.
 */
function resolveWorkerPath(): string {
  const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
  if (bundled) {
    return path.join(__dirname, 'dbWorkerThread.js');
  }
  // Dev mode: run the TS file directly via ts-node's ESM loader.
  return path.join(__dirname, 'dbWorkerThread.ts');
}

export function initDbWorker(dbPath: string): Promise<void> {
  if (_readyPromise) return _readyPromise;

  _readyPromise = new Promise((resolve, reject) => {
    const workerPath = resolveWorkerPath();
    const isTsFile = workerPath.endsWith('.ts');

    _worker = new Worker(workerPath, {
      workerData: { dbPath },
      // ts-node dev: register the TypeScript loader so the worker can import TS
      ...(isTsFile ? { execArgv: ['--require', 'ts-node/register'] } : {}),
    });

    _worker.on('message', (msg: { type?: string; id?: number; result?: unknown; error?: string }) => {
      if (msg.type === 'ready') {
        resolve();
        return;
      }
      if (msg.id !== undefined) {
        const cb = _pending.get(msg.id);
        if (cb) {
          _pending.delete(msg.id);
          if (msg.error) {
            cb.reject(new Error(msg.error));
          } else {
            cb.resolve(msg.result);
          }
        }
      }
    });

    _worker.on('error', (err) => {
      // Worker crashed — reject all pending calls and null the worker
      for (const [, cb] of _pending) {
        cb.reject(err);
      }
      _pending.clear();
      _worker = null;
      _readyPromise = null;
    });

    _worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`dbWorker exited with code ${code}`);
        for (const [, cb] of _pending) {
          cb.reject(err);
        }
        _pending.clear();
      }
      _worker = null;
      _readyPromise = null;
    });
  });

  return _readyPromise;
}

function rpc<T>(command: string, args: unknown): Promise<T> {
  if (!_worker) {
    return Promise.reject(new Error('dbWorker not initialized — call initDbWorker() first'));
  }
  const id = _nextId++;
  return new Promise<T>((resolve, reject) => {
    _pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    _worker!.postMessage({ id, command, args });
  });
}

export async function shutdownDbWorker(): Promise<void> {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
    _readyPromise = null;
  }
}

/** Whether the worker is alive and ready for commands. */
export function isDbWorkerReady(): boolean {
  return _worker !== null;
}

// ── Public async command API ───────────────────────────────────────────────

export const dbWorker = {
  /**
   * Async version of graphCommands.ensureDurableGraphNode().
   * Runs on the worker thread — does NOT block the Express event loop.
   */
  ensureDurableGraphNode(
    input: EnsureDurableGraphNodeInput,
  ): Promise<EnsureDurableGraphNodeResult> {
    // The worker operates on plain JSON — strip class instances.
    // The input type is already a plain data interface, but we round-trip
    // through JSON to be safe (e.g. undefined → null).
    const payload = JSON.parse(JSON.stringify(input));
    return rpc<EnsureDurableGraphNodeResult>('ensureDurableGraphNode', payload);
  },

  /**
   * Async version of persistResumeBinding from michi.ts.
   * Await this before acknowledging session creation or releasing its restore lock.
   */
  persistResumeBinding(args: {
    nodeId: string;
    acp_session_id: string;
    runtime_id: string;
    runtime_engine?: string | null;
    provider_id: string | null;
    model_id: string | null;
    reasoning: string | null;
    resume_fingerprint: string | null;
    current_mode_id: string | null;
  }): Promise<void> {
    return rpc<void>('persistResumeBinding', args);
  },

  /** Health check. */
  ping(): Promise<string> {
    return rpc<string>('ping', null);
  },

  /**
   * Async version of dbRepository.beginTurn().
   * Runs on the worker thread — does NOT block the Express event loop.
   */
  beginTurn(snapshot: DurableTurnSnapshot): Promise<void> {
    const payload = JSON.parse(JSON.stringify(snapshot));
    return rpc<void>('beginTurn', payload);
  },

  /**
   * Async version of dbRepository.checkpointTurn().
   * Typically fire-and-forget — caller does not need to await.
   */
  checkpointTurn(snapshot: DurableTurnSnapshot): Promise<void> {
    const payload = JSON.parse(JSON.stringify(snapshot));
    return rpc<void>('checkpointTurn', payload);
  },

  /**
   * Async version of dbRepository.finalizeTurn().
   * Must await — the caller needs the durability guarantee before broadcasting done.
   */
  finalizeTurn(snapshot: DurableTurnSnapshot): Promise<void> {
    const payload = JSON.parse(JSON.stringify(snapshot));
    return rpc<void>('finalizeTurn', payload);
  },
};
