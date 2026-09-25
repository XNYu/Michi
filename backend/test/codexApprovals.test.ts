/**
 * Security-critical approval policy mapping and decision semantics tests.
 *
 * These tests lock the contract described in spec §5.1:
 *
 *   - Only `CODEX_APPROVAL_ALIASES` methods may consult resolvePolicy.
 *   - Unsupported methods never consult resolvePolicy (which defaults
 *     to "allow" for any tool not in ASK_TOOLS, so feeding unknown methods
 *     directly would silently auto-approve them).
 *   - allow_once  → { decision: 'accept' }
 *   - reject_once → { decision: 'decline' }
 *   - allow_always → { decision: 'acceptForSession' } + onAlwaysAllow(canonical)
 *   - cancelPermission / markCrashed → { decision: 'cancel' }
 *     (null resolve is mapped to 'decline' in askPermission — tested as fail-safe)
 *   - Approval for unknown threadId → immediate { decision: 'decline' }
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime } from '../src/agents/codex/CodexRuntime';
import { CodexSession } from '../src/agents/codex/CodexSession';
import { CODEX_SERVER_REQUESTS } from '../src/agents/codex/codexProtocol';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';

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

function makeStubMcpRegistry(): McpSlotRegistry {
  const registry: any = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, _cbs: any, _opts?: any) => ({
      slotId: 'test-slot-' + Math.random().toString(36).slice(2),
    }),
    dispose: async (_slotId: string) => {},
    get: (_slotId: string) => undefined,
  };
  return registry as McpSlotRegistry;
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
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
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
  // resolvePolicy would return 'allow' for it (since it's not in ASK_TOOLS),
  // so it MUST NOT be fed to resolvePolicy or the generic approval UI.
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

test('allow_once → { decision: accept } for commandExecution and fileChange', async (t) => {
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  // --- commandExecution ---
  const cmdResponsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'echo hello' },
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(session.pendingPermissions.size, 1);
  const [cmdRequestId] = session.pendingPermissions.keys();
  session.respondToPermission(cmdRequestId, 'allow_once');

  const cmdResult = await cmdResponsePromise;
  assert.deepEqual(cmdResult, { decision: 'accept' }, 'allow_once should produce accept');

  // --- fileChange ---
  const fileResponsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.fileChangeApproval,
    { threadId: 'thread-approval-test', file_path: '/tmp/foo.txt' },
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(session.pendingPermissions.size, 1);
  const [fileRequestId] = session.pendingPermissions.keys();
  session.respondToPermission(fileRequestId, 'allow_once');

  const fileResult = await fileResponsePromise;
  assert.deepEqual(fileResult, { decision: 'accept' }, 'allow_once should produce accept for fileChange');
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

test('markCrashed cancels all pending permissions with decline', async (t) => {
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  // Queue two approval requests without responding
  const response1Promise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'cmd1' },
  );
  const response2Promise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.fileChangeApproval,
    { threadId: 'thread-approval-test', file_path: '/tmp/a.ts' },
  );

  await new Promise((r) => setImmediate(r));
  assert.equal(session.pendingPermissions.size, 2, 'should have 2 pending permissions');

  // Crash the session
  session.markCrashed('daemon exited unexpectedly');

  const [result1, result2] = await Promise.all([response1Promise, response2Promise]);
  assert.deepEqual(result1, { decision: 'decline' }, 'crashed session should decline all pending');
  assert.deepEqual(result2, { decision: 'decline' }, 'crashed session should decline all pending');
  assert.equal(session.pendingPermissions.size, 0, 'pendingPermissions should be cleared after crash');
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

test('agent_run approval delegates to permissionBroker, not resolvePolicy', async (t) => {
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
    owner: { kind: 'agent_run', runId: 'run-approval', attemptId: 'attempt-approval-1' },
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
    owner: { kind: 'agent_run', runId: 'run-grant', attemptId: 'attempt-grant-1' },
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
    owner: { kind: 'agent_run', runId: 'run-deny', attemptId: 'attempt-deny-1' },
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

test('agent_run permission profiles fail closed without a generic broker decision', async (t) => {
  const brokerRequests: Array<{ toolName: string }> = [];
  const broker: any = {
    async requestPermission(req: any) {
      brokerRequests.push({ toolName: req.toolName });
      return 'deny';
    },
  };

  const client = makeStubClient('thread-run-unknown');

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'attempt-unknown-1',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-unknown', attemptId: 'attempt-unknown-1' },
    permissionBroker: broker,
    toolProfile: { allowedToolNames: ['submit_agent_result'] },
  }) as CodexSession;
  await startActiveTurn(t, runtime, session, client);

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.permissionsApproval,
    { threadId: 'thread-run-unknown' },
  );

  assert.equal(brokerRequests.length, 0, 'generic tool decisions cannot grant permission scopes');
  assert.deepEqual(result, { permissions: {}, scope: 'turn' });

  await runtime.shutdown();
});

test('chat session approval still uses resolvePolicy and grantPermission', async (t) => {
  // This test verifies existing chat behavior is unchanged after T06 changes.
  const { runtime, session, client } = await makeRuntimeWithSession(t);

  const alwaysAllowCalls: string[] = [];
  session.onAlwaysAllow = (canonical) => alwaysAllowCalls.push(canonical);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'echo chat-test' },
  );
  await new Promise((r) => setImmediate(r));

  // Should land in pendingPermissions (chat session asks the user)
  assert.equal(session.pendingPermissions.size, 1);
  const [requestId] = session.pendingPermissions.keys();
  session.respondToPermission(requestId, 'allow_always');

  const result = await responsePromise;
  assert.deepEqual(result, { decision: 'acceptForSession' });
  assert.deepEqual(alwaysAllowCalls, ['bash'], 'chat session should call onAlwaysAllow');

  await runtime.shutdown();
});
