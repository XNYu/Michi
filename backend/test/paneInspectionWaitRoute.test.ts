import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PaneInspectionError, type WaitPaneResultV1 } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import type { WaitPaneInput } from '../src/services/paneInspectionWait';
import { setupPaneInspectionRoutes, type PaneInspectionRouteDeps } from '../src/routes/paneInspection';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

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
function start(opts: {
  throwFromWait?: PaneInspectionError;
  resolveWait?: (input: WaitPaneInput) => WaitPaneResultV1 | Promise<WaitPaneResultV1>;
} = {}): Capture {
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
  const server = app.listen(0);
  servers.push(server);
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

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
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

  // -------------------------------------------------------------------------
  // Success
  // -------------------------------------------------------------------------

  test('reaches the service with correctly parsed arguments and returns its result', async () => {
    const capture = start();
    const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'node:n-1:cursor-1' });
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.deepEqual(body, SAMPLE_RESULT);
    assert.equal(capture.waitCalls.length, 1);
    const { signal, ...input } = capture.waitCalls[0].input;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(input, {
      locator: { nodeId: 'n-1' },
      until: 'changed',
      cursor: 'node:n-1:cursor-1',
      executionRef: undefined,
      timeoutMs: 20_000, // shared default (waitTimeoutDefaultMs)
    });
  });

  test('until: terminal with an executionRef is passed through unchanged', async () => {
    const capture = start();
    const executionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };
    const res = await post({ nodeId: 'n-1', until: 'terminal', executionRef, timeoutMs: 5_000 });
    assert.equal(res.status, 200);
    assert.deepEqual(capture.waitCalls[0].input.executionRef, executionRef);
    assert.equal(capture.waitCalls[0].input.timeoutMs, 5_000);
  });

  // -------------------------------------------------------------------------
  // Malformed / multiple locator rejection
  // -------------------------------------------------------------------------

  test('missing locator -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await post({ until: 'changed', cursor: 'c1' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.waitCalls.length, 0);
  });

  test('two locators (nodeId + runId) -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await post({ nodeId: 'n-1', runId: 'run-1', until: 'changed', cursor: 'c1' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.waitCalls.length, 0);
  });

  test('unknown nodeId -> 404 NOT_FOUND, and never reaches the service', async () => {
    const capture = start();
    const res = await post({ nodeId: 'does-not-exist', until: 'changed', cursor: 'c1' });
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(capture.waitCalls.length, 0);
  });

  test('until: changed without cursor -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await post({ nodeId: 'n-1', until: 'changed' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.waitCalls.length, 0);
  });

  test('until: terminal without executionRef -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await post({ nodeId: 'n-1', until: 'terminal' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.waitCalls.length, 0);
  });

  test('GET /panes/wait rejects (no GET handler registered)', async () => {
    start();
    const res = await fetch(`${base}/panes/wait`);
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------------------------
  // Server-derived caller identity — never overridden by body owner/workspace fields
  // -------------------------------------------------------------------------

  test('a body-supplied ownerUserId/workspaceId/backendConnectionId does not change what the service is called with', async () => {
    const capture = start();
    const res = await post({
      nodeId: 'n-1',
      until: 'changed',
      cursor: 'c1',
      ownerUserId: 'someone-else',
      workspaceId: 'ws-not-mine',
      backendConnectionId: 'remote-conn',
    });
    assert.equal(res.status, 200);
    const caller = capture.waitCalls[0].caller;
    // Desktop mode (MICHI_CLOUD unset): ownerUserId is always the fixed local identity,
    // workspaceId is always the row this router resolved from nodeId=n-1 (ws-a, per seed()), and
    // backendConnectionId is always 'local' — none of the body fields above ever reach the caller.
    assert.equal(caller.ownerUserId, LOCAL_AGENT_OWNER_ID);
    assert.equal(caller.workspaceId, 'ws-a');
    assert.equal(caller.backendConnectionId, 'local');
  });

  test('cloud mode: caller identity comes from the authenticated session header, not the body', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = start();
    const res = await post(
      { nodeId: 'n-1', until: 'changed', cursor: 'c1', ownerUserId: 'someone-else', workspaceId: 'ws-not-mine' },
      'owner-a',
    );
    assert.equal(res.status, 200);
    assert.equal(capture.waitCalls[0].caller.ownerUserId, 'owner-a');
    assert.equal(capture.waitCalls[0].caller.workspaceId, 'ws-a');
  });

  test('cloud mode: a node owned by a different user resolves to NOT_FOUND, never leaking to the service', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = start();
    const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'c1' }, 'owner-b');
    assert.equal(res.status, 404);
    assert.equal(capture.waitCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // Typed error mapping (brief: RATE_LIMITED + the one shared error mapper)
  // -------------------------------------------------------------------------

  test('service throwing RATE_LIMITED maps to HTTP 429 via the shared error mapper', async () => {
    start({ throwFromWait: new PaneInspectionError('RATE_LIMITED', 'wait_pane', 'too many concurrent waits') });
    const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'c1' });
    assert.equal(res.status, 429);
    const body = await asJson(res);
    assert.equal(body.code, 'RATE_LIMITED');
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
    test(`service throwing ${code} maps to HTTP ${status} (same shared mapper as inspect/output)`, async () => {
      start({ throwFromWait: new PaneInspectionError(code, 'wait_pane', 'msg') });
      const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'c1' });
      assert.equal(res.status, status);
      const body = await asJson(res);
      assert.equal(body.code, code);
    });
  }

  test('unexpected non-PaneInspectionError -> 500 with no stack, no SQL, no filesystem path', async () => {
    start({
      resolveWait: () => {
        throw new Error('boom: /secret/path leaked-sql SELECT * FROM x');
      },
    });
    const res = await post({ nodeId: 'n-1', until: 'changed', cursor: 'c1' });
    assert.equal(res.status, 500);
    const body = await asJson(res);
    assert.equal(body.code, 'INTERNAL');
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /\/secret\/path/);
    assert.doesNotMatch(raw, /SELECT \* FROM/);
    assert.doesNotMatch(raw, /at Object\.<anonymous>/);
  });

  // -------------------------------------------------------------------------
  // Request disconnect does not cancel the underlying execution
  // -------------------------------------------------------------------------

  test('client disconnect aborts observation without cancelling the target execution', async () => {
    let released: () => void = () => {};
    let cancelled = false;
    let onDisconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => { onDisconnect = resolve; });
    const pending = new Promise<WaitPaneResultV1>((resolve) => {
      released = () => resolve(SAMPLE_RESULT);
    });
    const capture = start({
      resolveWait: async (input) => {
        input.signal?.addEventListener('abort', onDisconnect, { once: true });
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

    // Give the request time to reach the handler and register the waitPane() call.
    await new Promise((resolve) => setTimeout(resolve, 50));
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
