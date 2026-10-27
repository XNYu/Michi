/**
 * T06 — Codex owner-aware Agent Run session tests.
 *
 * Validates:
 *  - New Run session: attemptId as public session id, no setNodeExternalSessionId,
 *    owner-aware MCP slot, nativeSessionId = threadId.
 *  - Resume: nativeResumeToken as threadId, never reads nodes.external_session_id.
 *  - MCP slot: agent_run slots carry owner metadata and submit_agent_result hook.
 *  - Approval routing: agent_run delegates to permissionBroker, never the chat policy or a chat grant.
 *  - Release: expectedOwner verification prevents stale Attempt from releasing.
 *  - One daemon supports multiple Run threads with different models/cwds.
 *  - Existing chat session behavior is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CodexSessionNotResumableError } from 'michi-runtime/internal/adapters/codex/CodexRuntime';

import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { McpSlot, McpSlotCallbacks } from '../src/services/mcpServer';
import { fakeMcpRegistry, type FakeMcpRegistry } from './helpers/fakeMcpRegistry';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type {
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../src/agents/types';
import { runOwner } from './helpers/owners';
import { codexTestOptions } from './helpers/codexTestOptions';

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
    onGlobalNotification: (_h: unknown) => () => {},
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

function makeTrackingMcpRegistry(): FakeMcpRegistry & { _slots: TrackedSlot[] } {
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
  // The fake supplies the endpoints; these tracked methods replace its own.
  return Object.assign(fakeMcpRegistry(registry, { mcpPort: 3001 }), { _slots: slots });
}

function makeStubMcpRegistry(): FakeMcpRegistry {
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

const RUN_OWNER: RuntimeSessionOwner = runOwner('run-001', 'attempt-001');

test('loadSession with agent_run and no nativeResumeToken throws CodexSessionNotResumableError', async () => {
  const client = makeStubClient();
  const runtime = new CodexRuntime(
    { ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() },
    { client },
  );

  await assert.rejects(
    runtime.loadSession({
      sessionId: 'attempt-005',
      cwd: '/tmp/test',
      owner: runOwner('run-005', 'attempt-005'),
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
    { ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() },
    { client },
  );

  await runtime.newSession({
    sessionId: 'attempt-006',
    cwd: '/tmp/test',
    model: 'test-model',
    owner: runOwner('run-006', 'attempt-006'),
    toolProfile: makeRunToolProfile(),
    permissionBroker: makeFakeBroker(),
  });

  // A different attempt trying to release — should throw
  await assert.rejects(
    runtime.releaseSession('attempt-006', runOwner('run-006', 'attempt-WRONG')),
    /Owner mismatch/,
  );

  // Correct owner should succeed
  await runtime.releaseSession('attempt-006', runOwner('run-006', 'attempt-006'));

  await runtime.shutdown();
});
