import assert from 'node:assert/strict';
import test from 'node:test';
import type { EffectiveAgentDefinitionV1 } from 'michi-shared';
import type { AgentRuntime, AgentSession, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { runOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

// A session that cannot answer a durable interaction must not let an answer
// silently clear it: the Attempt would otherwise continue as if answered.

function definition(): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'test', instructions: 'Follow instructions.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'provider', modelId: 'model', reasoning: 'medium' },
    fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

function spec(): AgentRunSpec {
  return {
    runId: 'run-1', attemptId: 'attempt-1', workspaceId: 'workspace-1', ownerUserId: 'owner-1', task: 'Do the work',
    effectiveDefinition: definition(),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp/worktree', sourceWorkspaceId: 'workspace-1', snapshotHash: 'd'.repeat(64), createdAt: 1 },
    recoveryEnvelope: null,
  };
}

function runtimeFor(interaction: NormalizedEvent) {
  const releases: string[] = [];
  const session: AgentSession = {
    id: 'attempt-1', runtimeId: 'pi', nativeSessionId: null,
    owner: runOwner('run-1', 'attempt-1'),
    getHistory: () => [], getPendingAssistant: () => undefined, cancel: async () => {},
    async *send() {
      yield interaction;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    },
  };
  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'pi', label: 'fake', capabilities: { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['medium'], apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
    async warm() {}, async newSession() { return session; },
    releaseSession(id: string, _owner?: RuntimeSessionOwner) { releases.push(id); }, async shutdown() {},
  };
  return { runtime, releases };
}

const interactions: Array<['permission' | 'user_input', NormalizedEvent]> = [
  ['permission', { kind: 'permission_request', requestId: 7, title: 'Approve write?', options: [] }],
  ['user_input', { kind: 'user_input_request', requestId: 8, questions: [{ question: 'Which file?', options: [], multiSelect: false }] }],
];

for (const [kind, interaction] of interactions) {
  test(`a session without a ${kind} answer method keeps the interaction pending`, async () => {
    const { runtime, releases } = runtimeFor(interaction);
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: new RuntimeRunAdapterRegistry([new PiRunAdapter()]) })
      .start(spec(), async () => {});
    const waiting = await handle.completion;
    assert.equal(waiting.status === 'waiting' && waiting.kind, kind);

    await assert.rejects(handle.input('allow'), new RegExp(`runtime pi cannot answer a pending ${kind} interaction`));
    assert.throws(() => handle.continueAfterInput?.(), /has not been answered/);
    assert.deepEqual(releases, [], 'the waiting Attempt keeps its session');
  });
}
