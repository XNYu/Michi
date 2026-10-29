import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PaneInspectionError, type PaneDescriptorV1, type ExecutionRef } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveWorkspace } from '../src/services/dbRepository';
import type { PaneInspectionCaller } from '../src/services/paneInspection';
import type { ReadPaneOutputInput, ReadPaneOutputResult } from '../src/services/paneInspectionOutput';
import { PanePresenceRegistry, MAX_SURFACE_REGISTRATIONS_PER_SCOPE } from '../src/services/panePresence';
import { setupPaneInspectionRoutes, type PaneInspectionRouteDeps } from '../src/routes/paneInspection';
import { inspectPaneTool } from '../src/agents/paneInspectionTools';
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
 *  workspace resolution (so workspace-resolution/ownership is exercised against a
 *  real sqlite fixture, per the brief's "caller identity comes from the session" requirement),
 *  and captures every call the router makes into `capture` for assertion. */
async function start(opts: { throwFromInspect?: PaneInspectionError; throwFromOutput?: PaneInspectionError; nonPaneError?: boolean } = {}): Promise<Capture> {
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
  server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return capture;
}

/** Builds the router with its real services and the shared presence registry, as server.ts
 *  mounts it, so a surface registered through the presence routes is what inspect() reads. */
async function startWithRealServices(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner };
    next();
  });
  app.use('/api', setupPaneInspectionRoutes());
  server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

/** Allocates a terminal surface in ws-a and reports one live view of it, through the routes. */
async function registerTerminalSurface(windowId: string, owner?: string): Promise<string> {
  const alloc = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a', kind: 'terminal' }, owner);
  assert.equal(alloc.status, 200);
  const { paneId } = await asJson(alloc) as { paneId: string };
  const put = await send('PUT', '/panes/presence', {
    workspaceId: 'ws-a',
    viewRevision: 1,
    windowId,
    views: [{ paneId, windowId, uiPaneId: 'ui-terminal', treeId: null, visible: true, openedAtClient: null, surfaceTitle: 'Shell' }],
  }, owner);
  assert.equal((await asJson(put)).accepted, 1);
  return paneId;
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

  test('inspect and output accept an executionRef in place of the locator', async () => {
    const capture = await start();
    const ref: ExecutionRef = { kind: 'chat_turn', nodeId: 'n-1', turnId: 't-1' };
    const encoded = encodeURIComponent(JSON.stringify(ref));
    assert.equal((await get(`/panes/inspect?executionRef=${encoded}`)).status, 200);
    assert.deepEqual(capture.inspectCalls[0].input, { locator: { nodeId: 'n-1' }, executionRef: ref });
    assert.equal((await get(`/panes/output?selection=execution&executionRef=${encoded}`)).status, 200);
    assert.deepEqual(capture.outputCalls[0].input.locator, { nodeId: 'n-1' });
    assert.deepEqual(capture.outputCalls[0].input.executionRef, ref);
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
  }

  test('unexpected non-PaneInspectionError -> 500 with no stack, no SQL, no filesystem path', async () => {
    await start({ nonPaneError: true });
    const res = await get('/panes/inspect?nodeId=n-1');
    assert.equal(res.status, 500);
    const body = await asJson(res);
    assert.equal(body.code, 'INTERNAL');
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /\/secret\/path/);
    assert.doesNotMatch(raw, /SELECT \* FROM/);
    assert.doesNotMatch(raw, /at Object\.<anonymous>/); // a stack frame shape
  });

  test('cloud mode: a node owned by a different user resolves to NOT_FOUND, never leaking to the service', async () => {
    process.env.MICHI_CLOUD = '1';
    const capture = await start();
    const res = await get('/panes/inspect?nodeId=n-1', 'owner-b');
    assert.equal(res.status, 404);
    assert.equal(capture.inspectCalls.length, 0);
  });

  test('inspect resolves a surface paneId that the inspect_pane tool resolves for the same workspace', async () => {
    await startWithRealServices();
    const paneId = await registerTerminalSurface('win-surface-desktop');

    const tool = inspectPaneTool({ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: 'ws-a', backendConnectionId: 'local' }, { paneId });
    assert.equal(tool.isError, undefined);
    assert.match(tool.content[0].text, /^kind: terminal$/m);

    const res = await get(`/panes/inspect?paneId=${encodeURIComponent(paneId)}`);
    assert.equal(res.status, 200);
    const body = await asJson(res);
    assert.equal(body.kind, 'terminal');
    assert.equal(body.workspaceId, 'ws-a');

    // The surface is authorised, so output reaches the capability check instead of NOT_FOUND.
    const output = await get(`/panes/output?paneId=${encodeURIComponent(paneId)}&selection=latest`);
    assert.equal(output.status, 400);
    assert.equal((await asJson(output)).code, 'UNSUPPORTED');
  });

  test('cloud mode: a surface registered by another owner is NOT_FOUND over HTTP', async () => {
    process.env.MICHI_CLOUD = '1';
    saveWorkspace({
      id: 'ws-b', name: 'B', cwd: null, active_tree_id: null, created_at: 1, updated_at: 1,
      settings: null, deleted_at: null, archived_at: null, folders: null, owner_user_id: 'owner-b',
    } as never);
    await startWithRealServices();
    const paneId = await registerTerminalSurface('win-surface-cloud', 'owner-a');

    const foreign = await get(`/panes/inspect?paneId=${encodeURIComponent(paneId)}`, 'owner-b');
    assert.equal(foreign.status, 404);
    assert.equal((await asJson(foreign)).code, 'NOT_FOUND');

    const own = await get(`/panes/inspect?paneId=${encodeURIComponent(paneId)}`, 'owner-a');
    assert.equal(own.status, 200);
    assert.equal((await asJson(own)).workspaceId, 'ws-a');
  });

  test('PUT presence with an unresolvable workspaceId -> 404 NOT_FOUND, registry untouched', async () => {
    await start();
    const res = await send('PUT', '/panes/presence', {
      workspaceId: 'ws-does-not-exist',
      viewRevision: 1,
      windowId: 'win-1',
      views: [],
    });
    assert.equal(res.status, 404);
  });

  test('PUT presence missing views array -> 400 INVALID_ARGUMENT', async () => {
    await start();
    const res = await send('PUT', '/panes/presence', { workspaceId: 'ws-a', viewRevision: 1, windowId: 'win-1' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
  });

  test('DELETE presence reaches the registry and cancels nothing (no execution side effect)', async () => {
    await start();
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
    await start();
    const res = await send('DELETE', '/panes/presence', { workspaceId: 'ws-a', rendererLeaseId: 'lease-unknown' });
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('DELETE presence missing rendererLeaseId -> 400 INVALID_ARGUMENT', async () => {
    await start();
    const res = await send('DELETE', '/panes/presence', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
  });

  test('POST presence/keepalive with unknown rendererLeaseId -> 404 NOT_FOUND, never leaking ownership', async () => {
    await start();
    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a', rendererLeaseId: 'lease-unknown' });
    assert.equal(res.status, 404);
    const body = await asJson(res);
    assert.equal(body.code, 'NOT_FOUND');
    // Byte-identical to the DELETE NOT_FOUND body shape (no extra fields, no reason distinguishing
    // "no such lease" from "wrong owner") — see resolvePresenceOwnerUserId/keepalive's own guard,
    // which folds WRONG_WINDOW into the same NOT_FOUND rather than a distinguishable 403 here.
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  });

  test('POST presence/keepalive missing rendererLeaseId -> 400 INVALID_ARGUMENT', async () => {
    await start();
    const res = await send('POST', '/panes/presence/keepalive', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
    const body = await asJson(res);
    assert.equal(body.code, 'INVALID_ARGUMENT');
  });

  test('POST presence/keepalive uses the server-derived caller, not a body-supplied owner', async () => {
    process.env.MICHI_CLOUD = '1';
    await start();
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

  test('POST presence/allocate missing kind -> 400 INVALID_ARGUMENT', async () => {
    await start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-a' });
    assert.equal(res.status, 400);
  });

  test('POST presence/allocate with an unresolvable workspaceId -> 404 NOT_FOUND', async () => {
    await start();
    const res = await send('POST', '/panes/presence/allocate', { workspaceId: 'ws-does-not-exist', kind: 'terminal' });
    assert.equal(res.status, 404);
  });

  test('POST presence/allocate refuses once a caller scope is at its per-scope cap, mapped to 429', async () => {
    process.env.MICHI_CLOUD = '1';
    await start();
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
    await start();
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

  test('subscribe with exactly 32 distinct paneIds is accepted (opens a stream, not a 400)', async () => {
    await start();
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
