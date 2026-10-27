import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../src/services/db';
import { saveWorkspace, saveNode, getNode, updateNodeResumeBinding } from '../src/services/dbRepository';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import assert from 'node:assert/strict';
import {
  CODEX_BACKGROUND_IDLE_CAP_MS,
  CODEX_BACKGROUND_IDLE_TTL_MS,
  CODEX_IDLE_TTL_MS,
  CodexRuntime,
  CodexConcurrencyError,
  CodexSessionNotResumableError,
  type CodexAdapterOptions,
} from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import { codexAdapterOptions } from '../src/agents/runtimeFactories';
import type { CodexAppServerClient } from 'michi-runtime/internal/adapters/codex/CodexAppServerClient';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { fakeMcpRegistry, type FakeMcpRegistry } from './helpers/fakeMcpRegistry';
import type { AgentSession, ModelInfo } from '../src/agents/types';
import type { SessionRegistryPort } from 'michi-runtime/internal/contract/host';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';
import { NativeResumeUnavailableError, nativeResumeIdFor } from '../src/services/nativeResume';
import { SUBAGENT_SESSION_ENDED_ERROR, type SubagentEnd } from 'michi-shared';
import { backgroundSubagentRegistry, type BackgroundSubagentContext } from '../src/services/backgroundSubagentRegistry';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';
import { codexTestOptions } from './helpers/codexTestOptions';

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

function makeStubMcpRegistry(mcpPort = 3001): FakeMcpRegistry {
  return fakeMcpRegistry({}, { mcpPort });
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
  options: Partial<CodexAdapterOptions> = {},
): CodexRuntime {
  return new CodexRuntime(
    { ...codexTestOptions({ modelCache, ...options }), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() },
    { client: makeStubClient(clientOverrides) },
  );
}

for (const enabled of [true, false]) test(`the title thread follows the host's title policy (enabled: ${enabled})`, async () => {
  const host = michiTestHost();
  host.title = { ...host.title, enabled: (runtimeId) => { assert.equal(runtimeId, 'codex'); return enabled; } };
  let threads = 0;
  const runtime = new CodexRuntime({ ...codexTestOptions({ host }), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() }, { client: makeStubClient({
    request: async (method: string) => (method === 'thread/start' ? { thread: { id: `title-policy-${++threads}` } } : {}),
  }) });
  try {
    const chat = await runtime.newSession({ sessionId: `title-chat-${enabled}`, cwd: '/tmp', model: 'm' });
    const run = await runtime.newSession({ sessionId: `title-run-${enabled}`, cwd: '/tmp', model: 'm',
      owner: runOwner('r', `title-run-${enabled}`) });
    assert.equal((chat as any).generateTitleOnFirstTurn, enabled);
    assert.equal((run as any).generateTitleOnFirstTurn, false, 'Agent Runs never title');
  } finally {
    await runtime.shutdown();
  }
});

test('CodexRuntime refuses the old positional arguments with a TypeError', () => {
  const Untyped = CodexRuntime as unknown as new (...args: unknown[]) => unknown;
  const expected = { name: 'TypeError', message: 'CodexRuntime takes one options object { host, bridge, mcpSlots, … } (runtime contract v1)' };
  const client = makeStubClient();
  assert.throws(() => new Untyped(makeStubBridge(), makeStubMcpRegistry(), codexTestOptions(), { client }), expected);
  assert.throws(() => new Untyped(undefined, { client }), expected);
  assert.throws(() => new Untyped({ ...codexTestOptions(), mcpSlots: makeStubMcpRegistry() }, { client }), expected);
  assert.throws(() => new Untyped({ ...codexTestOptions(), bridge: makeStubBridge() }, { client }), expected);
  // Present but undefined counts as missing, as a factory's `deps.mcpRegistry!` can be.
  assert.throws(() => new Untyped({ ...codexTestOptions(), bridge: undefined, mcpSlots: undefined }, { client }), expected);
  assert.throws(() => new Untyped({ ...codexTestOptions(), host: undefined, bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() }, { client }), expected);
});

test('codexAdapterOptions parses the environment as the adapter did, with a 10s Codex title deadline', () => {
  const host = michiTestHost();
  const defaults = codexAdapterOptions({ host }, {});
  assert.equal(defaults.host, host);
  assert.equal(defaults.titleTimeoutMs?.(), 10_000);
  if (process.env.MICHI_CODEX_TITLE_TIMEOUT_MS === undefined) {
    // Not the title model's 15s default the host reports for the sidecar-title runtimes.
    assert.equal(host.config.titleModel?.('codex').timeoutMs, 15_000);
  }
  assert.equal(defaults.binaryPath, undefined);
  assert.equal(defaults.codexHome, undefined);
  assert.equal(defaults.rpcTimeoutMs, 30_000);
  assert.equal(defaults.initTimeoutMs, 30_000);
  assert.equal(defaults.approveTimeoutMs, 300_000);
  assert.ok(Number.isNaN(defaults.maxConcurrent), 'no cap');
  assert.equal(defaults.followUpsHook, undefined);

  const env: NodeJS.ProcessEnv = {
    CODEX_CLI_BIN: '/opt/codex', CODEX_HOME: '', MICHI_CODEX_RPC_TIMEOUT_MS: '5',
    MICHI_CODEX_INIT_TIMEOUT_MS: 'soon', MICHI_APPROVE_TIMEOUT_MS: '7', MICHI_CODEX_MAX_CONCURRENT: '2',
    MICHI_CODEX_FOLLOW_UPS_HOOK_POC: ' On ', MICHI_DATA_DIR: '/data',
  };
  const parsed = codexAdapterOptions({ host }, env);
  assert.equal(parsed.binaryPath, '/opt/codex');
  assert.equal(parsed.codexHome, '');
  assert.equal(parsed.spawnEnv?.(), env);
  assert.equal(parsed.rpcTimeoutMs, 5);
  assert.ok(Number.isNaN(parsed.initTimeoutMs));
  assert.equal(parsed.approveTimeoutMs, 7);
  assert.equal(parsed.maxConcurrent, 2);
  assert.deepEqual(parsed.followUpsHook, { isolatedCodexHome: path.resolve('/data/codex-follow-ups-hook-poc') });
  env.MICHI_CODEX_TITLE_TIMEOUT_MS = '2500';
  assert.equal(parsed.titleTimeoutMs?.(), 2_500, 'read at each title');

  assert.deepEqual(codexAdapterOptions({ host }, {
    MICHI_CODEX_FOLLOW_UPS_HOOK_POC: '1', MICHI_CODEX_FOLLOW_UPS_HOOK_HOME: 'poc-home', MICHI_DATA_DIR: '/data',
  }).followUpsHook, { isolatedCodexHome: path.resolve('poc-home') });
  assert.equal(codexAdapterOptions({ host }, { MICHI_CODEX_FOLLOW_UPS_HOOK_POC: '0' }).followUpsHook, undefined);
});

for (const [label, env, deadlineMs] of [
  ['unset', {}, 10_000],
  ['2500', { MICHI_CODEX_TITLE_TIMEOUT_MS: '2500' }, 2_500],
] as const) test(`a chat's title thread times out after ${deadlineMs}ms (MICHI_CODEX_TITLE_TIMEOUT_MS ${label})`, async (t) => {
  const host = michiTestHost();
  host.title = { ...host.title, enabled: () => true };
  const failures: string[] = [];
  host.observability = {
    ...host.observability,
    log: (_level, _scope, msg, data) => { if (msg.includes('title generation failed')) failures.push(String(data?.error)); },
  };
  let titleTurnStarted = false;
  const client = makeStubClient({ request: async (method: string, params: any) => {
    if (method === 'thread/start') return { thread: { id: params.ephemeral ? 'deadline-title' : 'deadline-main' } };
    if (method === 'turn/start' && params.threadId === 'deadline-title') { titleTurnStarted = true; return {}; }
    if (method === 'turn/start') {
      setImmediate(() => (client as any)._emit('deadline-main', 'turn/completed', { threadId: 'deadline-main', turn: { status: 'completed' } }));
      return { turn: { id: 'main-turn' } };
    }
    return {};
  } });
  const runtime = new CodexRuntime({ ...codexAdapterOptions({ host }, env), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() }, { client });
  t.after(() => runtime.shutdown());
  const session = await runtime.newSession({ sessionId: `deadline-${label}`, cwd: '/tmp', model: 'm', enableFollowUps: false });
  const flush = async (until: () => boolean = () => false) => {
    for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kinds: string[] = [];
  const drained = (async () => { for await (const event of session.send('Name this deadline test')) kinds.push(event.kind); })();
  await flush(() => titleTurnStarted);
  assert.ok(titleTurnStarted);
  t.mock.timers.tick(deadlineMs - 1);
  await flush();
  assert.deepEqual(failures, []);
  assert.ok(!kinds.includes('turn_end'), 'the turn waits for its title');
  t.mock.timers.tick(1);
  await drained;
  assert.deepEqual(failures, [`codex title generation timed out after ${deadlineMs}ms`]);
  assert.ok(kinds.includes('title') && kinds.includes('turn_end'), kinds.join(', '));
});

test('a chat binding resumes the external session id, else the ACP column; the host asks Codex first', async () => {
  const runtime = makeRuntime();
  try {
    const rows = [null, undefined, {}, { acp_session_id: 'acp' }, { external_session_id: 'ext' },
      { acp_session_id: 'acp', external_session_id: 'ext' }, { id: 'node', acp_session_id: 'node', external_session_id: null }];
    // services/nativeResume's former Codex rule, byte for byte.
    assert.deepEqual(rows.map((row) => runtime.resumeTokenFromBinding(row)), [null, null, null, 'acp', 'ext', 'ext', 'node']);
    for (const row of rows) assert.equal(nativeResumeIdFor(runtime, row), runtime.resumeTokenFromBinding(row));
    // A runtime without the method keeps the host's own rule (the ACP column first).
    assert.equal(nativeResumeIdFor({ id: 'kiro' }, { acp_session_id: 'acp', external_session_id: 'ext' }), 'acp');
  } finally {
    await runtime.shutdown();
  }
});

for (const scenario of ['success', 'missing', 'mcp-error', 'wrong-identity']) {
  test(`native Codex restore preserves settings and narrowly classifies failure: ${scenario}`, async () => {
    let disposed = 0;
    const registry = makeStubMcpRegistry();
    registry.dispose = async () => { disposed++; };
    const requested: Record<string, unknown>[] = [];
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: registry }, {
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
        owner: runOwner('run', 'attempt'),
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

for (const scenario of ['missing', 'unsupported', 'auth', 'same-id', 'no-id']) {
  test(`native fork cleans up failed child allocation: ${scenario}`, async () => {
    const registry = makeStubMcpRegistry();
    let disposed = 0;
    registry.dispose = async () => { disposed++; };
    const runtime = new CodexRuntime({ ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: registry }, { client: makeStubClient({
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

test('empty Codex model RPC keeps its cached snapshot without persisting an empty catalog', async () => {
  const cached = [{ id: 'cached-model' }];
  const saved: ModelInfo[][] = [];
  const runtime = makeRuntime({ request: async () => ({ data: [] }) }, {
    load: () => cached,
    save: (_runtimeId, models) => { saved.push(models); },
  });
  try {
    assert.deepEqual(await runtime.refreshModels(), cached);
    assert.deepEqual(saved, []);
  } finally { await runtime.shutdown(); }
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
    { ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry(3456) },
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

test('explicit cap counts pending allocations and preserves same-id deduplication', async (t) => {
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => { complete = resolve; });
  // The factory reads MICHI_CODEX_MAX_CONCURRENT=1 into this option.
  const runtime = makeRuntime({ request: async (method: string) => {
    if (method === 'thread/start') { started(); await gate; return { threadId: 'limited-thread' }; }
    return {};
  } }, undefined, { maxConcurrent: codexAdapterOptions({ host: michiTestHost() }, { MICHI_CODEX_MAX_CONCURRENT: '1' }).maxConcurrent });
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
      ...(id === 'run' ? { owner: runOwner('run', id) } : {}) }));
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

test('idle sweep keeps a session holding background children up to the background TTL', async (t) => {
  assert.equal(CODEX_IDLE_TTL_MS, 5 * 60_000);
  assert.equal(CODEX_BACKGROUND_IDLE_TTL_MS, 2 * 60 * 60_000);
  let sequence = 0;
  const unsubscribed: string[] = [];
  const runtime = makeRuntime({ request: async (method: string, params: any) => {
    if (method === 'thread/start') return { threadId: `bg-idle-thread-${++sequence}` };
    if (method === 'thread/unsubscribe') unsubscribed.push(params.threadId);
    return {};
  } });
  t.after(() => runtime.shutdown());
  const sessions: any[] = [];
  for (const id of ['plain', 'running-child', 'idle-completion']) {
    sessions.push(await runtime.newSession({ sessionId: id, cwd: '/tmp', model: 'm1' }));
  }
  const [plain, runningChild, idleCompletion] = sessions;
  const child = (status: 'working' | 'terminated') => ({
    sessionId: 'child', sessionName: 'child', agentName: 'codex', initialQuery: '', status,
    group: '', dependsOn: [], source: 'codex', background: true,
  });
  // A background child still running after its parent turn.
  runningChild.childThreadInfos.set('child', child('working'));
  // One that finished while the parent was idle, not yet reported by a turn.
  idleCompletion.childThreadInfos.set('child', child('terminated'));
  idleCompletion.idleChildCompletions.add('child');
  assert.deepEqual(sessions.map((session) => session.hasBackgroundWork()), [false, true, true]);
  const past = (ms: number) => Date.now() - ms - 1_000;

  for (const session of sessions) session.lastUsedAt = past(CODEX_IDLE_TTL_MS);
  await (runtime as any).releaseIdleSessions();
  assert.deepEqual(unsubscribed, [plain.threadId], 'only the session without background work goes after five minutes');
  assert.equal((runtime as any).sessions.has(plain.id), false);
  for (const session of [runningChild, idleCompletion]) assert.equal((runtime as any).sessions.get(session.id), session);

  for (const session of [runningChild, idleCompletion]) session.lastUsedAt = past(CODEX_BACKGROUND_IDLE_TTL_MS - 60_000);
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.size, 2, 'kept just under two hours');

  for (const session of [runningChild, idleCompletion]) session.lastUsedAt = past(CODEX_BACKGROUND_IDLE_TTL_MS);
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.size, 0, 'a child that never reports cannot hold the session forever');
  assert.deepEqual([...unsubscribed].sort(), [plain.threadId, runningChild.threadId, idleCompletion.threadId].sort());
  assert.deepEqual(sessions.map((session) => session.hasBackgroundWork()), [false, false, false], 'released sessions hold nothing');
});

test('a background child that keeps reporting keeps its session past two hours, up to the cap', async (t) => {
  const runtime = makeRuntime({ request: async (method: string) => (method === 'thread/start' ? { threadId: 'bg-active-thread' } : {}) });
  t.after(() => runtime.shutdown());
  const session: any = await runtime.newSession({ sessionId: 'bg-active', cwd: '/tmp', model: 'm1' });
  session.childThreadInfos.set('child', {
    sessionId: 'child', sessionName: 'child', agentName: 'codex', initialQuery: '', status: 'working',
    group: '', dependsOn: [], source: 'codex', background: true,
  });
  assert.equal(CODEX_BACKGROUND_IDLE_CAP_MS, 6 * 60 * 60_000);
  const now = Date.now();
  // The parent's last turn was over two hours ago, but the child sent a
  // frame a minute ago: it still works.
  session.lastUsedAt = now - CODEX_BACKGROUND_IDLE_TTL_MS - 60_000;
  session.lastChildActivityAt = now - 60_000;
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.get(session.id), session, 'kept while its child reports');

  // Quiet children for the TTL: released.
  session.lastChildActivityAt = now - CODEX_BACKGROUND_IDLE_TTL_MS - 1_000;
  assert.equal(session.isBackgroundIdleExpired(now, CODEX_BACKGROUND_IDLE_TTL_MS, CODEX_BACKGROUND_IDLE_CAP_MS), true);
  // A recent child frame holds it again, within the cap.
  session.lastChildActivityAt = now - 1_000;
  assert.equal(session.isBackgroundIdleExpired(now, CODEX_BACKGROUND_IDLE_TTL_MS, CODEX_BACKGROUND_IDLE_CAP_MS), false);
  // Past the cap, an active child no longer holds it.
  session.lastUsedAt = now - CODEX_BACKGROUND_IDLE_CAP_MS - 1_000;
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.has(session.id), false, 'the cap releases it whatever the child does');
});

test('a session released at the background bound records its children as ended', async (t) => {
  const ended: Array<{ context: BackgroundSubagentContext; ends: SubagentEnd[] }> = [];
  // The process-wide registry: record what the session tells it, store nothing.
  t.mock.method(backgroundSubagentRegistry, 'end', (context: BackgroundSubagentContext, _source: string, ends: readonly SubagentEnd[]) => {
    ended.push({ context, ends: [...ends] });
  });
  const runtime = makeRuntime({ request: async (method: string) => (method === 'thread/start' ? { threadId: 'bg-bound-thread' } : {}) });
  t.after(() => runtime.shutdown());
  const session: any = await runtime.newSession({ sessionId: 'bg-bound', cwd: '/tmp', model: 'm1' });
  session.childThreadInfos.set('running', {
    sessionId: 'running', sessionName: 'child', agentName: 'codex', initialQuery: '', status: 'working',
    group: '', dependsOn: [], source: 'codex', background: true,
  });
  session.childThreadInfos.set('finished', {
    sessionId: 'finished', sessionName: 'child', agentName: 'codex', initialQuery: '', status: 'terminated',
    outcome: 'completed', result: 'Found 3 issues', endedAt: 1_234,
    group: '', dependsOn: [], source: 'codex', background: true,
  });
  session.idleChildCompletions.add('finished');
  const now = Date.now();
  // Past the normal TTL but within the background one: kept, nothing ended.
  session.lastUsedAt = now - CODEX_IDLE_TTL_MS - 60_000;
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.get(session.id), session);
  assert.equal(ended.length, 0);

  // Past the cap: released, and its children recorded as ended.
  session.lastUsedAt = now - CODEX_BACKGROUND_IDLE_CAP_MS - 1_000;
  const before = Date.now();
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.has(session.id), false);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].context.nodeId, 'bg-bound');
  const byId = new Map(ended[0].ends.map((end) => [end.sessionId, end]));
  assert.equal(byId.size, 2);
  const stopped = byId.get('running')!;
  assert.equal(stopped.outcome, 'cancelled');
  assert.equal(stopped.error, SUBAGENT_SESSION_ENDED_ERROR);
  assert.ok(stopped.endedAt! >= before);
  assert.deepEqual(byId.get('finished'), { sessionId: 'finished', outcome: 'completed', endedAt: 1_234, result: 'Found 3 issues' },
    'one that finished while idle keeps its outcome');
});

test('a child frame records activity for the background TTL', async (t) => {
  const handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
  const runtime = makeRuntime({
    request: async (method: string) => (method === 'thread/start' ? { threadId: 'bg-frame-thread' } : {}),
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      handlers.set(threadId, handler);
      return () => handlers.delete(threadId);
    },
  });
  t.after(() => runtime.shutdown());
  const session: any = await runtime.newSession({ sessionId: 'bg-frame', cwd: '/tmp', model: 'm1' });
  session.trackChildThread('child-frame', {
    sessionId: 'child-frame', sessionName: 'child', agentName: 'codex', initialQuery: '', status: 'working',
    group: '', dependsOn: [], source: 'codex',
  }, false);
  const handler = handlers.get('child-frame');
  assert.ok(handler, 'the child thread is listened to');
  assert.equal(session.lastChildActivityAt, 0);
  const before = Date.now();
  handler('item/started', { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test' } });
  assert.ok(session.lastChildActivityAt >= before);
});

test('a busy session is not released whatever its background work', async (t) => {
  const runtime = makeRuntime({ request: async (method: string) => (method === 'thread/start' ? { threadId: 'bg-busy-thread' } : {}) });
  t.after(() => runtime.shutdown());
  const session: any = await runtime.newSession({ sessionId: 'bg-busy', cwd: '/tmp', model: 'm1' });
  session.childThreadInfos.set('child', {
    sessionId: 'child', sessionName: 'child', agentName: 'codex', initialQuery: '', status: 'working',
    group: '', dependsOn: [], source: 'codex', background: true,
  });
  session.state = 'in_turn';
  session.lastUsedAt = Date.now() - CODEX_BACKGROUND_IDLE_TTL_MS * 2;
  await (runtime as any).releaseIdleSessions();
  assert.equal((runtime as any).sessions.get(session.id), session);
  session.state = 'idle';
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
    { ...codexTestOptions(), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() },
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
  const opts = { sessionId: 'idle-node', cwd: '/tmp', model: 'm1', reasoning: 'high' as const, enableFollowUps: false };
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
  const resume = calls.find((call) => call.method === 'thread/resume')!;
  assert.match(resume.params.developerInstructions, /call mcp____michi_internal____set_branch_overview exactly once/);
  assert.doesNotMatch(resume.params.developerInstructions, /\[BRANCH-OVERVIEW: 1-3/);
  assert.match(resume.params.developerInstructions, /Follow-ups are disabled/);
  assert.equal((resumed as any).enableFollowUps, false);
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

test('new, child, resumed and released sessions reach the host sessions port, not the process registry', async (t) => {
  const calls: string[] = [];
  const live = new Map<string, AgentSession>();
  const sessions: SessionRegistryPort = {
    ensureAncestorChainLoaded: (chatId) => { calls.push(`ensureAncestorChainLoaded ${chatId}`); },
    getSession: (chatId) => { calls.push(`getSession ${chatId}`); return live.get(chatId); },
    getAncestors: (chatId) => { calls.push(`getAncestors ${chatId}`); return []; },
    registerSession: (session) => { calls.push(`registerSession ${session.id}`); live.set(session.id, session); },
    dropSession: (chatId) => { calls.push(`dropSession ${chatId}`); live.delete(chatId); },
  };
  let starts = 0;
  const runtime = new CodexRuntime({ ...codexTestOptions({ host: { ...michiTestHost(), sessions } }), bridge: makeStubBridge(), mcpSlots: makeStubMcpRegistry() }, {
    client: makeStubClient({ request: async (method: string, params: any) => {
      if (method === 'thread/start') return { threadId: `port-thread-${++starts}` };
      if (method === 'thread/resume') return { threadId: params.threadId };
      return {};
    } }),
  });
  t.after(() => runtime.shutdown());
  const ids = ['port-parent', 'port-child', 'port-attempt'];
  await runtime.newSession({ sessionId: 'port-parent', cwd: '/tmp', model: 'm1', enableFollowUps: false });
  await runtime.newSession({ sessionId: 'port-child', parentChatId: 'port-parent', cwd: '/tmp', model: 'm1', enableFollowUps: false });
  await runtime.loadSession({ sessionId: 'port-attempt', cwd: '/tmp', model: 'm1',
    owner: runOwner('port-run', 'port-attempt'), nativeResumeToken: 'port-native' });
  for (const id of ids) assert.equal(sessionRegistry.getSession(id), undefined, id);
  for (const id of ids) await runtime.releaseSession(id);
  assert.deepEqual(calls, [
    'registerSession port-parent',
    'ensureAncestorChainLoaded port-parent',
    'getSession port-parent',
    'getAncestors port-parent',
    'registerSession port-child',
    'registerSession port-attempt',
    'dropSession port-parent',
    'dropSession port-child',
    'dropSession port-attempt',
  ]);
  assert.equal(live.size, 0);
});
