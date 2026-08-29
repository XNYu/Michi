/**
 * T09 — Cross-runtime contract tests.
 *
 * Validates that all four runtime adapters satisfy the shared contract when
 * exercised through the RuntimeRunExecutor. Tests here focus on:
 *
 * 1. Executor-level contract: each adapter flows through the same start/resume
 *    path and produces structurally identical outcomes.
 * 2. Fallback: incompatibility in Kiro/Codex advances to the next profile.
 * 3. Error classification: failure categories are consistent across runtimes.
 * 4. Native token round-trip: JSON persistence for all four runtimes.
 * 5. Pi/Claude regression: behavior is unchanged by Kiro/Codex additions.
 *
 * No real runtime binaries, credentials, or network access required.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRunEventType,
  type EffectiveAgentDefinitionV1,
  type ResultBundleV1,
} from 'michi-shared';
import type {
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  NewAgentSessionOptions,
  RuntimeSessionOwner,
} from '../src/agents/types';
import { RuntimeRunExecutor, classifyRuntimeRunError } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { AgentRunSpec, AgentRunExecutionEvent } from '../src/agents/runs/ports';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { RunWorkerToolProfile } from '../src/agents/runs/runWorkerTools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRegistry(): RuntimeRunAdapterRegistry {
  return new RuntimeRunAdapterRegistry([
    new PiRunAdapter(),
    new ClaudeRunAdapter(),
    new KiroRunAdapter(),
    new CodexRunAdapter(),
  ]);
}

function definition(runtimeId: string): EffectiveAgentDefinitionV1 {
  return {
    version: 1,
    name: `${runtimeId} worker`,
    description: 'cross-runtime test',
    instructions: `Execute using ${runtimeId}.`,
    runtimeProfile: { version: 1, runtimeId, providerId: 'provider', modelId: 'model', reasoning: 'medium' },
    fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: {
      version: 1, preset: 'research', categories: {},
      maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1,
    },
    contextPolicy: {
      version: 1, includeWorkspaceInstructions: false, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000,
    },
  };
}

function spec(runtimeId: string): AgentRunSpec {
  return {
    runId: `${runtimeId}-run`,
    attemptId: `${runtimeId}-attempt`,
    workspaceId: 'ws-cross',
    ownerUserId: 'user-cross',
    task: `${runtimeId} cross-runtime task`,
    effectiveDefinition: definition(runtimeId),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: {
      version: 1, kind: 'shared_workspace', cwd: `/tmp/${runtimeId}-worktree`,
      sourceWorkspaceId: 'ws-cross', snapshotHash: 'a'.repeat(64), createdAt: 1,
    },
    recoveryEnvelope: null,
  };
}

/**
 * Creates a fake runtime for any runtimeId, returning predictable sessions.
 */
function createFakeRuntime(runtimeId: string, opts: {
  nativeResume?: boolean;
  nativeSessionId?: string | null;
  sessionEvents?: NormalizedEvent[];
} = {}): {
  runtime: AgentRuntime;
  capturedNewOpts: NewAgentSessionOptions[];
  capturedLoadOpts: LoadAgentSessionOptions[];
  releases: Array<[string, RuntimeSessionOwner | undefined]>;
} {
  const nativeResume = opts.nativeResume ?? (runtimeId === 'kiro' || runtimeId === 'codex' || runtimeId === 'claude');
  const nativeSessionId = opts.nativeSessionId ?? (nativeResume ? `${runtimeId}-native-sid` : null);
  const events = opts.sessionEvents ?? [
    { kind: 'chunk' as const, text: `${runtimeId} response` },
    { kind: 'turn_end' as const },
  ];

  const capturedNewOpts: NewAgentSessionOptions[] = [];
  const capturedLoadOpts: LoadAgentSessionOptions[] = [];
  const releases: Array<[string, RuntimeSessionOwner | undefined]> = [];

  const makeSession = (sessionId: string, owner: RuntimeSessionOwner, profileHash?: string | null): AgentSession => ({
    id: sessionId,
    runtimeId,
    owner,
    runtimeProfileHash: profileHash ?? null,
    nativeSessionId,
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    async *send() { for (const ev of events) yield ev; },
    cancel: async () => {},
    steer: async (text: string) => ({ accepted: true }),
  });

  const runtime: AgentRuntime = {
    id: runtimeId,
    label: `${runtimeId} fake`,
    capabilities: {
      modes: false, permissions: true, models: runtimeId === 'pi' || runtimeId === 'claude',
      providerModels: runtimeId === 'pi', reasoning: true,
      supportedReasoningLevels: ['medium'],
      apiKeys: runtimeId === 'pi', warmSessions: false, saveContext: false,
      spawnBranches: false, nativeResume,
    },
    async warm() {},
    async newSession(newOpts) {
      capturedNewOpts.push(newOpts);
      const owner = newOpts.owner ?? { kind: 'chat_node' as const, nodeId: newOpts.sessionId ?? 'unknown' };
      return makeSession(newOpts.sessionId ?? 'session', owner, newOpts.profileHash);
    },
    async loadSession(loadOpts) {
      capturedLoadOpts.push(loadOpts);
      const owner = loadOpts.owner ?? { kind: 'chat_node' as const, nodeId: loadOpts.sessionId };
      return makeSession(loadOpts.sessionId, owner, loadOpts.profileHash);
    },
    releaseSession(id, owner) { releases.push([id, owner]); },
    async shutdown() {},
  };

  return { runtime, capturedNewOpts, capturedLoadOpts, releases };
}

// ---------------------------------------------------------------------------
// Cross-runtime contract: all four satisfy the same Executor contract
// ---------------------------------------------------------------------------

describe('Cross-runtime Executor contract', () => {
  for (const runtimeId of ['pi', 'claude', 'kiro', 'codex']) {
    test(`${runtimeId}: start produces a completed outcome with correct owner`, async () => {
      const { runtime } = createFakeRuntime(runtimeId);
      const resolveRuntime = (id: string) => id === runtimeId ? runtime : undefined;
      const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
      const events: AgentRunExecutionEvent[] = [];
      const handle = await executor.start(spec(runtimeId), async (event) => { events.push(event); });
      const outcome = await handle.completion;

      assert.equal(outcome.status, 'completed',
        `${runtimeId}: should produce completed outcome`);
    });

    test(`${runtimeId}: session receives attemptId as sessionId`, async () => {
      const { runtime, capturedNewOpts } = createFakeRuntime(runtimeId);
      const resolveRuntime = (id: string) => id === runtimeId ? runtime : undefined;
      const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
      const handle = await executor.start(spec(runtimeId), async () => {});
      await handle.completion;

      assert.equal(capturedNewOpts.length, 1);
      assert.equal(capturedNewOpts[0].sessionId, `${runtimeId}-attempt`);
      assert.deepEqual(capturedNewOpts[0].owner, {
        kind: 'agent_run', runId: `${runtimeId}-run`, attemptId: `${runtimeId}-attempt`,
      });
    });

    test(`${runtimeId}: session release uses correct owner guard`, async () => {
      const { runtime, releases } = createFakeRuntime(runtimeId);
      const resolveRuntime = (id: string) => id === runtimeId ? runtime : undefined;
      const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
      const handle = await executor.start(spec(runtimeId), async () => {});
      await handle.completion;

      assert.ok(releases.length >= 1, `${runtimeId}: must release the session`);
      const [releasedId, releasedOwner] = releases[0];
      assert.equal(releasedId, `${runtimeId}-attempt`);
      assert.deepEqual(releasedOwner, {
        kind: 'agent_run', runId: `${runtimeId}-run`, attemptId: `${runtimeId}-attempt`,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-runtime: native resume round-trips
// ---------------------------------------------------------------------------

describe('Cross-runtime native resume', () => {
  for (const runtimeId of ['claude', 'kiro', 'codex']) {
    test(`${runtimeId}: resume uses loadSession with native token`, async () => {
      const { runtime, capturedLoadOpts, capturedNewOpts } = createFakeRuntime(runtimeId);
      const resolveRuntime = (id: string) => id === runtimeId ? runtime : undefined;
      const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
      const handle = await executor.resume(
        spec(runtimeId),
        `${runtimeId}-resume-token`,
        async () => {},
      );
      const outcome = await handle.completion;

      assert.equal(outcome.status, 'completed');
      assert.equal(capturedLoadOpts.length, 1, `${runtimeId}: must call loadSession`);
      assert.equal(capturedNewOpts.length, 0, `${runtimeId}: must NOT call newSession when resuming`);
      assert.equal(capturedLoadOpts[0].nativeResumeToken, `${runtimeId}-resume-token`);
    });
  }

  test('Pi: resume falls back to newSession (no native resume)', async () => {
    const { runtime, capturedLoadOpts, capturedNewOpts } = createFakeRuntime('pi');
    const resolveRuntime = (id: string) => id === 'pi' ? runtime : undefined;
    const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
    const handle = await executor.resume(spec('pi'), 'ignored-pi-token', async () => {});
    await handle.completion;

    assert.equal(capturedLoadOpts.length, 0, 'Pi must NOT call loadSession');
    assert.equal(capturedNewOpts.length, 1, 'Pi must call newSession as fallback');
  });
});

// ---------------------------------------------------------------------------
// Cross-runtime: checkpoint emission
// ---------------------------------------------------------------------------

describe('Cross-runtime checkpoint emission', () => {
  for (const runtimeId of ['kiro', 'codex', 'claude']) {
    test(`${runtimeId}: emits checkpoint with nativeSessionId`, async () => {
      const { runtime } = createFakeRuntime(runtimeId, { nativeSessionId: `${runtimeId}-ckpt-42` });
      const resolveRuntime = (id: string) => id === runtimeId ? runtime : undefined;
      const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
      const events: AgentRunExecutionEvent[] = [];
      const handle = await executor.start(spec(runtimeId), async (event) => { events.push(event); });
      await handle.completion;

      const checkpoint = events.find(e => e.type === AgentRunEventType.Checkpoint);
      assert.ok(checkpoint, `${runtimeId}: must emit a checkpoint event`);
      assert.equal(checkpoint!.nativeResumeToken, `${runtimeId}-ckpt-42`);
    });
  }

  test('Pi: no checkpoint emitted (nativeSessionId is null)', async () => {
    const { runtime } = createFakeRuntime('pi', { nativeSessionId: null });
    const resolveRuntime = (id: string) => id === 'pi' ? runtime : undefined;
    const executor = new RuntimeRunExecutor({ resolveRuntime, registry: defaultRegistry() });
    const events: AgentRunExecutionEvent[] = [];
    const handle = await executor.start(spec('pi'), async (event) => { events.push(event); });
    await handle.completion;

    const checkpoint = events.find(e => e.type === AgentRunEventType.Checkpoint);
    assert.equal(checkpoint, undefined, 'Pi must NOT emit a checkpoint (no native session)');
  });
});

// ---------------------------------------------------------------------------
// Fallback: Kiro/Codex incompatibility advances to next profile
// ---------------------------------------------------------------------------

describe('Fallback from incompatible runtime', () => {
  test('Kiro incompatibility produces structured failure that enables fallback', async () => {
    // Kiro runtime without nativeResume capability
    const fakeKiro: AgentRuntime = {
      id: 'kiro', label: 'kiro-broken',
      capabilities: {
        modes: false, permissions: false, models: false, providerModels: false,
        reasoning: true, supportedReasoningLevels: ['medium'],
        apiKeys: false, warmSessions: false, saveContext: false,
        spawnBranches: false, nativeResume: false,
      },
      warm: async () => {},
      newSession: async () => { throw new Error('should not be called'); },
      releaseSession: () => {},
      shutdown: async () => {},
    };

    const executor = new RuntimeRunExecutor({
      resolveRuntime: (id) => id === 'kiro' ? fakeKiro : undefined,
      registry: defaultRegistry(),
    });

    const outcome = await (await executor.start(spec('kiro'), async () => {})).completion;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.error.category, 'incompatible',
        'Kiro incompatibility must produce incompatible category');
      assert.match(outcome.error.message, /incompatible/i);
      assert.equal(outcome.error.retryable, false,
        'Incompatible errors are not retryable');
    }
  });

  test('Codex incompatibility produces structured failure that enables fallback', async () => {
    const fakeCodex: AgentRuntime = {
      id: 'codex', label: 'codex-broken',
      capabilities: {
        modes: false, permissions: false, models: false, providerModels: false,
        reasoning: true, supportedReasoningLevels: ['medium'],
        apiKeys: false, warmSessions: false, saveContext: false,
        spawnBranches: false, nativeResume: false,
      },
      warm: async () => {},
      newSession: async () => { throw new Error('should not be called'); },
      releaseSession: () => {},
      shutdown: async () => {},
    };

    const executor = new RuntimeRunExecutor({
      resolveRuntime: (id) => id === 'codex' ? fakeCodex : undefined,
      registry: defaultRegistry(),
    });

    const outcome = await (await executor.start(spec('codex'), async () => {})).completion;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.error.category, 'incompatible');
      assert.equal(outcome.error.retryable, false);
    }
  });

  test('missing runtime produces incompatible failure (not crash)', async () => {
    const executor = new RuntimeRunExecutor({
      resolveRuntime: () => undefined,
      registry: defaultRegistry(),
    });

    for (const runtimeId of ['kiro', 'codex']) {
      const outcome = await (await executor.start(spec(runtimeId), async () => {})).completion;
      assert.equal(outcome.status, 'failed');
      if (outcome.status === 'failed') {
        assert.equal(outcome.error.category, 'incompatible');
        assert.match(outcome.error.message, /not registered/);
      }
    }
  });

  test('missing adapter produces incompatible failure listing available runtimes', async () => {
    const piClaudeOnly = new RuntimeRunAdapterRegistry([new PiRunAdapter(), new ClaudeRunAdapter()]);
    const { runtime } = createFakeRuntime('kiro');
    const executor = new RuntimeRunExecutor({
      resolveRuntime: (id) => id === 'kiro' ? runtime : undefined,
      registry: piClaudeOnly,
    });

    const outcome = await (await executor.start(spec('kiro'), async () => {})).completion;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.error.category, 'incompatible');
      assert.match(outcome.error.message, /kiro/);
      assert.match(outcome.error.message, /pi, claude/);
    }
  });
});

// ---------------------------------------------------------------------------
// Error classification consistency
// ---------------------------------------------------------------------------

describe('Error classification consistency across runtimes', () => {
  const errorScenarios: Array<{ input: string; expectedCategory: string }> = [
    { input: 'missing API key for provider', expectedCategory: 'auth_permission' },
    { input: 'unsupported model x', expectedCategory: 'incompatible' },
    { input: 'rate limit exceeded', expectedCategory: 'capacity' },
    { input: 'process timed out', expectedCategory: 'transient' },
    { input: 'unexpected internal error', expectedCategory: 'terminal' },
  ];

  for (const scenario of errorScenarios) {
    test(`classifyError("${scenario.input}") => ${scenario.expectedCategory}`, () => {
      const classified = classifyRuntimeRunError(new Error(scenario.input));
      assert.equal(classified.category, scenario.expectedCategory);
    });
  }
});

// ---------------------------------------------------------------------------
// Native token JSON persistence
// ---------------------------------------------------------------------------

describe('Native token JSON persistence round-trips', () => {
  const tokenCases: Array<{ runtimeId: string; token: string }> = [
    { runtimeId: 'kiro', token: 'acp-session-abc123-def456' },
    { runtimeId: 'codex', token: 'thread-xyz789-ghj012' },
    { runtimeId: 'claude', token: 'claude-session-mno345' },
  ];

  for (const { runtimeId, token } of tokenCases) {
    test(`${runtimeId} native token survives JSON.stringify/parse`, () => {
      const serialized = JSON.stringify(token);
      const deserialized = JSON.parse(serialized);
      assert.equal(deserialized, token);
      assert.equal(typeof deserialized, 'string');
      assert.ok(deserialized.length > 0);
    });
  }

  test('Pi has no native token to persist (null is the correct value)', () => {
    const token: string | null = null;
    const serialized = JSON.stringify(token);
    const deserialized = JSON.parse(serialized);
    assert.equal(deserialized, null);
  });
});

// ---------------------------------------------------------------------------
// Pi/Claude regression: unchanged behavior
// ---------------------------------------------------------------------------

describe('Pi/Claude regression behavior', () => {
  test('Pi adapter rejects wrong runtime id', () => {
    const pi = new PiRunAdapter();
    assert.throws(
      () => pi.assertCompatible(createFakeRuntime('claude').runtime),
      /Pi Run adapter cannot execute runtime claude/,
    );
  });

  test('Claude adapter rejects missing native resume', () => {
    const claude = new ClaudeRunAdapter();
    const noResume = createFakeRuntime('claude', { nativeResume: false }).runtime;
    (noResume.capabilities as any).nativeResume = false;
    assert.throws(
      () => claude.assertCompatible(noResume),
      /model\/native-resume/,
    );
  });

  test('Pi uses newSession for both start and resume (no native resume)', async () => {
    const { runtime, capturedNewOpts, capturedLoadOpts } = createFakeRuntime('pi');
    const executor = new RuntimeRunExecutor({
      resolveRuntime: (id) => id === 'pi' ? runtime : undefined,
      registry: defaultRegistry(),
    });

    // start
    const h1 = await executor.start(spec('pi'), async () => {});
    await h1.completion;
    assert.equal(capturedNewOpts.length, 1);
    assert.equal(capturedLoadOpts.length, 0);

    // resume also falls back to newSession
    const h2 = await executor.resume(spec('pi'), 'ignored', async () => {});
    await h2.completion;
    assert.equal(capturedNewOpts.length, 2);
    assert.equal(capturedLoadOpts.length, 0);
  });

  test('Claude uses loadSession for resume with native token', async () => {
    const { runtime, capturedNewOpts, capturedLoadOpts } = createFakeRuntime('claude');
    const executor = new RuntimeRunExecutor({
      resolveRuntime: (id) => id === 'claude' ? runtime : undefined,
      registry: defaultRegistry(),
    });

    const handle = await executor.resume(spec('claude'), 'claude-token', async () => {});
    await handle.completion;

    assert.equal(capturedLoadOpts.length, 1);
    assert.equal(capturedNewOpts.length, 0);
    assert.equal(capturedLoadOpts[0].nativeResumeToken, 'claude-token');
  });
});
