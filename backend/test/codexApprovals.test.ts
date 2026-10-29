/**
 * Security-critical approval policy mapping and decision semantics tests.
 *
 * These tests lock the contract described in spec §5.1:
 *
 *   - Only `CODEX_APPROVAL_ALIASES` methods may consult the chat tool policy.
 *   - Unsupported methods never consult the tool policy.
 *   - allow_once  → { decision: 'accept' }
 *   - reject_once → { decision: 'decline' }
 *   - chat allow_always → { decision: 'accept' } + revocable chat grant
 *   - cancelPermission / markCrashed → { decision: 'cancel' }
 *     (null resolve is mapped to 'decline' in askPermission — tested as fail-safe)
 *   - Approval for unknown threadId → immediate { decision: 'decline' }
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import { CodexSession } from 'michi-runtime/internal/adapters/codex/CodexSession';
import { CODEX_SERVER_REQUESTS } from 'michi-runtime/internal/adapters/codex/codexProtocol';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { runOwner } from './helpers/owners';
import { fakeMcpRegistry, type FakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { codexTestOptions } from './helpers/codexTestOptions';

// ---- Stubs ------------------------------------------------------------------

type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
) => void;

function makeStubClient(threadId = 'thread-approval-test'): CodexAppServerClient & {
  _serverRequestHandler: ServerRequestHandler | null;
  _fireServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  _emit(threadId: string, method: string, params: Record<string, unknown>): void;
} {
  let serverRequestHandler: ServerRequestHandler | null = null;
  const notifHandlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const titleThreadId = `${threadId}-title`;

  const client: any = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: params.ephemeral ? titleThreadId : threadId };
      if (method === 'model/list') return { data: [] };
      if (method === 'turn/start') {
        if (params.threadId === titleThreadId) {
          queueMicrotask(() => client._emit(titleThreadId, 'turn/completed', {
            threadId: titleThreadId, turn: { id: 'title-turn-1', status: 'completed' },
          }));
          return { turn: { id: 'title-turn-1' } };
        }
        return { turn: { id: 'turn-1' } };
      }
      return {};
    },
    onNotification: (id: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let handlers = notifHandlers.get(id);
      if (!handlers) { handlers = new Set(); notifHandlers.set(id, handlers); }
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    onGlobalNotification: (_h: unknown) => () => {},
    onServerRequest: (h: ServerRequestHandler) => {
      serverRequestHandler = h;
    },
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    _emit(id: string, method: string, params: Record<string, unknown>) {
      for (const handler of notifHandlers.get(id) ?? []) handler(method, params);
    },

    // Test helper — fire a server request and capture the response
    _fireServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve) => {
        if (!serverRequestHandler) {
          resolve({ decision: 'no-handler' });
          return;
        }
        serverRequestHandler(method, params, resolve);
      });
    },

    get _serverRequestHandler() {
      return serverRequestHandler;
    },
  };

  return client as ReturnType<typeof makeStubClient>;
}

function makeStubMcpRegistry(): FakeMcpRegistry {
  return fakeMcpRegistry({}, { mcpPort: 3001 });
}

function makeStubBridge(): AgentToolBridge {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function makeRuntime(client: CodexAppServerClient) {
  return new CodexRuntime(
    { ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() },
    { client },
  );
}

async function startActiveTurn(t: TestContext, runtime: CodexRuntime, session: CodexSession, client: ReturnType<typeof makeStubClient>) {
  const turn = (async () => {
    for await (const _event of session.send('Run the approval test')) { /* Drain until cleanup. */ }
  })();
  t.after(async () => {
    client._emit(session.threadId, 'turn/completed', {
      threadId: session.threadId, turn: { id: 'turn-1', status: 'completed' },
    });
    await runtime.shutdown();
    await turn;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(session.acceptsControl({ threadId: session.threadId, turnId: 'turn-1' }), 'controls require a live native turn');
}

/** Create a registered session with an active native turn for approval routing. */
async function makeRuntimeWithSession(t: TestContext, threadId = 'thread-approval-test') {
  const client = makeStubClient(threadId);

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'node-approval-test',
    cwd: '/tmp/test',
    model: 'test-model',
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  return { runtime, session, client };
}

// ---- Tests ------------------------------------------------------------------

test('permission profiles fail closed without using generic tool approval', async (t) => {
  // `item/permissions/requestApproval` is NOT in CODEX_APPROVAL_ALIASES.
  // The chat tool policy allows any tool in Trust and YOLO, so it MUST NOT be
  // fed to that policy or the generic approval UI.
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.permissionsApproval, // 'item/permissions/requestApproval'
    { threadId: 'thread-approval-test' },
  );

  // Give the async askPermission a tick to register
  await new Promise((r) => setImmediate(r));

  assert.equal(
    session.pendingPermissions.size,
    0,
    'permission scopes cannot be approved as a generic tool',
  );

  assert.deepEqual(await responsePromise, { permissions: {}, scope: 'turn' });
  await runtime.shutdown();
});

test('unsupported MCP elicitation declines rather than accepting an unfilled form', async (t) => {
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.mcpElicitation,
    {
      threadId: 'thread-approval-test',
      turnId: 'turn-1',
      serverName: 'external-mcp',
      mode: 'form',
      message: 'Allow this MCP request?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: null,
    },
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(session.pendingPermissions.size, 0);

  assert.deepEqual(await responsePromise, {
    action: 'decline',
    content: null,
    _meta: null,
  });
  await runtime.shutdown();
});

test('MCP elicitation without a matching session declines with its own contract', async () => {
  const client = makeStubClient();
  makeRuntime(client);

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.mcpElicitation,
    {
      threadId: 'missing-thread',
      turnId: null,
      serverName: 'external-mcp',
      mode: 'form',
      message: 'Allow this MCP request?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: null,
    },
  );

  assert.deepEqual(result, {
    action: 'decline',
    content: null,
    _meta: null,
  });
});

test('chat fileChange approval does not persist a native session-wide grant', async (t) => {
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  const alwaysAllowCalls: string[] = [];
  session.onAlwaysAllow = (canonical) => alwaysAllowCalls.push(canonical);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.fileChangeApproval,
    { threadId: 'thread-approval-test', file_path: '/tmp/foo.ts' },
  );
  await new Promise((r) => setImmediate(r));

  const [requestId] = session.pendingPermissions.keys();
  session.respondToPermission(requestId, 'allow_always');

  const result = await responsePromise;
  assert.deepEqual(result, { decision: 'accept' });
  assert.deepEqual(alwaysAllowCalls, [], 'chat grants must not invoke the legacy workspace grant hook');
  await runtime.shutdown();
});

test('cancelPermission resolves to decline (null → decline path)', async (t) => {
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'echo cancel-me' },
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(session.pendingPermissions.size, 1);
  const [requestId] = session.pendingPermissions.keys();
  session.cancelPermission(requestId);

  const result = await responsePromise;
  // cancelPermission resolves with null, askPermission maps null → decline
  assert.deepEqual(result, { decision: 'decline' }, 'cancelPermission should produce decline');
  assert.equal(session.pendingPermissions.size, 0, 'pendingPermissions should be empty after cancel');
  await runtime.shutdown();
});

test('approval with missing threadId in params → immediate decline', async () => {
  const client = makeStubClient();
  makeRuntime(client);

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { command: 'echo no-thread-id' }, // no threadId field
  );

  assert.deepEqual(result, { decision: 'decline' }, 'missing threadId should get immediate decline');
});

// ---- Agent Run approval routing tests (T06) ---------------------------------

test('agent_run approval delegates to permissionBroker, not the chat policy', async (t) => {
  const brokerRequests: Array<{ toolName: string }> = [];
  const broker: any = {
    async requestPermission(req: any) {
      brokerRequests.push({ toolName: req.toolName });
      return 'allow_once';
    },
  };

  const client = makeStubClient('thread-run-approval');

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'attempt-approval-1',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: runOwner('run-approval', 'attempt-approval-1'),
    permissionBroker: broker,
    toolProfile: { allowedToolNames: ['submit_agent_result', 'bash'] },
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  // Fire a known command approval — for agent_run, runtime should delegate
  // directly to askPermission which routes through the broker.
  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-run-approval', command: 'echo test' },
  );

  assert.equal(brokerRequests.length, 1, 'broker should have been called');
  assert.equal(brokerRequests[0].toolName, 'bash');
  assert.deepEqual(result, { decision: 'accept' }, 'allow_once from broker → accept');

  await runtime.shutdown();
});

test('agent_run allow_always from broker produces acceptForSession without grantPermission', async (t) => {
  const broker: any = {
    async requestPermission(_req: any) { return 'allow_always'; },
  };

  const client = makeStubClient('thread-run-grant');

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'attempt-grant-1',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: runOwner('run-grant', 'attempt-grant-1'),
    permissionBroker: broker,
    toolProfile: { allowedToolNames: ['submit_agent_result', 'bash'] },
    workspaceId: 'ws-test',
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  // Track whether onAlwaysAllow was called (it should NOT be for agent_run)
  const alwaysAllowCalls: string[] = [];
  session.onAlwaysAllow = (canonical) => alwaysAllowCalls.push(canonical);

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-run-grant', command: 'npm install' },
  );

  assert.deepEqual(result, { decision: 'acceptForSession' }, 'allow_always → acceptForSession');
  // onAlwaysAllow should NOT be called for agent_run (no grant persistence)
  assert.equal(alwaysAllowCalls.length, 0, 'onAlwaysAllow must not be called for agent_run');

  await runtime.shutdown();
});

test('agent_run deny from broker produces decline', async (t) => {
  const broker: any = {
    async requestPermission(_req: any) { return 'deny'; },
  };

  const client = makeStubClient('thread-run-deny');

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'attempt-deny-1',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: runOwner('run-deny', 'attempt-deny-1'),
    permissionBroker: broker,
    toolProfile: { allowedToolNames: ['submit_agent_result', 'bash'] },
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-run-deny', command: 'rm -rf /' },
  );

  assert.deepEqual(result, { decision: 'decline' });

  await runtime.shutdown();
});

for (const answer of ['allow_once', 'allow_always', 'reject_once']) test(`agent_run ask answered ${answer} is a single-use decision`, async (t) => {
  const client = makeStubClient('thread-run-ask');
  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'attempt-ask-1',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: runOwner('run-ask', 'attempt-ask-1'),
    permissionBroker: { async requestPermission() { return 'ask'; } },
    toolProfile: { allowedToolNames: ['submit_agent_result', 'bash'] },
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);
  const response = client._fireServerRequest(CODEX_SERVER_REQUESTS.commandApproval, { threadId: 'thread-run-ask', command: 'npm test' });
  await new Promise((resolve) => setImmediate(resolve));
  const [requestId] = session.pendingPermissions.keys();
  assert.ok(requestId != null, 'the ask is shown as a Run interaction');
  // RuntimeRunExecutor sends the answer "allow_always" as this option id; like
  // Claude and Pi, a Run approves only this request and keeps no grant.
  session.respondToPermission(requestId, answer);
  assert.deepEqual(await response, { decision: answer === 'reject_once' ? 'decline' : 'accept' });
});

for (const choice of ['allow_always', 'allow_session']) {
  test(`chat ${choice} grants affect later native requests in the same turn`, async (t) => {
    const { configureRuntimeDeps, __resetRuntimeDeps } = await import('../src/agents/runtimeDeps');
    const grants = new Set<string>();
    let token = '0';
    configureRuntimeDeps({
      dataDir: '/tmp/michi-codex-approval-tests',
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
      agentConfig: { getAgentConfig: () => ({ runtime: 'codex', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
      chatPermissions: { getMode: () => 'ask', hasGrant: (id, tool) => grants.has(`${id}:${tool}`), grant: (id, tool) => { grants.add(`${id}:${tool}`); }, resetToken: () => token },
    });
    t.after(__resetRuntimeDeps);
    const { session, client } = await makeRuntimeWithSession(t);
    const ask = (method: string) => client._fireServerRequest(method, { threadId: session.threadId, turnId: 'turn-1', command: 'echo test' });
    const first = ask(CODEX_SERVER_REQUESTS.commandApproval);
    await new Promise((resolve) => setImmediate(resolve));
    const [id] = session.pendingPermissions.keys();
    session.respondToPermission(id, choice);
    assert.deepEqual(await first, { decision: 'accept' });
    assert.deepEqual(await ask(CODEX_SERVER_REQUESTS.commandApproval), { decision: 'accept' });
    const otherTool = ask(CODEX_SERVER_REQUESTS.fileChangeApproval);
    await new Promise((resolve) => setImmediate(resolve));
    if (choice === 'allow_always') {
      const [otherId] = session.pendingPermissions.keys();
      assert.ok(otherId != null, 'a different tool must still ask');
      session.respondToPermission(otherId, 'reject_once');
      assert.deepEqual(await otherTool, { decision: 'decline' });
    } else {
      assert.equal(session.pendingPermissions.size, 0);
      assert.deepEqual(await otherTool, { decision: 'accept' });
      token = '1';
      const revoked = ask(CODEX_SERVER_REQUESTS.commandApproval);
      await new Promise((resolve) => setImmediate(resolve));
      const [revokedId] = session.pendingPermissions.keys();
      assert.ok(revokedId != null, 'Ask revokes temporary session trust during the turn');
      session.respondToPermission(revokedId, 'reject_once');
      assert.deepEqual(await revoked, { decision: 'decline' });
    }
  });
}

for (const choice of ['allow_always', 'allow_session']) test(`Codex ${choice} drains matching queued tool approvals`, async (t) => {
  const { session, client } = await makeRuntimeWithSession(t);
  const command = client._fireServerRequest(CODEX_SERVER_REQUESTS.commandApproval, { threadId: session.threadId, turnId: 'turn-1' });
  const edit = client._fireServerRequest(choice === 'allow_always' ? CODEX_SERVER_REQUESTS.commandApproval : CODEX_SERVER_REQUESTS.fileChangeApproval, { threadId: session.threadId, turnId: 'turn-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const ids = [...session.pendingPermissions.keys()];
  assert.equal(ids.length, 2);
  session.respondToPermission(ids[1], choice);
  assert.deepEqual(await Promise.all([command, edit]), [{ decision: 'accept' }, { decision: 'accept' }]);
  assert.equal(session.pendingPermissions.size, 0);
});

// Cloud mode: a chat's grants belong to its user. One user's session in a
// workspace another user owns must not pass on the owner's always-allow grant.
for (const grantedTo of ['owner-b', 'user-a']) test(`cloud chat approval reads the session user's grants, not the workspace owner's (grant of ${grantedTo})`, async (t) => {
  const { configureRuntimeDeps, __resetRuntimeDeps } = await import('../src/agents/runtimeDeps');
  const nodeId = 'node-cloud-approval';
  const grants = new Set([`${nodeId}\u0000bash\u0000${grantedTo}`]);
  const previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  configureRuntimeDeps({
    dataDir: '/tmp/michi-codex-approval-tests',
    historyStore: {
      getNode: (id: string) => (id === nodeId ? { id, workspace_id: 'ws-owner-b' } : null) as never,
      listMessages: () => [],
      getWorkspace: (id: string) => (id === 'ws-owner-b' ? { id, owner_user_id: 'owner-b' } : null) as never,
      getWorkspaceInstructions: () => null,
    },
    agentConfig: { getAgentConfig: () => ({ runtime: 'codex', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
    chatPermissions: {
      getMode: () => 'ask',
      hasGrant: (id, tool, userId) => grants.has(`${id}\u0000${tool}\u0000${userId ?? ''}`),
      grant: () => { throw new Error('no grant is written'); },
      resetToken: () => '0',
    },
  });
  t.after(() => {
    __resetRuntimeDeps();
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD;
    else process.env.MICHI_CLOUD = previousCloud;
  });
  const client = makeStubClient('thread-cloud-approval');
  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: nodeId, cwd: '/tmp/test', model: 'test-model', ownerUserId: 'user-a', workspaceId: 'ws-owner-b',
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  const answer = client._fireServerRequest(CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: session.threadId, turnId: 'turn-1', command: 'echo cloud' });
  await new Promise((resolve) => setImmediate(resolve));
  if (grantedTo === 'user-a') {
    assert.equal(session.pendingPermissions.size, 0, 'the session user\'s own grant applies');
    assert.deepEqual(await answer, { decision: 'accept' });
    return;
  }
  const [requestId] = session.pendingPermissions.keys();
  assert.ok(requestId != null, 'user A is asked: owner B\'s grant does not cover A\'s session');
  session.respondToPermission(requestId, 'reject_once');
  assert.deepEqual(await answer, { decision: 'decline' });
});
