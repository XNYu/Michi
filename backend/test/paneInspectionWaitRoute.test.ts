import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PaneInspectionError, type WaitPaneResultV1 } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import type { WaitPaneInput } from '../src/services/paneInspectionWait';
import { setupPaneInspectionRoutes, type PaneInspectionRouteDeps } from '../src/routes/paneInspection';

// Focused route test for POST /api/panes/wait (P3-5b). Mirrors paneInspectionRoutes.test.ts's
// harness shape (real express app on an ephemeral port, fetch() client, stubbed service calls)
// rather than growing that file, so this task's file ownership stays isolated to
// routes/paneInspection.ts + this new test file.

let tmpDir: string;
const servers: Array<ReturnType<typeof express.application.listen>> = [];
let base: string;

interface Capture {
  waitCalls: Array<{ caller: PaneInspectionCaller; input: WaitPaneInput }>;
}

const SAMPLE_RESULT: WaitPaneResultV1 = {
  version: 1,
  reason: 'changed',
  descriptor: null,
  outcome: null,
  cursor: 'node:n-1:cursor-2',
};

function seed(): void {
  saveWorkspace({
    id: 'ws-a', name: 'A', cwd: null, active_tree_id: null, created_at: 1, updated_at: 1,
    settings: null, deleted_at: null, archived_at: null, folders: null, owner_user_id: 'owner-a',
  } as never);
  getDb().prepare(
    `INSERT INTO nodes (id, workspace_id, tree_id, kind, title, status, created_at) VALUES
     ('n-1', 'ws-a', NULL, 'chat', 'Sample', 'idle', 1)`,
  ).run();
}

/** Builds the router with a stubbed `waitPane` (captures every call) plus the REAL
 *  getWorkspace/getNodeWorkspaceId, matching paneInspectionRoutes.test.ts's `start()` shape. */
async function start(opts: {
  throwFromWait?: PaneInspectionError;
  resolveWait?: (input: WaitPaneInput) => WaitPaneResultV1 | Promise<WaitPaneResultV1>;
} = {}): Promise<Capture> {
  const capture: Capture = { waitCalls: [] };

  const overrides: Partial<PaneInspectionRouteDeps> = {
    waitPane: async (caller, input) => {
      capture.waitCalls.push({ caller, input });
      if (opts.throwFromWait) throw opts.throwFromWait;
      if (opts.resolveWait) return opts.resolveWait(input);
      return SAMPLE_RESULT;
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner };
    next();
  });
  app.use('/api', setupPaneInspectionRoutes(overrides));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return capture;
}

async function post(body: unknown, owner?: string): Promise<Response> {
  return fetch(`${base}/panes/wait`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-user': owner } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/panes/wait', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-wait-route-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    seed();
  });

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()!;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('until: terminal with an executionRef is passed through unchanged', async () => {
    const capture = await start();
    const executionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };
    const res = await post({ nodeId: 'n-1', until: 'terminal', executionRef, timeoutMs: 5_000 });
    assert.equal(res.status, 200);
    assert.deepEqual(capture.waitCalls[0].input.executionRef, executionRef);
    assert.equal(capture.waitCalls[0].input.timeoutMs, 5_000);
  });

  test('cloud mode: a node owned by a different user resolves to NOT_FOUND, never leaking to the service', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = await start();
    const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'c1' }, 'owner-b');
    assert.equal(res.status, 404);
    assert.equal(capture.waitCalls.length, 0);
  });

  const errorTable: Array<[import('michi-shared').PaneInspectionErrorCode, number]> = [
    ['INVALID_ARGUMENT', 400],
    ['NOT_FOUND', 404],
    ['NAVIGATION_DISABLED', 403],
    ['UNSUPPORTED', 400],
    ['OUTPUT_CHANGED', 409],
    ['OUTPUT_UNAVAILABLE', 410],
    ['SOURCE_UNAVAILABLE', 503],
    ['RATE_LIMITED', 429],
  ];

  for (const [code, status] of errorTable) {
  }

  // -------------------------------------------------------------------------
  // Request disconnect does not cancel the underlying execution
  // -------------------------------------------------------------------------

  test('client disconnect aborts observation without cancelling the target execution', async () => {
    let released: () => void = () => {};
    let cancelled = false;
    let onDisconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => { onDisconnect = resolve; });
    let onReached!: () => void;
    const reached = new Promise<void>((resolve) => { onReached = resolve; });
    const pending = new Promise<WaitPaneResultV1>((resolve) => {
      released = () => resolve(SAMPLE_RESULT);
    });
    const capture = await start({
      resolveWait: async (input) => {
        input.signal?.addEventListener('abort', onDisconnect, { once: true });
        onReached();
        try {
          return await pending;
        } catch {
          cancelled = true;
          throw new Error('should not be reached');
        }
      },
    });

    const controller = new AbortController();
    const fetchPromise = fetch(`${base}/panes/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n-1', until: 'changed', cursor: 'c1' }),
      signal: controller.signal,
    });

    // Wait until the request reaches waitPane(); a fixed sleep lost this race under load.
    await reached;
    assert.equal(capture.waitCalls.length, 1);

    // Disconnect the client before the service call resolves.
    controller.abort();
    await assert.rejects(fetchPromise);
    await disconnected;
    assert.equal(capture.waitCalls[0].input.signal?.aborted, true);

    // The underlying service promise is still running and completes normally — nothing in the
    // route handler ever calls anything that would reject/cancel it. Resolve it now and confirm
    // no cancellation path was taken.
    released();
    await pending;
    assert.equal(cancelled, false);
  });
});
