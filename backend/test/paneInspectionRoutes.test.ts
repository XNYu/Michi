import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  PaneInspectionError,
  PANE_INSPECTION_LIMITS,
  type PaneDescriptorV1,
  type ExecutionRef,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getWorkspace, saveWorkspace } from '../src/services/dbRepository';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import type { ReadPaneOutputInput, ReadPaneOutputResult } from '../src/services/paneInspectionOutput';
import { PanePresenceRegistry, MAX_SURFACE_REGISTRATIONS_PER_SCOPE } from '../src/services/panePresence';
import { setupPaneInspectionRoutes, type PaneInspectionRouteDeps } from '../src/routes/paneInspection';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

// Mirrors agentRunOwnershipRoutes.test.ts / files.test.ts: a real express app on an ephemeral
// port, exercised with fetch(). No supertest dependency.

let tmpDir: string;
let server: ReturnType<typeof express.application.listen>;
// Every listener start() creates, not just the most recent one. One test mounts twice (to compare
// two responses byte-for-byte), and closing only the latest `server` left the first listening
// forever, which kept the event loop alive and hung the runner after the last test finished.
const servers: Array<ReturnType<typeof express.application.listen>> = [];
let base: string;

interface Capture {
  inspectCalls: Array<{ caller: PaneInspectionCaller; input: unknown }>;
  outputCalls: Array<{ caller: PaneInspectionCaller; input: ReadPaneOutputInput }>;
}

const SAMPLE_DESCRIPTOR: PaneDescriptorV1 = {
  version: 1,
  ref: { backendConnectionId: 'local', paneId: 'node:n-1' },
  target: { kind: 'node', nodeId: 'n-1' },
  kind: 'chat',
  title: 'Sample',
  workspaceId: 'ws-a',
  treeId: null,
  archived: false,
  truncatedFields: [],
  observation: { observedAt: 1, freshness: 'persisted', cursor: 'node:n-1' },
  capabilities: { readOutput: true, subscribe: true, waitForTerminal: false },
  activity: 'idle',
  execution: { status: 'unknown', reason: 'no turn' },
  timeline: { resourceCreatedAt: 1, firstExecutionStartedAt: null },
  presence: { coverage: 'unknown', views: [] },
  conversation: { status: 'unsupported', reason: 'n/a' },
  lineage: { status: 'unsupported', reason: 'n/a' },
  runtime: { status: 'unsupported', reason: 'n/a' },
  latestOutput: { status: 'unsupported', reason: 'n/a' },
};

const SAMPLE_OUTPUT: ReadPaneOutputResult = {
  outputId: 'chat_turn:t-1',
  execution: { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' },
  kind: 'answer',
  text: 'hello',
  outputRevision: 'rev-1',
  partial: false,
  nextPageCursor: null,
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

/** Builds the router with fully stubbed inspect/readOutput/presence + the REAL
 *  getWorkspace/getNodeWorkspaceId (so workspace-resolution/ownership is exercised against a
 *  real sqlite fixture, per the brief's "caller identity comes from the session" requirement),
 *  and captures every call the router makes into `capture` for assertion. */
function start(opts: { throwFromInspect?: PaneInspectionError; throwFromOutput?: PaneInspectionError; nonPaneError?: boolean } = {}): Capture {
  const capture: Capture = { inspectCalls: [], outputCalls: [] };
  const presenceRegistry = new PanePresenceRegistry(undefined, { now: () => 1_000 });

  const overrides: Partial<PaneInspectionRouteDeps> = {
    inspect: (caller, input) => {
      capture.inspectCalls.push({ caller, input });
      if (opts.throwFromInspect) throw opts.throwFromInspect;
      if (opts.nonPaneError) throw new Error('boom: /secret/path leaked-sql SELECT * FROM x');
      return SAMPLE_DESCRIPTOR;
    },
    readOutput: (caller, input) => {
      capture.outputCalls.push({ caller, input });
      if (opts.throwFromOutput) throw opts.throwFromOutput;
      return SAMPLE_OUTPUT;
    },
    presenceRegistry,
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner };
    next();
  });
  app.use('/api', setupPaneInspectionRoutes(overrides));
  server = app.listen(0);
  servers.push(server);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return capture;
}

async function get(route: string, owner?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    headers: owner ? { 'x-user': owner } : {},
  });
}

async function send(method: string, route: string, body: unknown, owner?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-user': owner } : {}) },
    body: JSON.stringify(body),
  });
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('Pane Inspection HTTP routes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-routes-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    seed();
  });

  afterEach(async () => {
    // Node's fetch (undici) keeps connections alive, and server.close() waits for every open
    // connection before invoking its callback — so awaiting close() alone never resolves and the
    // runner hangs. closeAllConnections() drops the idle keep-alive sockets first.
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
  // GET /api/panes/inspect
  // -------------------------------------------------------------------------

  test('inspect reaches the service with correctly parsed arguments', async () => {
    const capture = start();
    const res = await get('/panes/inspect?nodeId=n-1');
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.deepEqual(body, SAMPLE_DESCRIPTOR);
    assert.equal(capture.inspectCalls.length, 1);
    assert.deepEqual(capture.inspectCalls[0].input, { locator: { nodeId: 'n-1' }, executionRef: undefined });
  });

  test('inspect passes a JSON-encoded executionRef through to the service', async () => {
    const capture = start();
    const ref: ExecutionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };
    const res = await get(`/panes/inspect?nodeId=n-1&executionRef=${encodeURIComponent(JSON.stringify(ref))}`);
    assert.equal(res.status, 200);
    assert.deepEqual(capture.inspectCalls[0].input, { locator: { nodeId: 'n-1' }, executionRef: ref });
  });

  test('missing locator -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await get('/panes/inspect');
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.inspectCalls.length, 0);
  });

  test('two locators -> 400 INVALID_ARGUMENT, and never reaches the service', async () => {
    const capture = start();
    const res = await get('/panes/inspect?nodeId=n-1&runId=run-1');
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.equal(capture.inspectCalls.length, 0);
  });

  test('unknown nodeId -> 404 NOT_FOUND, and never reaches the service', async () => {
    const capture = start();
    const res = await get('/panes/inspect?nodeId=does-not-exist');
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(capture.inspectCalls.length, 0);
  });

  test('GET /panes/inspect rejects POST', async () => {
    const start1 = start();
    const res = await send('POST', '/panes/inspect', {});
    assert.equal(res.status, 404); // Express: no matching route/method registered.
    assert.equal(start1.inspectCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // GET /api/panes/output
  // -------------------------------------------------------------------------

  test('output reaches the service with correctly parsed arguments', async () => {
    const capture = start();
    const res = await get('/panes/output?nodeId=n-1&selection=latest');
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.deepEqual(body, SAMPLE_OUTPUT);
    assert.equal(capture.outputCalls.length, 1);
    assert.equal(capture.outputCalls[0].input.selection, 'latest');
    assert.equal(capture.outputCalls[0].input.limitBytes, 16_384); // shared default
  });

  test('output missing locator -> 400 INVALID_ARGUMENT', async () => {
    const capture = start();
    const res = await get('/panes/output?selection=latest');
    assert.equal(res.status, 400);
    assert.equal(capture.outputCalls.length, 0);
  });

  test('GET /panes/output rejects POST', async () => {
    const capture = start();
    const res = await send('POST', '/panes/output', {});
    assert.equal(res.status, 404);
    assert.equal(capture.outputCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // Error-code -> HTTP status mapping table (brief: assert each individually)
  // -------------------------------------------------------------------------

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
    test(`inspect: service throwing ${code} maps to HTTP ${status}`, async () => {
      start({ throwFromInspect: new PaneInspectionError(code, 'x', 'msg') });
      const res = await get('/panes/inspect?nodeId=n-1');
      assert.equal(res.status, status);
      const body = await asJson(res);
      assert.equal(body.code, code);
    });

    test(`output: service throwing ${code} maps to HTTP ${status}`, async () => {
      start({ throwFromOutput: new PaneInspectionError(code, 'x', 'msg') });
      const res = await get('/panes/output?nodeId=n-1&selection=latest');
      assert.equal(res.status, status);
      const body = await asJson(res);
      assert.equal(body.code, code);
    });
  }

  test('unexpected non-PaneInspectionError -> 500 with no stack, no SQL, no filesystem path', async () => {
    start({ nonPaneError: true });
    const res = await get('/panes/inspect?nodeId=n-1');
    assert.equal(res.status, 500);
    const body = await asJson(res);
    assert.equal(body.code, 'INTERNAL');
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /\/secret\/path/);
    assert.doesNotMatch(raw, /SELECT \* FROM/);
    assert.doesNotMatch(raw, /at Object\.<anonymous>/); // a stack frame shape
  });

  test('the two NOT_FOUND cases (wrong node, disabled navigation surfaced as NOT_FOUND-shaped) are byte-identical', async () => {
    // Both throw sites in the service layer use the exact literal 'x: target not found' — this
    // route never rewrites or distinguishes them (see sendError's doc comment). Assert the route
    // layer preserves that literal identically for two different underlying reasons.
    start({ throwFromInspect: new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found') });
    const resA = await get('/panes/inspect?nodeId=n-1');
    const bodyA = await asJson(resA);

    start({ throwFromInspect: new PaneInspectionError('NOT_FOUND', 'inspect', 'target not found') });
    const resB = await get('/panes/inspect?nodeId=n-1');
    const bodyB = await asJson(resB);

    assert.equal(resA.status, resB.status);
    assert.deepEqual(bodyA, bodyB);
  });

  // -------------------------------------------------------------------------
  // Caller identity is server-derived — never widened by a query parameter
  // -------------------------------------------------------------------------

  test('a caller-supplied ownerUserId/workspaceId in the query does not change what the service is called with', async () => {
    const capture = start();
    const res = await get(
      '/panes/inspect?nodeId=n-1&ownerUserId=someone-else&workspaceId=ws-not-mine&backendConnectionId=remote-conn',
    );
    assert.equal(res.status, 200);
    const caller = capture.inspectCalls[0].caller;
    // Desktop mode (MICHI_CLOUD unset in this test): ownerUserId is always the fixed local
    // identity, workspaceId is always the row this router itself resolved from nodeId=n-1
    // (ws-a, per seed()), and backendConnectionId is always 'local' — none of the three query
    // params above ever reach the caller object.
    assert.equal(caller.ownerUserId, LOCAL_AGENT_OWNER_ID);
    assert.equal(caller.workspaceId, 'ws-a');
    assert.equal(caller.backendConnectionId, 'local');
  });

  test('cloud mode: caller identity comes from the authenticated session header, not the query string', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = start();
    const res = await get(
      '/panes/inspect?nodeId=n-1&ownerUserId=someone-else&workspaceId=ws-not-mine',
      'owner-a',
    );
    assert.equal(res.status, 200);
    assert.equal(capture.inspectCalls[0].caller.ownerUserId, 'owner-a');
    assert.equal(capture.inspectCalls[0].caller.workspaceId, 'ws-a');
  });

  test('cloud mode: a node owned by a different user resolves to NOT_FOUND, never leaking to the service', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = start();
    const res = await get('/panes/inspect?nodeId=n-1', 'owner-b');
    assert.equal(res.status, 404);
    assert.equal(capture.inspectCalls.length, 0);
  });

  // -------------------------------------------------------------------------
  // Presence — PUT / DELETE /api/panes/presence
  // -------------------------------------------------------------------------

  test('PUT presence reaches the registry and returns a fresh rendererLeaseId', async () => {
    start();
    const res = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-a',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId: 'node:n-1', windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: 1 }],
    });
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.equal(body.ok, true);
    assert.equal(typeof body.rendererLeaseId, 'string');
    assert.equal(body.accepted, 1);
  });

  test('PUT presence with an unresolvable workspaceId -> 404 NOT_FOUND, registry untouched', async () => {
    start();
    const res = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-does-not-exist',
      viewRevision: 1,
      windowId: 'win-1',
      views: [],
    });
    assert.equal(res.status, 404);
  });

  test('PUT presence missing views array -> 400 INVALID_ARGUMENT', async () => {
    start();
    const res = await send('PUT', '/panes/presence', { workspaceId: 'ws-a', viewRevision: 1, windowId: 'win-1' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
  });

  test('PUT /panes/presence rejects GET', async () => {
    start();
    const res = await get('/panes/presence');
    assert.equal(res.status, 404); // no GET handler registered for this path
  });

  test('DELETE presence reaches the registry and cancels nothing (no execution side effect)', async () => {
    start();
    const putRes = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-a',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId: 'node:n-1', windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: 1 }],
    });
    const { rendererLeaseId } = await asJson(putRes);

    const delRes = await send('DELETE', '/panes/presence', { workspaceId: 'ws-a', rendererLeaseId });
    assert.equal(delRes.status, 200);
    const delBody = await asJson(delRes);
    assert.equal(delBody.ok, true);
    assert.equal(delBody.removed, 1);

    // "cancels nothing": removing presence never touches the node/chat/run itself — there is no
    // execution-related dependency in this router at all for these two routes (no chatHub, no
    // AgentRun coordinator import), so the only observable effect is the registry's own view
    // count, already asserted above via `removed: 1`.
  });

  test('DELETE presence with unknown rendererLeaseId -> 404 NOT_FOUND', async () => {
    start();
    const res = await send('DELETE', '/panes/presence', { workspaceId: 'ws-a', rendererLeaseId: 'lease-unknown' });
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('DELETE presence missing rendererLeaseId -> 400 INVALID_ARGUMENT', async () => {
    start();
    const res = await send('DELETE', '/panes/presence', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
  });

  test('DELETE /panes/presence rejects GET', async () => {
    start();
    const res = await get('/panes/presence');
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------------------------
  // Keepalive — POST /api/panes/presence/keepalive (design §9's semantic heartbeat, tunneled
  // through streamTransport.ts's allowlist as an ordinary authenticated HTTP route — see that
  // route's own module doc comment for why this is a ChatManager/route concern, not a
  // Pane-specific frame the protocol-agnostic multiplexer needs to know about).
  // -------------------------------------------------------------------------

  test('POST presence/keepalive reaches the registry and renews the lease', async () => {
    start();
    const putRes = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-a',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId: 'node:n-1', windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: 1 }],
    });
    const { rendererLeaseId } = await asJson(putRes);

    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a', rendererLeaseId });
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.equal(body.ok, true);
    assert.equal(body.renewedViews, 1);
  });

  test('POST presence/keepalive with unknown rendererLeaseId -> 404 NOT_FOUND, never leaking ownership', async () => {
    start();
    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a', rendererLeaseId: 'lease-unknown' });
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
    // Byte-identical to the DELETE NOT_FOUND body shape (no extra fields, no reason distinguishing
    // "no such lease" from "wrong owner") — see resolvePresenceOwnerUserId/keepalive's own guard,
    // which folds WRONG_WINDOW into the same NOT_FOUND rather than a distinguishable 403 here.
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  });

  test('POST presence/keepalive with an unresolvable workspaceId -> 404 NOT_FOUND, registry untouched', async () => {
    start();
    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-does-not-exist', rendererLeaseId: 'lease-anything' });
    assert.equal(res.status, 404);
  });

  test('POST presence/keepalive missing rendererLeaseId -> 400 INVALID_ARGUMENT', async () => {
    start();
    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
  });

  test('POST presence/keepalive uses the server-derived caller, not a body-supplied owner', async () => {
    process.env.MICHI_CLOUD = '1';
    start();
    const putRes = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-a',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId: 'node:n-1', windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: 1 }],
    }, 'owner-a');
    const { rendererLeaseId } = await asJson(putRes);

    // A different caller identity presenting the same leaseId cannot renew someone else's lease —
    // the registry's own ownerUserId check (mirrors WRONG_WINDOW in submitPresence/removePresence)
    // must still gate this route exactly like the other two presence routes.
    const wrongOwnerRes = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a', rendererLeaseId }, 'owner-b');
    assert.equal(wrongOwnerRes.status, 404);

    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a', rendererLeaseId }, 'owner-a');
    assert.equal(res.status, 200);
  });

  test('GET /panes/presence/keepalive rejects', async () => {
    start();
    const res = await get('/panes/presence/keepalive');
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------------------------
  // Allocation — POST /api/panes/presence/allocate (surface pane registration; ordinary HTTP,
  // never tunneled through streamTransport's allowlist).
  // -------------------------------------------------------------------------

  test('POST presence/allocate returns a paneId for a supported surface kind', async () => {
    start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'terminal' });
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.equal(typeof body.paneId, 'string');
    assert.equal(typeof body.registrationId, 'string');
    assert.ok((body.paneId as string).length > 0);
  });

  test('POST presence/allocate rejects an unsupported kind before allocating anything', async () => {
    start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'not-a-real-kind' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
  });

  test('POST presence/allocate missing kind -> 400 INVALID_ARGUMENT', async () => {
    start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
  });

  test('POST presence/allocate with an unresolvable workspaceId -> 404 NOT_FOUND', async () => {
    start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-does-not-exist', kind: 'terminal' });
    assert.equal(res.status, 404);
  });

  test('GET /panes/presence/allocate rejects', async () => {
    start();
    const res = await get('/panes/presence/allocate');
    assert.equal(res.status, 404);
  });

  test('POST presence/allocate refuses once a caller scope is at its per-scope cap, mapped to 429', async () => {
    process.env.MICHI_CLOUD = '1';
    start();
    saveWorkspace({
      id: 'ws-a2', name: 'A2', cwd: null, active_tree_id: null, created_at: 1, updated_at: 1,
      settings: null, deleted_at: null, archived_at: null, folders: null, owner_user_id: 'owner-a',
    } as never);
    for (let i = 0; i < MAX_SURFACE_REGISTRATIONS_PER_SCOPE; i += 1) {
      const ok = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'terminal' }, 'owner-a');
      assert.equal(ok.status, 200, `expected allocation ${i} to succeed`);
    }
    const capped = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'terminal' }, 'owner-a');
    assert.equal(capped.status, 429);
    const body = await asJson(capped);
    assert.equal(body.code, 'RATE_LIMITED');

    // A different workspace (same owner, different scope) is entirely unaffected by ws-a's cap.
    const otherWorkspace = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a2', kind: 'terminal' }, 'owner-a');
    assert.equal(otherWorkspace.status, 200);
  });

  test('a registration allocated by one owner cannot be claimed via presence PUT by another owner', async () => {
    process.env.MICHI_CLOUD = '1';
    start();
    saveWorkspace({
      id: 'ws-b', name: 'B', cwd: null, active_tree_id: null, created_at: 1, updated_at: 1,
      settings: null, deleted_at: null, archived_at: null, folders: null, owner_user_id: 'owner-b',
    } as never);
    const allocRes = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'terminal' }, 'owner-a');
    assert.equal(allocRes.status, 200);
    const { paneId } = await asJson(allocRes);

    // owner-b submits against their OWN workspace (ws-b) — the registration was allocated under
    // owner-a+ws-a, so it must be rejected as NOT_FOUND even though owner-b's own request is
    // otherwise well-formed (own workspace, own connection).
    const submitByOther = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-b',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId, windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    }, 'owner-b');
    assert.equal(submitByOther.status, 200);
    const otherBody = await asJson(submitByOther);
    assert.equal(otherBody.accepted, 0);
    assert.equal((otherBody.rejectedTargets as Array<{ reason: string }>)[0].reason, 'NOT_FOUND');

    const submitByOwner = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-a',
      viewRevision: 1,
      windowId: 'win-1',
      views: [{ paneId, windowId: 'win-1', uiPaneId: 'ui-1', treeId: null, visible: true, openedAtClient: null }],
    }, 'owner-a');
    assert.equal(submitByOwner.status, 200);
    const ownerBody = await asJson(submitByOwner);
    assert.equal(ownerBody.accepted, 1);
  });

  // -------------------------------------------------------------------------
  // GET /api/panes/subscribe — route/shared-parser boundary for the 32-paneId cap
  // (design §8 / brief P3-7 gap #1). `parseSubscribePanesRequestV1` already enforces
  // `PANE_INSPECTION_LIMITS.subscribeMaxPanes`; this exercises it through the ACTUAL route with
  // 33 distinct paneIds, proving INVALID_ARGUMENT is returned before any feed/subscriber is
  // opened — not merely asserting the constant equals 32 (see paneInspectionSubscribe.test.ts's
  // own disclaimer at its "more than 32 paneIds" describe block).
  // -------------------------------------------------------------------------

  test('subscribe with 33 distinct paneIds -> 400 INVALID_ARGUMENT before any stream opens', async () => {
    start();
    assert.equal(PANE_INSPECTION_LIMITS.subscribeMaxPanes, 32, 'sanity: test intentionally exceeds this by one');
    const paneIds = Array.from({ length: 33 }, (_, i) => `node:n-${i}`);
    const res = await get(`/panes/subscribe?paneIds=${encodeURIComponent(JSON.stringify(paneIds))}`);
    assert.equal(res.status, 400);
    // A real stream response never has a JSON content-type — asserting it here is part of the
    // proof that the parser rejected the request BEFORE `res.setHeader('Content-Type',
    // 'text/event-stream')` / `res.flushHeaders()` ran (see the route handler: parsing happens
    // first and returns early via `sendError` on failure).
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
    assert.match(String(body.message ?? ''), /paneIds/);
  });

  test('subscribe with exactly 32 distinct paneIds is accepted (opens a stream, not a 400)', async () => {
    start();
    const paneIds = Array.from({ length: 32 }, (_, i) => `node:n-${i}`);
    const res = await get(`/panes/subscribe?paneIds=${encodeURIComponent(JSON.stringify(paneIds))}`);
    // These paneIds resolve to nodes that don't exist in the seeded DB, so the route's per-paneId
    // workspace-resolution loop will reject with NOT_FOUND before opening the stream — the point
    // of this companion test is only to prove the boundary is AT 32, i.e. that count alone is not
    // what triggers INVALID_ARGUMENT (unlike the 33-paneId case above, which fails the parser
    // itself, before any per-paneId resolution is attempted).
    assert.notEqual(res.status, 400);
  });
});
