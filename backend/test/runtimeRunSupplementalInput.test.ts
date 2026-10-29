import assert from 'node:assert/strict';
import test from 'node:test';
import { type EffectiveAgentDefinitionV1 } from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { AgentRunExecutionEvent, AgentRunSpec } from '../src/agents/runs/ports';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';
import { michiCodexHostText } from '../src/agents/michiCodexOptions';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function defaultRegistry(): RuntimeRunAdapterRegistry {
  // Keep coverage of the generic fallback strategy independently of live Kiro.
  const nextTurnAdapter = { ...new KiroRunAdapter(), steering: 'next_turn' as const,
    assertCompatible: (runtime: AgentRuntime) => new KiroRunAdapter().assertCompatible(runtime) };
  return new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), nextTurnAdapter, new CodexRunAdapter(),
  ]);
}

function definition(runtimeId: string): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'test', instructions: 'Follow instructions.',
    runtimeProfile: { version: 1, runtimeId, providerId: 'provider', modelId: 'model', reasoning: 'medium' },
    fallbackChain: [], capabilitySnapshot: { version: 1, entries: [{ id: 'read_file', kind: 'tool', revision: '1', schemaHash: 'a'.repeat(64), contentHash: null, configHash: 'b'.repeat(64), publicConfig: {}, credentialBindingIds: [] }] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

function spec(runtimeId: string): AgentRunSpec {
  return {
    runId: 'run-1', attemptId: 'attempt-1', workspaceId: 'workspace-1', ownerUserId: 'owner-1', task: 'Do the work',
    effectiveDefinition: definition(runtimeId),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp/worktree', sourceWorkspaceId: 'workspace-1', snapshotHash: 'd'.repeat(64), createdAt: 1 },
    recoveryEnvelope: null,
  };
}

/**
 * A deferred promise with external resolve/reject control.
 * Used for deterministic synchronization in tests.
 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Kiro-like session: next_turn steering via multi-turn loop
// ---------------------------------------------------------------------------

class KiroLikeRuntime implements AgentRuntime {
  readonly descriptor = UNKNOWN_RUNTIME_DESCRIPTOR;
  id = 'kiro';
  label = 'fake-kiro';
  capabilities = { modes: false, permissions: true, models: false, providerModels: false, reasoning: true, supportedReasoningLevels: ['medium' as const], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: true };
  session!: AgentSession;
  options: NewAgentSessionOptions | null = null;
  releases: Array<[string, RuntimeSessionOwner | undefined]> = [];

  async warm() {}
  async newSession(options: NewAgentSessionOptions) {
    this.options = options;
    if ('runtimeProfileHash' in this.session && options.profileHash) {
      (this.session as any).runtimeProfileHash = options.profileHash;
    }
    return this.session;
  }
  releaseSession(id: string, owner?: RuntimeSessionOwner) { this.releases.push([id, owner]); }
  async shutdown() {}
}

// ---------------------------------------------------------------------------
// Codex-like session: native steering via steer()
// ---------------------------------------------------------------------------

class CodexLikeSession implements AgentSession {
  id = 'attempt-1';
  runtimeId = 'codex';
  owner: RuntimeSessionOwner = runOwner('run-1', 'attempt-1');
  runtimeProfileHash: string | null = null;
  nativeSessionId: string | null = 'thread-abc';
  cancelled = 0;
  steered: string[] = [];

  getHistory() { return []; }
  getPendingAssistant() { return undefined; }

  async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
    yield { kind: 'chunk', text: 'codex answer' };
    yield { kind: 'turn_end', stopReason: 'end_turn' };
  }

  async cancel() { this.cancelled += 1; }
  async steer(text: string) { this.steered.push(text); return { accepted: true }; }
}

class CodexLikeRuntime implements AgentRuntime {
  readonly descriptor = UNKNOWN_RUNTIME_DESCRIPTOR;
  id = 'codex';
  label = 'fake-codex';
  capabilities = { modes: false, permissions: true, models: false, providerModels: false, reasoning: true, supportedReasoningLevels: ['medium' as const], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: true };
  session: CodexLikeSession;
  options: NewAgentSessionOptions | null = null;
  releases: Array<[string, RuntimeSessionOwner | undefined]> = [];

  constructor(session?: CodexLikeSession) {
    this.session = session ?? new CodexLikeSession();
  }

  async warm() {}
  async newSession(options: NewAgentSessionOptions) {
    this.options = options;
    this.session.runtimeProfileHash = options.profileHash ?? null;
    return this.session;
  }
  releaseSession(id: string, owner?: RuntimeSessionOwner) { this.releases.push([id, owner]); }
  async shutdown() {}
}

test('input after terminalization is rejected for codex too', async () => {
  const session = new CodexLikeSession();
  const runtime = new CodexLikeRuntime(session);
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'codex' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('codex'), async () => {});
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  await assert.rejects(
    () => handle.input('too late'),
    /already completed or is finalizing/,
  );
});

// ---------------------------------------------------------------------------
// T08 — Cancellation clears queued inputs and releases session exactly once
// ---------------------------------------------------------------------------

test('cancellation clears queued inputs and releases session exactly once', async () => {
  const firstTurnGate = deferred();
  const sentTexts: string[] = [];
  let cancelCount = 0;

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: runOwner('run-1', 'attempt-1'),
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: 'partial' } as NormalizedEvent;
      // Hang until cancelled
      await firstTurnGate.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    async cancel() {
      cancelCount++;
      firstTurnGate.resolve();
    },
  };

  const runtime = new KiroLikeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('kiro'), async () => {});

  // Wait for the generator to block
  await new Promise((r) => setTimeout(r, 20));

  // Queue some input
  await handle.input('will be cleared');

  // Cancel the run
  await handle.cancel('user requested');

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'cancelled');

  // Session released exactly once despite cancel + turn completion
  assert.equal(runtime.releases.length, 1, 'session released exactly once');
  assert.deepEqual(runtime.releases[0], ['attempt-1', runOwner('run-1', 'attempt-1')]);

  // The queued input was never delivered (only one turn was sent)
  assert.equal(sentTexts.length, 1, 'queued input was cleared, not delivered');
});

// ---------------------------------------------------------------------------
// T08 — Permission wait across next_turn loop
// ---------------------------------------------------------------------------

test('permission wait works correctly within the next_turn multi-turn loop', async () => {
  let permissionResponse: [number, string] | null = null;
  const sentTexts: string[] = [];

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: runOwner('run-1', 'attempt-1'),
    runtimeProfileHash: null, nativeSessionId: 'acp-42',
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: `turn-${sentTexts.length}` } as NormalizedEvent;
      if (sentTexts.length === 2) {
        // Second turn hits a permission request
        yield { kind: 'permission_request', requestId: 42, title: 'Approve write?', options: [] } as NormalizedEvent;
        // After permission is granted, continue
        yield { kind: 'chunk', text: ' continued after permission' } as NormalizedEvent;
      }
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    respondToPermission(requestId: number, optionId: string) {
      permissionResponse = [requestId, optionId];
    },
    async cancel() {},
  };

  const runtime = new KiroLikeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const events: AgentRunExecutionEvent[] = [];
  const handle = await executor.start(spec('kiro'), async (event) => { events.push(event); });

  // Queue input before first turn ends (first turn ends quickly in this fake)
  await handle.input('supplemental');

  // First turn ends, supplemental turn starts, hits permission_request
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'waiting');
  if (outcome.status === 'waiting') {
    assert.equal(outcome.kind, 'permission');
  }

  // Resolve the permission
  await handle.input('allow_once');
  assert.deepEqual(permissionResponse, [42, 'allow_once']);

  // Continue after interaction
  const continued = await handle.continueAfterInput?.();
  assert.equal(continued?.status, 'completed');

  // Two turns were sent (original + supplemental)
  assert.equal(sentTexts.length, 2);
});

// ---------------------------------------------------------------------------
// T08 — No-steering adapter rejects input
// ---------------------------------------------------------------------------

test('none steering adapter rejects supplemental input', async () => {
  const noneAdapter = {
    runtimeId: 'pi',
    supportsNativeResume: false,
    nativeToolMode: 'allowlist' as const,
    steering: 'none' as const,
    assertCompatible: () => {},
  };

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'pi',
    owner: runOwner('run-1', 'attempt-1'),
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(_text: string) {
      yield { kind: 'chunk', text: 'answer' } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    async cancel() {},
  };

  const fakeRuntime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'pi', label: 'fake', capabilities: { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['medium'], apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
    async warm() {}, async newSession() { return session; },
    releaseSession() {}, async shutdown() {},
  };

  const registry = new RuntimeRunAdapterRegistry([noneAdapter]);
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => fakeRuntime, registry });

  const handle = await executor.start(spec('pi'), async () => {});

  await assert.rejects(
    () => handle.input('try to steer'),
    /does not support supplemental input/,
  );
});

// ---------------------------------------------------------------------------
// T08 — Cancellation during permission wait clears pending and releases once
// ---------------------------------------------------------------------------

test('cancellation during permission wait clears pending and releases once', async () => {
  let permissionCancelled = false;

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: runOwner('run-1', 'attempt-1'),
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(_text: string) {
      yield { kind: 'permission_request', requestId: 99, title: 'Allow?', options: [] } as NormalizedEvent;
    },
    cancelPermission(_requestId: number) { permissionCancelled = true; },
    async cancel() {},
  };

  const runtime = new KiroLikeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('kiro'), async () => {});
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'waiting');

  // Cancel while waiting for permission
  await handle.cancel('abort');

  assert.equal(permissionCancelled, true, 'pending permission should be cancelled');
  assert.equal(runtime.releases.length, 1, 'session released exactly once');
});

// ---------------------------------------------------------------------------
// T08 — User input interaction works correctly
// ---------------------------------------------------------------------------

test('user_input interaction is resolved correctly in next_turn mode', async () => {
  let userInputResponse: Array<{ question: string; answer: string }> | null = null;

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: runOwner('run-1', 'attempt-1'),
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(_text: string) {
      yield { kind: 'chunk', text: 'thinking...' } as NormalizedEvent;
      yield { kind: 'user_input_request', requestId: 55, questions: [{ question: 'Which file?' }] } as NormalizedEvent;
      yield { kind: 'chunk', text: ' done' } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>) {
      userInputResponse = answers;
    },
    async cancel() {},
  };

  const runtime = new KiroLikeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('kiro'), async () => {});
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'waiting');
  if (outcome.status === 'waiting') assert.equal(outcome.kind, 'user_input');

  // Resolve the interaction
  await handle.input('src/main.ts');
  assert(userInputResponse !== null, 'user input should have been captured');
  const answers = userInputResponse as Array<{ question: string; answer: string }>;
  assert.equal(answers[0].question, 'Which file?');
  assert.equal(answers[0].answer, 'src/main.ts');

  // Continue
  const continued = await handle.continueAfterInput?.();
  assert.equal(continued?.status, 'completed');
});

// Real sessions make cancellation terminal; a fake `cancel()` counter cannot
// prove that an interrupted native turn still accepts native steering.
test('real Codex Session applies immediate Run input after native interruption as a new turn', async () => {
  const { CodexSession } = require('michi-runtime/internal/adapters/codex/CodexSession') as typeof import('michi-runtime/internal/adapters/codex/CodexSession');
  const handlers = new Set<(method: string, params: any) => void>();
  const starts: string[] = [];
  const methods: string[] = [];
  const nativeEmit = (method: string, params: any) => { for (const handler of handlers) handler(method, params); };
  const client = {
    ensureStarted: async () => {}, onExit: () => () => {}, onGlobalNotification: () => () => {},
    onNotification: (_thread: string, handler: any) => { handlers.add(handler); return () => handlers.delete(handler); },
    async request(method: string, params: any) {
      methods.push(method);
      if (method === 'turn/start') {
        starts.push(JSON.stringify(params.input));
        const turnId = `turn-${starts.length}`;
        if (starts.length === 2) setImmediate(() => nativeEmit('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } }));
        return { turn: { id: turnId } };
      }
      if (method === 'turn/interrupt') nativeEmit('turn/completed', { threadId: 'native-thread', turn: { id: params.turnId, status: 'interrupted' } });
      return {};
    },
  };
  const session = new CodexSession({ nodeId: 'attempt-1', threadId: 'native-thread', cwd: '/tmp', workspaceId: null,
    owner: runOwner('run-1', 'attempt-1'), client: client as any,
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    mcpRegistry: { dispose: async () => {} } as any, host: michiTestHost(), hostText: michiCodexHostText(), enableFollowUps: false,
  });
  session.wireNotifications();
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'codex', label: 'fixture', capabilities: { modes: false, models: true, permissions: true, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['medium'], apiKeys: false, warmSessions: false,
      nativeResume: true, saveContext: true, spawnBranches: true },
    warm: async () => {}, newSession: async () => session,
    releaseSession: async () => { await session.dispose(); }, shutdown: async () => {},
  };
  try {
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, adapters: [new CodexRunAdapter()] }).start(spec('codex'), async () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    await handle.input('urgent additional direction', 'immediate');
    assert.equal((await handle.completion).status, 'completed');
    assert.equal(starts.length, 2);
    assert.match(starts[1], /urgent additional direction/);
    assert.equal(methods.filter((method) => method === 'turn/interrupt').length, 1);
    assert.equal(methods.includes('turn/steer'), false);
  } finally { await session.dispose(); }
});

test('real Pi Session applies immediate Run input after Agent abort as a new turn', async (t) => {
  const { PiSession } = require('../src/agents/pi/PiSession') as typeof import('../src/agents/pi/PiSession');
  const deps = require('../src/agents/runtimeDeps') as typeof import('../src/agents/runtimeDeps');
  deps.configureRuntimeDeps({ dataDir: '/tmp', historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null,
    getWorkspaceInstructions: () => null },
    providerKeys: { getProviderApiKey: () => 'fixture' },
    agentConfig: { getAgentConfig: () => ({ provider: 'deepseek' } as any), resolveModel: () => 'model', resolveReasoning: () => 'medium' },
  });
  t.after(deps.__resetRuntimeDeps);
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  t.mock.method(require('../src/agents/pi/piTools'), 'buildPiTools', () => []);
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ Type: {}, clampThinkingLevel: () => 'medium' }));
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => ({ id: 'model', contextWindow: 1000 }));
  const prompts: string[] = [];
  let aborts = 0;
  let steers = 0;
  class Agent {
    state: any; listener?: (event: any) => void; settle?: () => void;
    constructor(options: any) { this.state = options.initialState; }
    subscribe(listener: (event: any) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
    async prompt(text: string) {
      prompts.push(text);
      if (prompts.length === 1) await new Promise<void>((resolve) => { this.settle = resolve; });
      this.listener?.({ type: 'agent_end' });
    }
    abort() { aborts++; this.settle?.(); }
    steer() { steers++; }
  }
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAgentCore', async () => ({ Agent }));
  const session = new PiSession('attempt-1', { cwd: '/tmp', preamble: '', workspaceId: null, ownerUserId: null,
    enableFollowUps: false, owner: runOwner('run-1', 'attempt-1'),
    requestedProvider: 'deepseek', requestedModel: 'model',
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
  });
  const runtime: AgentRuntime = { descriptor: UNKNOWN_RUNTIME_DESCRIPTOR, id: 'pi', label: 'fixture', capabilities: { modes: false, models: true, permissions: true,
    providerModels: false, reasoning: true, supportedReasoningLevels: ['medium'], apiKeys: false, warmSessions: false,
    nativeResume: false, saveContext: true, spawnBranches: true },
    warm: async () => {}, newSession: async () => session,
    releaseSession: async () => { await session.dispose(); }, shutdown: async () => {},
  };
  try {
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, adapters: [new PiRunAdapter()] }).start(spec('pi'), async () => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prompts.length, 1);
    await handle.input('urgent additional direction', 'immediate');
    assert.equal((await handle.completion).status, 'completed');
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /urgent additional direction/);
    assert.ok(aborts >= 1);
    assert.equal(steers, 0);
  } finally { await session.dispose(); }
});

test('immediate input cannot cancel its next turn when event persistence outlives the original turn', async () => {
  const firstTurn = deferred();
  const eventStarted = deferred();
  const eventWrite = deferred();
  const sent: string[] = [];
  const cancelledTurns: number[] = [];
  let active = 0;
  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro', nativeSessionId: null,
    owner: runOwner('run-1', 'attempt-1'),
    getHistory: () => [], getPendingAssistant: () => undefined,
    async *send(text) {
      const turn = ++active;
      sent.push(text);
      if (turn === 1) await firstTurn.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
    cancel: async () => { cancelledTurns.push(active); firstTurn.resolve(); },
  };
  const runtime = new KiroLikeRuntime(); runtime.session = session;
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() })
    .start(spec('kiro'), async (event) => {
      if (event.type === 'steering_queued') { eventStarted.resolve(); await eventWrite.promise; }
    });
  const immediate = handle.input('urgent', 'immediate');
  await eventStarted.promise;
  firstTurn.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, 'next turn waits for pending interruption persistence/cancellation');
  eventWrite.resolve();
  await immediate;
  assert.equal((await handle.completion).status, 'completed');
  assert.equal(sent.length, 2);
  assert.deepEqual(cancelledTurns, [], 'a naturally completed original turn needs no late cancel');
});

test('a runtime error terminal cannot become an empty completed Run', async () => {
  const runtime = new KiroLikeRuntime();
  runtime.session = { id: 'attempt-1', runtimeId: 'kiro', nativeSessionId: null,
    owner: runOwner('run-1', 'attempt-1'),
    getHistory: () => [], getPendingAssistant: () => undefined, cancel: async () => {},
    async *send() { yield { kind: 'turn_end', stopReason: 'error' }; },
  };
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() })
    .start(spec('kiro'), async () => {});
  assert.equal((await handle.completion).status, 'failed');
});
