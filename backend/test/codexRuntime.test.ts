import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime, CodexConcurrencyError, CodexSessionNotResumableError } from '../src/agents/codex/CodexRuntime';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { ModelInfo } from '../src/agents/types';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';

// ---- Stubs ------------------------------------------------------------------

function makeStubClient(overrides: Partial<Record<string, unknown>> = {}): CodexAppServerClient {
  const notifHandlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const client: any = {
    ensureStarted: async () => {},
    request: async (_method: string, _params: unknown): Promise<unknown> => ({}),
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = notifHandlers.get(threadId);
      if (!set) { set = new Set(); notifHandlers.set(threadId, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    onServerRequest: (_h: unknown) => {},
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    ...overrides,
  };
  return client as CodexAppServerClient;
}

function makeStubMcpRegistry(): McpSlotRegistry {
  const registry: any = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: any, _opts?: any) => ({
      slotId: 'slot-' + Math.random().toString(36).slice(2),
      parentChatId: _parentChatId,
      cwd: _cwd,
      workspaceId: null,
      nodeId: null,
      ownerUserId: null,
      ...cbs,
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

function makeRuntime(
  clientOverrides: Partial<Record<string, unknown>> = {},
  modelCache?: RuntimeModelCache,
): CodexRuntime {
  return new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client: makeStubClient(clientOverrides), modelCache },
  );
}

// ---- Tests ------------------------------------------------------------------

test('listModels filters hidden models and marks isDefault', async () => {
  const modelListResult = {
    data: [
      { id: 'model-a', displayName: 'Model A', description: 'Fast', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' },
      { id: 'model-b', displayName: 'Model B', description: 'Slow', hidden: false, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' },
      { id: 'model-hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' },
    ],
  };

  const runtime = makeRuntime({
    request: async (method: string, _params: unknown): Promise<unknown> => {
      if (method === 'model/list') return modelListResult;
      return {};
    },
  });

  const models = await runtime.listModels();

  assert.equal(models.length, 2, 'hidden model should be filtered out');
  const modelA = models.find((m) => m.id === 'model-a');
  assert.ok(modelA, 'model-a should be present');
  assert.equal(modelA!.label, 'Model A');
  assert.equal(modelA!.isDefault, true, 'model-a should be marked as default');

  const modelB = models.find((m) => m.id === 'model-b');
  assert.ok(modelB, 'model-b should be present');
  assert.equal(modelB!.isDefault, undefined, 'model-b should not be marked as default');

  assert.ok(!models.find((m) => m.id === 'model-hidden'), 'hidden model should not appear');
});
test('listModels returns the disk snapshot immediately and refreshes it in the background', async () => {
  const cached: ModelInfo[] = [{ id: 'cached-model', label: 'Cached model', isDefault: true }];
  let saved: ModelInfo[] | null = null;
  const cache: RuntimeModelCache = {
    load: () => cached,
    save: (_runtimeId, models) => { saved = models; },
  };

  let resolveLive!: (value: unknown) => void;
  let modelListCalls = 0;
  const runtime = makeRuntime({
    request: async (method: string): Promise<unknown> => {
      if (method !== 'model/list') return {};
      modelListCalls += 1;
      return new Promise((resolve) => { resolveLive = resolve; });
    },
  }, cache);

  const first = await runtime.listModels();
  assert.deepEqual(first, cached, 'cached models should not wait for the live RPC');
  assert.equal(modelListCalls, 1, 'returning the snapshot should still start one refresh');

  resolveLive({
    data: [
      { id: 'fresh-model', displayName: 'Fresh model', description: '', hidden: false, isDefault: true },
    ],
  });
  const fresh = await runtime.refreshModels();

  assert.deepEqual(fresh.map((m) => m.id), ['fresh-model']);
  assert.deepEqual(saved, fresh);
});

test('newSession with empty model resolves isDefault from model/list', async () => {
  const threadStartParams: Record<string, unknown>[] = [];

  const runtime = makeRuntime({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'model/list') {
        return {
          data: [
            { id: 'codex-default', displayName: 'Codex Default', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' },
          ],
        };
      }
      if (method === 'thread/start') {
        threadStartParams.push(params as Record<string, unknown>);
        return { threadId: 'thread-abc' };
      }
      return {};
    },
  });

  // Pass sessionId (required by CodexRuntime) but no model (empty → use isDefault)
  const session = await runtime.newSession({
    sessionId: 'node-test-1',
    cwd: '/tmp/test',
    model: '',  // explicitly empty — should fall back to isDefault
  });

  assert.ok(session, 'session should be created');
  assert.equal(session.id, 'node-test-1');

  assert.equal(threadStartParams.length, 1, 'thread/start should be called once');
  const startParams = threadStartParams[0];
  assert.equal(startParams['model'], 'codex-default', 'thread/start should pass the isDefault model');
  const defaultConfig = startParams['config'] as Record<string, unknown>;
  assert.equal(defaultConfig['hooks'], undefined, 'Hook POC must stay off by default');
  assert.equal(defaultConfig['bypass_hook_trust'], undefined);

  await runtime.shutdown();
});

test('Codex follow-ups Hook POC injects temporary Hook config alongside the MCP slot', async () => {
  const capturedStartParams: Record<string, unknown>[] = [];
  const client = makeStubClient({
    request: async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'model/list') {
        return {
          data: [{
            id: 'codex-default',
            displayName: 'Codex Default',
            description: '',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
          }],
        };
      }
      if (method === 'thread/start') {
        capturedStartParams.push(params as Record<string, unknown>);
        return { threadId: 'thread-hook-poc' };
      }
      return {};
    },
  });
  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3456,
    { client, followUpsHookPocEnabled: true, followUpsExperimentMode: 'sentinel' },
  );

  await runtime.newSession({
    sessionId: 'node-hook-poc',
    cwd: '/tmp/test',
    model: '',
  });

  assert.equal(capturedStartParams.length, 1);
  const config = capturedStartParams[0].config as Record<string, unknown>;
  assert.ok(config.mcp_servers, 'existing MCP config must be preserved');
  assert.deepEqual(config.features, { hooks: true });
  assert.equal(config.bypass_hook_trust, true);
  const hooks = config.hooks as { Stop: Array<{ hooks: Array<Record<string, unknown>> }> };
  assert.equal(hooks.Stop[0].hooks[0].type, 'command');
  assert.match(String(hooks.Stop[0].hooks[0].command), /127\.0\.0\.1:3456/);
  const mcpServers = config.mcp_servers as Record<string, { tools: Record<string, unknown> }>;
  assert.deepEqual(mcpServers.__michi_internal__.tools, {
    set_branch_overview: { approval_mode: 'approve' },
  });

  await runtime.shutdown();
});

test('newSession double-load guard returns existing session without re-creating', async () => {
  let threadStartCount = 0;

  const runtime = makeRuntime({
    request: async (method: string, _params: unknown): Promise<unknown> => {
      if (method === 'model/list') return { data: [{ id: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }] };
      if (method === 'thread/start') {
        threadStartCount++;
        return { threadId: 'thread-dup' };
      }
      return {};
    },
  });

  const opts = { sessionId: 'node-dup', cwd: '/tmp/test' };

  const session1 = await runtime.newSession(opts);
  const session2 = await runtime.newSession(opts);

  assert.equal(session1, session2, 'double-load guard should return identical session object');
  assert.equal(threadStartCount, 1, 'thread/start should be called only once');

  await runtime.shutdown();
});

test('newSession throws CodexConcurrencyError when cap is reached', async () => {
  // Set cap to 1 via env — but since we construct directly, use concurrencyCap override
  // Instead, we test by filling up to cap=1 using a tiny env mock:
  // We can't easily override the env-parsed cap, so we use the default cap (10)
  // and instead test the error shape with a runtime that has cap=1.
  // We achieve cap=1 by filling the sessions map directly (internal white-box test).

  const runtime = makeRuntime({
    request: async (method: string, _params: unknown): Promise<unknown> => {
      if (method === 'model/list') return { data: [{ id: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }] };
      if (method === 'thread/start') return { threadId: 'thread-cap-' + Math.random().toString(36).slice(2) };
      return {};
    },
  });

  // Fill up 10 sessions (default cap)
  const filledIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `cap-node-${i}`;
    filledIds.push(id);
    await runtime.newSession({ sessionId: id, cwd: '/tmp/test' });
  }

  // 11th should throw
  await assert.rejects(
    runtime.newSession({ sessionId: 'cap-node-overflow', cwd: '/tmp/test' }),
    CodexConcurrencyError,
  );

  await runtime.shutdown();
});

test('loadSession without external_session_id throws CodexSessionNotResumableError', async () => {
  // Use a sessionId that does not exist in the real SQLite DB — getNode returns
  // null/undefined so external_session_id is null, which triggers the error.
  const runtime = makeRuntime({
    request: async (method: string, _params: unknown): Promise<unknown> => {
      if (method === 'model/list') return { data: [{ id: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }] };
      return {};
    },
  });

  await assert.rejects(
    runtime.loadSession({ sessionId: 'nonexistent-node-no-external-id', cwd: '/tmp/test' }),
    CodexSessionNotResumableError,
  );

  await runtime.shutdown();
});

test('daemon exit marks sessions crashed and terminates in-flight drain', async () => {
  let capturedOnExit: (() => void) | null = null;

  // Build a client that captures the onExit callback so we can trigger it.
  const stubClient = makeStubClient({
    onExit: (cb: () => void) => {
      capturedOnExit = cb;
      return () => {};
    },
    request: async (method: string, _params: unknown): Promise<unknown> => {
      if (method === 'model/list') return { data: [{ id: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }] };
      if (method === 'thread/start') return { threadId: 'thread-crash-test' };
      return {};
    },
  });

  const runtime = new CodexRuntime(
    makeStubBridge(),
    makeStubMcpRegistry(),
    3001,
    { client: stubClient },
  );

  // Create a session so it is tracked by the runtime
  const session = await runtime.newSession({ sessionId: 'crash-test-node', cwd: '/tmp/test' });

  // Start a send that will remain in-flight (notification never arrives)
  const drainPromise = (async () => {
    const events: string[] = [];
    for await (const ev of session.send('hello')) {
      events.push(ev.kind);
      // Collect events until turn_end
      if (ev.kind === 'turn_end') break;
    }
    return events;
  })();

  // Give the send loop time to start
  await new Promise((r) => setTimeout(r, 10));

  // Trigger the daemon exit — this should mark the session crashed
  assert.ok(capturedOnExit, 'onExit callback should have been registered');
  (capturedOnExit as () => void)();

  // The drain should resolve with a turn_end (terminal safety invariant)
  const events = await drainPromise;
  assert.ok(events.includes('turn_end'), `drain should end with turn_end, got: ${events.join(', ')}`);
});
