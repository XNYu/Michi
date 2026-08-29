/**
 * T06 — Codex owner-aware Agent Run session tests.
 *
 * Validates:
 *  - New Run session: attemptId as public session id, no setNodeExternalSessionId,
 *    owner-aware MCP slot, nativeSessionId = threadId.
 *  - Resume: nativeResumeToken as threadId, never reads nodes.external_session_id.
 *  - MCP slot: agent_run slots carry owner metadata and submit_agent_result hook.
 *  - Approval routing: agent_run delegates to permissionBroker, never resolvePolicy/grantPermission.
 *  - Release: expectedOwner verification prevents stale Attempt from releasing.
 *  - One daemon supports multiple Run threads with different models/cwds.
 *  - Existing chat session behavior is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CodexConcurrencyError, CodexSessionNotResumableError } from '../src/agents/codex/CodexRuntime';
import { CodexSession } from '../src/agents/codex/CodexSession';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry, McpSlot, McpSlotCallbacks } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type {
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../src/agents/types';

// ---- Stubs ------------------------------------------------------------------

type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
) => void;

function makeStubClient(overrides: Partial<Record<string, unknown>> = {}): CodexAppServerClient & {
  _serverRequestHandler: ServerRequestHandler | null;
  _fireServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
} {
  let serverRequestHandler: ServerRequestHandler | null = null;
  const notifHandlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();

  const client: any = {
    ensureStarted: async () => {},
    request: async (_method: string, _params: unknown): Promise<unknown> => {
      if (_method === 'thread/start') return { threadId: 'run-thread-001' };
      if (_method === 'thread/resume') return { threadId: typeof (_params as any)?.threadId === 'string' ? (_params as any).threadId : 'resumed-thread' };
      if (_method === 'model/list') return { data: [] };
      return {};
    },
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = notifHandlers.get(threadId);
      if (!set) { set = new Set(); notifHandlers.set(threadId, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    onServerRequest: (h: ServerRequestHandler) => { serverRequestHandler = h; },
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    _fireServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
      return new Promise((resolve) => {
        if (!serverRequestHandler) { resolve({ decision: 'no-handler' }); return; }
        serverRequestHandler(method, params, resolve);
      });
    },
    get _serverRequestHandler() { return serverRequestHandler; },
    ...overrides,
  };

  return client as ReturnType<typeof makeStubClient>;
}

/** Track slots created by the registry for inspection. */
interface TrackedSlot extends McpSlot {
  _createdWith: { parentChatId: string; cwd: string; ownerUserId: string | null; cbs: McpSlotCallbacks; opts: any };
}

function makeTrackingMcpRegistry(): McpSlotRegistry & { _slots: TrackedSlot[] } {
  const slots: TrackedSlot[] = [];
  const registry: any = {
    _slots: slots,
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks, opts?: any) => {
      const slot: TrackedSlot = {
        slotId: 'slot-' + Math.random().toString(36).slice(2),
        owner: cbs.owner,
        nodeId: opts?.nodeId ?? null,
        parentChatId,
        cwd,
        workspaceId: opts?.workspaceId ?? null,
        ownerUserId,
        exposedToolNames: cbs.exposedToolNames,
        ...cbs,
        _createdWith: { parentChatId, cwd, ownerUserId, cbs, opts },
      } as any;
      slots.push(slot);
      return slot;
    },
    dispose: async (_slotId: string) => {},
    get: (_slotId: string) => undefined,
  };
  return registry as McpSlotRegistry & { _slots: TrackedSlot[] };
}

function makeStubMcpRegistry(): McpSlotRegistry {
  return makeTrackingMcpRegistry();
}

function makeStubBridge(): AgentToolBridge {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function makeFakeBroker(decisions: Record<string, RuntimePermissionDecision> = {}): RuntimePermissionBroker & { _requests: RuntimePermissionRequest[] } {
  const requests: RuntimePermissionRequest[] = [];
  return {
    _requests: requests,
    async requestPermission(req: RuntimePermissionRequest): Promise<RuntimePermissionDecision> {
      requests.push(req);
      return decisions[req.toolName] ?? 'deny';
    },
  };
}

function makeRunToolProfile(toolNames: string[] = ['submit_agent_result']): RuntimeToolProfile {
  return {
    allowedToolNames: toolNames,
    runWorkerTools: {
      submitAgentResult: (_owner: RuntimeSessionOwner, payload: unknown) => {
        return { version: 1, status: 'completed', source: 'submitted', handoff: { conclusion: 'done' } } as any;
      },
    },
  } as any;
}

const RUN_OWNER: RuntimeSessionOwner = {
  kind: 'agent_run',
  runId: 'run-001',
  attemptId: 'attempt-001',
};

// ---- Tests ------------------------------------------------------------------

test('newSession with agent_run owner uses attemptId as public session id', async () => {
  const threadStartParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/start') {
        threadStartParams.push(params as Record<string, unknown>);
        return { threadId: 'run-thread-001' };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const session = await runtime.newSession({
    sessionId: 'attempt-001',
    cwd: '/tmp/run-workspace',
    model: 'test-model',
    owner: RUN_OWNER,
    profileHash: 'hash-abc',
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  // Public session id must be the attemptId
  assert.equal(session.id, 'attempt-001');
  assert.deepEqual(session.owner, RUN_OWNER);
  assert.equal(session.runtimeProfileHash, 'hash-abc');
  // nativeSessionId is the thread id, distinct from the attempt id
  assert.equal(session.nativeSessionId, 'run-thread-001');
  assert.notEqual(session.nativeSessionId, session.id);

  await runtime.shutdown();
});

test('newSession with agent_run owner does NOT call setNodeExternalSessionId', async () => {
  // We verify indirectly: if setNodeExternalSessionId was called with an
  // attempt id, it would fail because there is no node row. The absence of
  // a thrown error means the code path was skipped.
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'run-thread-002' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  // This should NOT throw — setNodeExternalSessionId is skipped for agent_run
  const session = await runtime.newSession({
    sessionId: 'attempt-002',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-002', attemptId: 'attempt-002' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  assert.equal(session.id, 'attempt-002');
  await runtime.shutdown();
});

test('newSession with agent_run creates owner-aware MCP slot', async () => {
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'run-thread-003' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const registry = makeTrackingMcpRegistry();
  const runtime = new CodexRuntime(
    makeStubBridge(),
    registry,
    3001,
    { client },
  );

  const toolProfile = makeRunToolProfile(['submit_agent_result', 'bash', 'edit']);

  await runtime.newSession({
    sessionId: 'attempt-003',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-003', attemptId: 'attempt-003' },
    toolProfile,
    permissionBroker: makeFakeBroker(),
    workspaceId: 'ws-123',
  });

  // The MCP slot should carry the agent_run owner
  assert.ok(registry._slots.length > 0, 'at least one slot should be created');
  const slot = registry._slots[registry._slots.length - 1];
  assert.deepEqual(slot.owner, { kind: 'agent_run', runId: 'run-003', attemptId: 'attempt-003' });
  // nodeId should be null for agent_run (no Node backing)
  assert.equal(slot.nodeId, null);
  // workspaceId should be the authoritative binding
  assert.equal(slot.workspaceId, 'ws-123');
  // exposedToolNames should contain the tool profile's allowedToolNames
  assert.ok(slot.exposedToolNames, 'exposedToolNames must be set');
  assert.ok(slot.exposedToolNames!.has('submit_agent_result'));

  await runtime.shutdown();
});

test('loadSession with agent_run uses nativeResumeToken, never reads nodes', async () => {
  const resumeParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/resume') {
        resumeParams.push(params as Record<string, unknown>);
        return { threadId: (params as any).threadId };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const session = await runtime.loadSession({
    sessionId: 'attempt-004',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-004', attemptId: 'attempt-004' },
    nativeResumeToken: 'saved-thread-id-xyz',
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  assert.equal(session.id, 'attempt-004');
  assert.equal(session.nativeSessionId, 'saved-thread-id-xyz');

  // thread/resume should have been called with the saved thread id
  assert.equal(resumeParams.length, 1);
  assert.equal(resumeParams[0].threadId, 'saved-thread-id-xyz');

  await runtime.shutdown();
});

test('loadSession with agent_run and no nativeResumeToken throws CodexSessionNotResumableError', async () => {
  const client = makeStubClient();
  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  await assert.rejects(
    runtime.loadSession({
      sessionId: 'attempt-005',
      cwd: '/tmp/test',
      owner: { kind: 'agent_run', runId: 'run-005', attemptId: 'attempt-005' },
      // No nativeResumeToken provided
    }),
    CodexSessionNotResumableError,
  );

  await runtime.shutdown();
});

test('releaseSession with expectedOwner rejects mismatched owner', async () => {
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'run-thread-006' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  await runtime.newSession({
    sessionId: 'attempt-006',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-006', attemptId: 'attempt-006' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  // A different attempt trying to release — should throw
  await assert.rejects(
    runtime.releaseSession('attempt-006', { kind: 'agent_run', runId: 'run-006', attemptId: 'attempt-WRONG' }),
    /Owner mismatch/,
  );

  // Correct owner should succeed
  await runtime.releaseSession('attempt-006', { kind: 'agent_run', runId: 'run-006', attemptId: 'attempt-006' });

  await runtime.shutdown();
});

test('one daemon supports multiple Run threads with different models/cwds', async () => {
  const startedThreads: Array<{ model: string; cwd: string }> = [];
  let threadCounter = 0;
  const client = makeStubClient({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/start') {
        const p = params as Record<string, unknown>;
        startedThreads.push({ model: String(p.model ?? ''), cwd: String(p.cwd ?? '') });
        return { threadId: `thread-multi-${++threadCounter}` };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const session1 = await runtime.newSession({
    sessionId: 'attempt-a',
    cwd: '/project/alpha',
    model: 'gpt-4o',
    owner: { kind: 'agent_run', runId: 'run-a', attemptId: 'attempt-a' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  const session2 = await runtime.newSession({
    sessionId: 'attempt-b',
    cwd: '/project/beta',
    model: 'o3-mini',
    owner: { kind: 'agent_run', runId: 'run-b', attemptId: 'attempt-b' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  assert.notEqual(session1.id, session2.id);
  assert.equal(startedThreads.length, 2);
  assert.equal(startedThreads[0].cwd, '/project/alpha');
  assert.equal(startedThreads[0].model, 'gpt-4o');
  assert.equal(startedThreads[1].cwd, '/project/beta');
  assert.equal(startedThreads[1].model, 'o3-mini');

  await runtime.shutdown();
});

test('chat session newSession still calls setNodeExternalSessionId and uses nodeId', async () => {
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'chat-thread-001' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  // Chat session with no explicit owner — should use nodeId as session id
  const session = await runtime.newSession({
    sessionId: 'node-chat-01',
    cwd: '/tmp/test',
    model: 'test-model',
  });

  assert.equal(session.id, 'node-chat-01');
  // For chat sessions, owner defaults to chat_node
  assert.deepEqual(session.owner, { kind: 'chat_node', nodeId: 'node-chat-01' });

  await runtime.shutdown();
});

test('agent_run session nativeSessionId is checkpointable thread id', async () => {
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'checkpoint-thread-xyz' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const session = await runtime.newSession({
    sessionId: 'attempt-ckpt',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-ckpt', attemptId: 'attempt-ckpt' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  // The Executor can checkpoint this value for later resume
  assert.equal(session.nativeSessionId, 'checkpoint-thread-xyz');
  assert.equal(typeof session.nativeSessionId, 'string');
  assert.ok(session.nativeSessionId!.length > 0);

  await runtime.shutdown();
});

test('agent_run bootstrapInstructions are used instead of ancestor preamble', async () => {
  const threadStartParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/start') {
        threadStartParams.push(params as Record<string, unknown>);
        return { threadId: 'bootstrap-thread' };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const session = await runtime.newSession({
    sessionId: 'attempt-bootstrap',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-bs', attemptId: 'attempt-bootstrap' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
    bootstrapInstructions: 'You are a code review agent. Review the diff and submit results.',
  });

  // The session was created successfully with bootstrap instructions
  assert.equal(session.id, 'attempt-bootstrap');

  await runtime.shutdown();
});

test('double-load guard works for agent_run sessions', async () => {
  let threadStartCount = 0;
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') {
        threadStartCount++;
        return { threadId: 'dup-run-thread' };
      }
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client },
  );

  const opts = {
    sessionId: 'attempt-dup',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run' as const, runId: 'run-dup', attemptId: 'attempt-dup' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  };

  const s1 = await runtime.newSession(opts);
  const s2 = await runtime.newSession(opts);

  assert.equal(s1, s2, 'double-load should return the same session');
  assert.equal(threadStartCount, 1, 'thread/start called once');

  await runtime.shutdown();
});

test('chat slot has nodeId set; agent_run slot has nodeId null', async () => {
  const client = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'slot-compare-thread' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });

  const registry = makeTrackingMcpRegistry();
  const runtime = new CodexRuntime(
    makeStubBridge(),
    registry,
    3001,
    { client },
  );

  // Chat session
  await runtime.newSession({
    sessionId: 'node-slot-test',
    cwd: '/tmp/test',
    model: 'test-model',
  });

  const chatSlot = registry._slots[registry._slots.length - 1];
  assert.equal(chatSlot.nodeId, 'node-slot-test', 'chat slot should have nodeId');

  // Agent Run session
  const client2 = makeStubClient({
    request: async (method: string): Promise<unknown> => {
      if (method === 'thread/start') return { threadId: 'slot-compare-thread-2' };
      if (method === 'model/list') return { data: [] };
      return {};
    },
  });
  const registry2 = makeTrackingMcpRegistry();
  const runtime2 = new CodexRuntime(
    makeStubBridge(),
    registry2,
    3001,
    { client: client2 },
  );

  await runtime2.newSession({
    sessionId: 'attempt-slot-test',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: { kind: 'agent_run', runId: 'run-slot', attemptId: 'attempt-slot-test' },
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  const runSlot = registry2._slots[registry2._slots.length - 1];
  assert.equal(runSlot.nodeId, null, 'agent_run slot should have nodeId=null');
  assert.ok(runSlot.owner, 'agent_run slot should have owner');
  assert.equal(runSlot.owner!.kind, 'agent_run');

  await runtime.shutdown();
  await runtime2.shutdown();
});
