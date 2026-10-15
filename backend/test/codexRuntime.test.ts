import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../src/services/db';
import { saveWorkspace, saveNode, getNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import assert from 'node:assert/strict';
import { CodexRuntime, CodexConcurrencyError, CodexSessionNotResumableError } from '../src/agents/codex/CodexRuntime';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { ModelInfo } from '../src/agents/types';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';

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
    onGlobalNotification: (_h: unknown) => () => {},
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    isRunning: () => true,
    _emit: (threadId: string, method: string, params: Record<string, unknown>) => {
      for (const handler of notifHandlers.get(threadId) ?? []) handler(method, params);
    },
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

for (const scenario of ['success', 'missing', 'mcp-error', 'wrong-identity']) {
  test(`native Codex restore preserves settings and narrowly classifies failure: ${scenario}`, async () => {
    let disposed = 0;
    const registry = makeStubMcpRegistry();
    registry.dispose = async () => { disposed++; };
    const requested: Record<string, unknown>[] = [];
    const runtime = new CodexRuntime(makeStubBridge(), registry, 3001, {
      client: makeStubClient({ request: async (method: string, params: Record<string, unknown>) => {
        if (method !== 'thread/resume') return {};
        requested.push(params);
        if (scenario === 'missing') throw new Error('no rollout found for thread id original');
        if (scenario === 'mcp-error') throw new Error('MCP server not found');
        return { thread: { id: scenario === 'wrong-identity' ? 'replacement' : 'original' } };
      } }),
    });
    try {
      const result = runtime.loadSession({ sessionId: 'attempt', cwd: '/tmp',
        owner: { kind: 'agent_run', runId: 'run', attemptId: 'attempt' },
        nativeResumeToken: 'original', model: 'new-model', reasoning: 'high' });
      if (scenario === 'success') {
        assert.equal((await result).nativeSessionId, 'original');
        assert.equal(requested[0].model, 'new-model');
        assert.equal(requested[0].reasoningEffort, 'high');
      } else {
        await assert.rejects(result, (error: unknown) => {
          assert.equal(error instanceof NativeResumeUnavailableError, scenario === 'missing');
          return true;
        });
        assert.equal(disposed, 1);
      }
    } finally {
      await runtime.shutdown();
    }
  });
}

// ---- Tests ------------------------------------------------------------------

test('native fork binds the child thread, uses its MCP configuration, and does not replay ancestors', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const runtime = makeRuntime({ request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/fork') return { thread: { id: 'native-child' } };
    return {};
  } });
  try {
    const opts = { sessionId: 'fork-child', cwd: '/tmp', parentChatId: 'absent-parent',
      model: 'child-model', reasoning: 'high' as const, sourceNativeSessionId: 'native-parent' };
    const child = await runtime.forkSession(opts);
    assert.equal(child.id, 'fork-child');
    assert.equal(child.nativeSessionId, 'native-child');
    assert.equal(child.parentChatId, 'absent-parent');
    assert.deepEqual(child.getHistory(), []);
    assert.doesNotMatch((child as any).firstTurnPrefix, /Previous conversation chain/);
    const fork = calls.find((call) => call.method === 'thread/fork')!;
    assert.equal(fork.params.threadId, 'native-parent');
    assert.equal(fork.params.cwd, '/tmp');
    assert.equal(fork.params.model, 'child-model');
    assert.equal(fork.params.reasoningEffort, 'high');
    assert.match(JSON.stringify(fork.params.config), /slot-/);
    assert.equal(fork.params.approvalPolicy, 'on-request');
    assert.equal(fork.params.sandbox, 'workspace-write');
    assert.equal(calls.some((call) => call.method === 'thread/start'), false);
    assert.equal(await runtime.forkSession(opts), child);
    assert.equal(calls.filter((call) => call.method === 'thread/fork').length, 1);
  } finally { await runtime.shutdown(); }
});

for (const scenario of ['missing', 'unsupported', 'auth', 'same-id', 'no-id']) {
  test(`native fork cleans up failed child allocation: ${scenario}`, async () => {
    const registry = makeStubMcpRegistry();
    let disposed = 0;
    registry.dispose = async () => { disposed++; };
    const runtime = new CodexRuntime(makeStubBridge(), registry, 3001, { client: makeStubClient({
      request: async (method: string) => {
        if (method !== 'thread/fork') return {};
        if (scenario === 'missing') throw new Error('no rollout found for thread id native-parent');
        if (scenario === 'unsupported') throw new Error('Method not found');
        if (scenario === 'auth') throw new Error('Authentication failed');
        return { thread: { id: scenario === 'same-id' ? 'native-parent' : undefined } };
      },
    }) });
    try {
      await assert.rejects(runtime.forkSession({ sessionId: `child-${scenario}`, cwd: '/tmp', model: 'test-model',
        sourceNativeSessionId: 'native-parent' }), (error: unknown) => {
        assert.equal(error instanceof NativeResumeUnavailableError, ['missing', 'unsupported'].includes(scenario));
        return true;
      });
      assert.equal(disposed, 1);
    } finally { await runtime.shutdown(); }
  });
}

test('listModels filters hidden models and marks isDefault', async () => {
  const modelListResult = {
    data: [
      { id: 'model-a', displayName: 'Model A', description: 'Fast', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'max', description: '' }], defaultReasoningEffort: 'medium' },
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
  assert.deepEqual(modelA!.supportedReasoningLevels, ['low', 'medium', 'max']);
  assert.equal(modelA!.defaultReasoning, 'medium');

  const modelB = models.find((m) => m.id === 'model-b');
  assert.ok(modelB, 'model-b should be present');
  assert.equal(modelB!.isDefault, undefined, 'model-b should not be marked as default');
  assert.deepEqual(modelB!.supportedReasoningLevels, []);
  assert.equal(modelB!.supportsReasoning, false);

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
    { client, followUpsHookPocEnabled: true, followUpsExperimentMode: 'hook-tool' },
  );

  await runtime.newSession({
    sessionId: 'node-hook-poc',
    cwd: '/tmp/test',
    model: '',
  });

  assert.equal(capturedStartParams.length, 1);
  const developerInstructions = String(capturedStartParams[0].developerInstructions ?? '');
  assert.match(developerInstructions, /runtime's structured metadata tool/);
  assert.doesNotMatch(developerInstructions, /\[FOLLOW-UP/);
  assert.doesNotMatch(developerInstructions, /\[BRANCH-OVERVIEW:/);
  const config = capturedStartParams[0].config as Record<string, unknown>;
  assert.ok(config.mcp_servers, 'existing MCP config must be preserved');
  assert.deepEqual(config.features, { hooks: true });
  assert.equal(config.bypass_hook_trust, true);
  const hooks = config.hooks as { Stop: Array<{ hooks: Array<Record<string, unknown>> }> };
  assert.equal(hooks.Stop[0].hooks[0].type, 'command');
  assert.match(String(hooks.Stop[0].hooks[0].command), /127\.0\.0\.1:3456/);
  const mcpServers = config.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(mcpServers.__michi_internal__.default_tools_approval_mode, 'approve');
  assert.equal(mcpServers.__michi_internal__.tools, undefined);

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

test('default Codex capacity allows more than ten live sessions', async (t) => {
  const previous = process.env.MICHI_CODEX_MAX_CONCURRENT;
  delete process.env.MICHI_CODEX_MAX_CONCURRENT;
  t.after(() => {
    if (previous === undefined) delete process.env.MICHI_CODEX_MAX_CONCURRENT;
    else process.env.MICHI_CODEX_MAX_CONCURRENT = previous;
  });
  let sequence = 0;
  const runtime = makeRuntime({ request: async (method: string) =>
    method === 'thread/start' ? { threadId: `capacity-${++sequence}` } : {},
  });
  t.after(() => runtime.shutdown());
  const sessions = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    runtime.newSession({ sessionId: `capacity-${i}`, cwd: '/tmp', model: 'm1' })));
  assert.equal(new Set(sessions).size, 12);
});

test('explicit cap counts pending allocations and preserves same-id deduplication', async (t) => {
  const previous = process.env.MICHI_CODEX_MAX_CONCURRENT;
  process.env.MICHI_CODEX_MAX_CONCURRENT = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.MICHI_CODEX_MAX_CONCURRENT;
    else process.env.MICHI_CODEX_MAX_CONCURRENT = previous;
  });
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  const runtime = makeRuntime({ request: async (method: string) => {
    if (method === 'thread/start') { started(); await gate; return { threadId: 'limited-thread' }; }
    return {};
  } });
  t.after(() => runtime.shutdown());
  const opts = { sessionId: 'limited', cwd: '/tmp', model: 'm1' };
  const first = runtime.newSession(opts);
  await starting;
  const duplicate = runtime.newSession(opts);
  await assert.rejects(runtime.newSession({ ...opts, sessionId: 'overflow' }), CodexConcurrencyError);
  complete();
  assert.equal(await first, await duplicate);
  await assert.rejects(runtime.newSession({ ...opts, sessionId: 'overflow' }), CodexConcurrencyError);
});

test('idle sweep releases chat resources but preserves busy, draining, recent and Agent Run sessions', async (t) => {
  let sequence = 0;
  const unsubscribed: string[] = [];
  const runtime = makeRuntime({ request: async (method: string, params: any) => {
    if (method === 'thread/start') return { threadId: `idle-thread-${++sequence}` };
    if (method === 'thread/unsubscribe') unsubscribed.push(params.threadId);
    return {};
  } });
  t.after(() => runtime.shutdown());
  const sessions: any[] = [];
  for (const id of ['expired', 'busy', 'draining', 'recent', 'run']) {
    sessions.push(await runtime.newSession({ sessionId: id, cwd: '/tmp', model: 'm1',
      ...(id === 'run' ? { owner: { kind: 'agent_run' as const, runId: 'run', attemptId: id } } : {}) }));
  }
  const [expired, busy, draining, recent, run] = sessions;
  for (const session of [expired, busy, draining, run]) session.lastUsedAt = Date.now() - 360_000;
  busy.state = 'in_turn';
  draining.turnLock = Promise.resolve();
  await (runtime as any).releaseIdleSessions();
  assert.deepEqual(unsubscribed, [expired.threadId]);
  assert.equal((runtime as any).sessions.has(expired.id), false);
  assert.equal((runtime as any).threadToSession.has(expired.threadId), false);
  assert.equal(expired.slotId, null);
  for (const session of [busy, draining, recent, run]) {
    assert.equal((runtime as any).sessions.get(session.id), session);
  }
  // Reusing an old session refreshes its idle deadline.
  recent.lastUsedAt = Date.now() - 360_000;
  assert.equal(sessionRegistry.getSession(recent.id), recent);
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.get(recent.id), recent);
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
  let stubClient!: CodexAppServerClient & { _emit: (threadId: string, method: string, params: Record<string, unknown>) => void };
  stubClient = makeStubClient({
    onExit: (cb: () => void) => {
      capturedOnExit = cb;
      return () => {};
    },
    request: async (method: string, rawParams: unknown): Promise<unknown> => {
      const params = rawParams as Record<string, unknown>;
      if (method === 'model/list') return { data: [{ id: 'm1', displayName: 'M1', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }] };
      if (method === 'thread/start') {
        return params.ephemeral === true
          ? { threadId: 'thread-crash-title' }
          : { threadId: 'thread-crash-test' };
      }
      if (method === 'turn/start' && params.threadId === 'thread-crash-title') {
        setImmediate(() => {
          stubClient._emit('thread-crash-title', 'item/agentMessage/delta', {
            threadId: 'thread-crash-title',
            delta: '{"title":"Crash test"}',
          });
          stubClient._emit('thread-crash-title', 'turn/completed', {
            threadId: 'thread-crash-title',
            turn: { status: 'completed' },
          });
        });
      }
      return {};
    },
  }) as CodexAppServerClient & { _emit: (threadId: string, method: string, params: Record<string, unknown>) => void };

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

test('scheduled idle cleanup preserves durable binding and resumes the original thread', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-codex-idle-'));
  const previous = process.env.MICHI_DATA_DIR;
  closeDb();
  process.env.MICHI_DATA_DIR = directory;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const calls: Array<{ method: string; params: any }> = [];
  const runtime = makeRuntime({ request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { threadId: 'original-idle-thread' };
    if (method === 'thread/resume') return { threadId: params.threadId };
    return {};
  } });
  t.after(async () => {
    await runtime.shutdown();
    closeDb();
    if (previous === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  saveWorkspace({ id: 'idle-ws', name: 'Idle test', created_at: 1, updated_at: 1 } as any);
  saveNode({ id: 'idle-node', workspace_id: 'idle-ws', title: 'Idle test', kind: 'chat',
    status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 } as any);
  const opts = { sessionId: 'idle-node', cwd: '/tmp', model: 'm1', reasoning: 'high' as const };
  const original = await runtime.newSession(opts);
  updateNodeResumeBinding('idle-node', { acp_session_id: original.nativeSessionId!, runtime_id: 'codex',
    model_id: 'm1', provider_id: null, reasoning: 'high', resume_fingerprint: null, current_mode_id: null });
  const binding = getNode('idle-node');
  t.mock.timers.tick(4 * 60_000);
  assert.equal((runtime as any).sessions.get('idle-node'), original);
  t.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessionRegistry.getSession('idle-node'), undefined);
  assert.deepEqual(getNode('idle-node'), binding);
  assert.equal(calls.filter((call) => call.method === 'thread/unsubscribe').length, 1);
  const resumed = await runtime.loadSession(opts);
  assert.notEqual(resumed, original);
  assert.equal(resumed.nativeSessionId, original.nativeSessionId);
  assert.equal(calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1);
  assert.equal(sessionRegistry.getSession('idle-node'), resumed);
});

test('reacquisition waits for idle unsubscribe cleanup before starting a replacement', async (t) => {
  let finishUnsubscribe!: () => void;
  const unsubscribe = new Promise<void>((resolve) => { finishUnsubscribe = resolve; });
  let starts = 0;
  const runtime = makeRuntime({ request: async (method: string) => {
    if (method === 'thread/start') return { threadId: `release-race-${++starts}` };
    if (method === 'thread/unsubscribe') await unsubscribe;
    return {};
  } });
  t.after(() => runtime.shutdown());
  const opts = { sessionId: 'release-race', cwd: '/tmp', model: 'm1' };
  const original: any = await runtime.newSession(opts);
  original.lastUsedAt = Date.now() - 360_000;
  const cleanup = (runtime as any).releaseIdleSessions();
  const next = runtime.newSession(opts);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, 'old unsubscribe must complete before any new acquisition');
  finishUnsubscribe();
  await cleanup;
  assert.notEqual(await next, original);
  assert.equal(starts, 2);
});
