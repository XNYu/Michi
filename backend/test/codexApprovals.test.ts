/**
 * Security-critical approval policy mapping and decision semantics tests.
 *
 * These tests lock the contract described in spec §5.1:
 *
 *   - Only `CODEX_APPROVAL_ALIASES` methods may consult resolvePolicy.
 *   - Unknown methods ALWAYS ask — never consult resolvePolicy (which defaults
 *     to "allow" for any tool not in ASK_TOOLS, so feeding unknown methods
 *     directly would silently auto-approve them).
 *   - allow_once  → { decision: 'accept' }
 *   - reject_once → { decision: 'decline' }
 *   - allow_always → { decision: 'acceptForSession' } + onAlwaysAllow(canonical)
 *   - cancelPermission / markCrashed → { decision: 'cancel' }
 *     (null resolve is mapped to 'decline' in askPermission — tested as fail-safe)
 *   - Approval for unknown threadId → immediate { decision: 'decline' }
 */

import { test } from 'node:test';
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

function makeStubClient(): CodexAppServerClient & {
  _serverRequestHandler: ServerRequestHandler | null;
  _fireServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
} {
  let serverRequestHandler: ServerRequestHandler | null = null;

  const client: any = {
    ensureStarted: async () => {},
    request: async (_method: string, _params: unknown): Promise<unknown> => {
      if (_method === 'thread/start') return { threadId: 'thread-approval-test' };
      if (_method === 'model/list') return { data: [] };
      return {};
    },
    onNotification: (_threadId: string, _handler: unknown) => () => {},
    onServerRequest: (h: ServerRequestHandler) => {
      serverRequestHandler = h;
    },
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    isRunning: () => true,

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

/**
 * Create a CodexSession directly (bypasses newSession's thread/start call)
 * and register it into a runtime by creating a real session via newSession.
 * Returns the session and the client for test control.
 */
async function makeRuntimeWithSession(threadId = 'thread-approval-test') {
  const client = makeStubClient();
  // Override thread/start to return our controlled threadId
  (client as any).request = async (method: string, _params: unknown): Promise<unknown> => {
    if (method === 'thread/start') return { threadId };
    if (method === 'model/list') return { data: [] };
    return {};
  };

  const runtime = makeRuntime(client);
  const session = await runtime.newSession({
    sessionId: 'node-approval-test',
    cwd: '/tmp/test',
    model: 'test-model',
  }) as CodexSession;

  return { runtime, session, client };
}

// ---- Tests ------------------------------------------------------------------

test('unknown approval method always asks — never auto-allows', async () => {
  // `item/permissions/requestApproval` is NOT in CODEX_APPROVAL_ALIASES.
  // resolvePolicy would return 'allow' for it (since it's not in ASK_TOOLS),
  // so it MUST NOT be fed to resolvePolicy — it must always go to session.askPermission.
  const { runtime, session, client } = await makeRuntimeWithSession();

  // Fire the unknown method but do NOT respond — we just want to verify it lands
  // in pendingPermissions (i.e. was not auto-responded by the runtime).
  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.permissionsApproval, // 'item/permissions/requestApproval'
    { threadId: 'thread-approval-test' },
  );

  // Give the async askPermission a tick to register
  await new Promise((r) => setImmediate(r));

  assert.equal(
    session.pendingPermissions.size,
    1,
    'unknown method should land in pendingPermissions (i.e. asked, not auto-allowed)',
  );

  // Clean up — respond to avoid timer leak
  const [requestId] = session.pendingPermissions.keys();
  session.respondToPermission(requestId, 'reject_once');
  await responsePromise;
  await runtime.shutdown();
});

test('allow_once → { decision: accept } for commandExecution and fileChange', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

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

test('reject_once → { decision: decline }', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'rm -rf /' },
  );
  await new Promise((r) => setImmediate(r));

  const [requestId] = session.pendingPermissions.keys();
  session.respondToPermission(requestId, 'reject_once');

  const result = await responsePromise;
  assert.deepEqual(result, { decision: 'decline' }, 'reject_once should produce decline');
  await runtime.shutdown();
});

test('allow_always → { decision: acceptForSession } and onAlwaysAllow called with canonical tool name', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

  const alwaysAllowCalls: string[] = [];
  session.onAlwaysAllow = (canonical) => alwaysAllowCalls.push(canonical);

  const responsePromise = client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-approval-test', command: 'npm test' },
  );
  await new Promise((r) => setImmediate(r));

  const [requestId] = session.pendingPermissions.keys();
  session.respondToPermission(requestId, 'allow_always');

  const result = await responsePromise;
  assert.deepEqual(result, { decision: 'acceptForSession' }, 'allow_always should produce acceptForSession');
  assert.deepEqual(
    alwaysAllowCalls,
    ['bash'],
    'onAlwaysAllow should be called with canonical name "bash", not the raw method',
  );
  await runtime.shutdown();
});

test('allow_always for fileChange calls onAlwaysAllow with "edit"', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

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
  assert.deepEqual(result, { decision: 'acceptForSession' });
  assert.deepEqual(alwaysAllowCalls, ['edit'], 'onAlwaysAllow should be called with "edit" for fileChange');
  await runtime.shutdown();
});

test('cancelPermission resolves to decline (null → decline path)', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

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

test('markCrashed cancels all pending permissions with decline', async () => {
  const { runtime, session, client } = await makeRuntimeWithSession();

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

test('approval for unknown threadId → immediate decline (fail-safe)', async () => {
  // Fire a server request with a threadId that has NO associated session.
  // The runtime must not hang or throw — it must immediately respond with decline.
  const client = makeStubClient();
  makeRuntime(client); // runtime with no sessions registered

  const result = await client._fireServerRequest(
    CODEX_SERVER_REQUESTS.commandApproval,
    { threadId: 'thread-that-does-not-exist', command: 'whoami' },
  );

  assert.deepEqual(result, { decision: 'decline' }, 'unknown threadId should get immediate decline');
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
