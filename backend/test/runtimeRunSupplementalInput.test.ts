import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRunEventType,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { AgentRunExecutionEvent, AgentRunSpec } from '../src/agents/runs/ports';
import type { NormalizedEvent } from '../src/services/chatEvents';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function defaultRegistry(): RuntimeRunAdapterRegistry {
  return new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter(),
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
  owner: RuntimeSessionOwner = { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' };
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

// ---------------------------------------------------------------------------
// T08 — Kiro queued input starts a second turn after the first turn ends
// ---------------------------------------------------------------------------

test('kiro queued input starts a second turn after the first turn ends', async () => {
  // Gate controls: the first turn blocks until we explicitly release it,
  // giving us time to call handle.input() deterministically.
  const firstTurnGate = deferred();
  const sentTexts: string[] = [];

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: 'acp-session-42',
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: `response` } as NormalizedEvent;
      if (sentTexts.length === 1) await firstTurnGate.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
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

  // Wait a tick to ensure the generator has entered the first turn and is
  // now blocked on firstTurnGate
  await new Promise((r) => setTimeout(r, 20));

  // While the first turn is still active, submit queued input
  await handle.input('additional guidance', 'queued');

  // Verify SteeringQueued event was emitted
  const queued = events.find((e) => e.type === AgentRunEventType.SteeringQueued);
  assert(queued, 'should emit SteeringQueued event');
  assert.equal((queued.payload as any).mode, 'queued');

  // Now let the first turn complete
  firstTurnGate.resolve();

  // Wait for overall completion
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // Verify two turns were sent
  assert.equal(sentTexts.length, 2, 'should have sent two turns');
  assert.match(sentTexts[0], /Do the work/, 'first turn is the original task');
  assert.match(sentTexts[1], /Supplemental instruction/, 'second turn has supplemental prefix');
  assert.match(sentTexts[1], /additional guidance/, 'second turn contains the user text');

  // Verify SteeringApplied event was emitted
  const applied = events.find((e) => e.type === AgentRunEventType.SteeringApplied);
  assert(applied, 'should emit SteeringApplied event');
  assert.equal((applied.payload as any).text, 'additional guidance');

  // Session was released exactly once
  assert.equal(runtime.releases.length, 1);
});

// ---------------------------------------------------------------------------
// T08 — Kiro immediate input cancels then starts the second turn
// ---------------------------------------------------------------------------

test('kiro immediate input cancels and then starts the second turn', async () => {
  const firstTurnGate = deferred();
  const sentTexts: string[] = [];
  let cancelCount = 0;

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: 'acp-session-42',
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: `response` } as NormalizedEvent;
      if (sentTexts.length === 1) await firstTurnGate.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    async cancel() {
      cancelCount++;
      // Cancel unblocks the waiting first turn
      firstTurnGate.resolve();
    },
  };

  const runtime = new KiroLikeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const events: AgentRunExecutionEvent[] = [];
  const handle = await executor.start(spec('kiro'), async (event) => { events.push(event); });

  // Wait for the generator to block on firstTurnGate
  await new Promise((r) => setTimeout(r, 20));

  // Submit immediate input — should cancel the first turn
  await handle.input('urgent direction', 'immediate');

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // Verify cancel was called
  assert.equal(cancelCount, 1, 'immediate input should cancel the current turn');

  // Verify the SteeringQueued event indicates interruption
  const queued = events.find((e) => e.type === AgentRunEventType.SteeringQueued);
  assert(queued, 'should emit SteeringQueued event for immediate input');
  assert.equal((queued.payload as any).mode, 'immediate');
  assert.equal((queued.payload as any).interrupted, true);

  // Verify two turns were sent
  assert.equal(sentTexts.length, 2, 'should send original task then supplemental');
  assert.match(sentTexts[1], /urgent direction/);

  // Session was released exactly once
  assert.equal(runtime.releases.length, 1);
});

// ---------------------------------------------------------------------------
// T08 — Codex queued input calls native steer instead of opening a second turn
// ---------------------------------------------------------------------------

test('codex queued input calls native steer instead of opening a second turn', async () => {
  const session = new CodexLikeSession();
  const runtime = new CodexLikeRuntime(session);
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'codex' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const events: AgentRunExecutionEvent[] = [];
  const handle = await executor.start(spec('codex'), async (event) => { events.push(event); });

  // Submit queued input — should delegate to native steer
  await handle.input('steer this way');

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // Verify steer was called, not a second turn
  assert.deepEqual(session.steered, ['steer this way']);

  // No SteeringQueued/SteeringApplied events for native steering
  assert.equal(events.filter((e) => e.type === AgentRunEventType.SteeringQueued).length, 0);
  assert.equal(events.filter((e) => e.type === AgentRunEventType.SteeringApplied).length, 0);

  // Session released exactly once
  assert.equal(runtime.releases.length, 1);
});

// ---------------------------------------------------------------------------
// T08 — Codex immediate input cancels then steers
// ---------------------------------------------------------------------------

test('codex immediate input cancels and then steers', async () => {
  const session = new CodexLikeSession();
  const runtime = new CodexLikeRuntime(session);
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'codex' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('codex'), async () => {});
  await handle.input('urgent steer', 'immediate');

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  assert.equal(session.cancelled, 1, 'immediate mode cancels before steering');
  assert.deepEqual(session.steered, ['urgent steer']);
});

// ---------------------------------------------------------------------------
// T08 — Input accepted before terminalization prevents premature Result Bundle
// ---------------------------------------------------------------------------

test('input accepted before terminalization prevents premature Result Bundle finalization', async () => {
  // The session's first turn ends synchronously. We submit input before
  // awaiting completion. Since queuedInput is set before the loop reads it,
  // a second turn fires and the Result Bundle includes both turns' output.
  const sentTexts: string[] = [];
  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: 'acp-42',
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: `turn` } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
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

  // Submit input while the executor is still running. Even though the first
  // turn may end quickly, the enqueue happens before consume() checks for
  // queued input because both run on the same microtask queue.
  await handle.input('pre-terminalization input');

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // The input should have been delivered as a second turn
  assert.equal(sentTexts.length, 2, 'input before terminalization should produce a second turn');
  assert.match(sentTexts[1], /pre-terminalization input/);
});

// ---------------------------------------------------------------------------
// T08 — Input after terminalization is rejected deterministically
// ---------------------------------------------------------------------------

test('input after terminalization is rejected deterministically', async () => {
  const sentTexts: string[] = [];
  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: 'done' } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
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
  assert.equal(outcome.status, 'completed');

  // Now try to submit input — should be rejected
  await assert.rejects(
    () => handle.input('too late'),
    /already completed or is finalizing/,
  );
});

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
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
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
  assert.deepEqual(runtime.releases[0], ['attempt-1', { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' }]);

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
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
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
// T08 — Multiple supplemental inputs: last-write wins for queued
// ---------------------------------------------------------------------------

test('multiple queued inputs: last-write wins', async () => {
  const firstTurnGate = deferred();
  const sentTexts: string[] = [];

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(text: string) {
      sentTexts.push(text);
      yield { kind: 'chunk', text: `turn` } as NormalizedEvent;
      if (sentTexts.length === 1) await firstTurnGate.promise;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
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

  // Wait for the generator to block
  await new Promise((r) => setTimeout(r, 20));

  // Queue multiple inputs — last one wins
  await handle.input('first queued');
  await handle.input('second queued');
  await handle.input('third queued');

  // Let the first turn end
  firstTurnGate.resolve();

  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // Only two turns: original + the last queued input
  assert.equal(sentTexts.length, 2);
  assert.match(sentTexts[1], /third queued/, 'last-write wins');
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
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    runtimeProfileHash: null, nativeSessionId: null,
    getHistory() { return []; }, getPendingAssistant() { return undefined; },
    async *send(_text: string) {
      yield { kind: 'chunk', text: 'answer' } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    },
    async cancel() {},
  };

  const fakeRuntime: AgentRuntime = {
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
// T08 — Existing cancel behavior preserved with native steering
// ---------------------------------------------------------------------------

test('existing native steering and cancellation behavior preserved for codex', async () => {
  const session = new CodexLikeSession();
  const runtime = new CodexLikeRuntime(session);
  const executor = new RuntimeRunExecutor({
    resolveRuntime: (id) => id === 'codex' ? runtime : undefined,
    registry: defaultRegistry(),
  });

  const handle = await executor.start(spec('codex'), async () => {});
  await handle.input('queued direction');
  await handle.input('urgent direction', 'immediate');
  await handle.cancel('stop');

  assert.deepEqual(session.steered, ['queued direction', 'urgent direction']);
  // Cancel from immediate + cancel from handle.cancel
  assert.equal(session.cancelled, 2);
  assert(runtime.releases.every(([id, owner]) =>
    id === 'attempt-1' && owner?.kind === 'agent_run' && owner.attemptId === 'attempt-1',
  ));
});

// ---------------------------------------------------------------------------
// T08 — Cancellation during permission wait clears pending and releases once
// ---------------------------------------------------------------------------

test('cancellation during permission wait clears pending and releases once', async () => {
  let permissionCancelled = false;

  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'kiro',
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
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
    owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
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
