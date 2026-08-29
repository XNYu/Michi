import assert from 'node:assert/strict';
import test from 'node:test';
import type { EffectiveAgentDefinitionV1, ResultBundleV1 } from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import type { RunWorkerToolProfile } from '../src/agents/runs/runWorkerTools';

function definition(): EffectiveAgentDefinitionV1 {
  return { version: 1, name: 'Pi worker', description: 'integration fake', instructions: 'Use Pi instructions',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'anthropic', modelId: 'pi-model', reasoning: 'high' }, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: false, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 } };
}

function runSpec(): AgentRunSpec {
  return { runId: 'pi-run', attemptId: 'pi-attempt', workspaceId: 'ws', ownerUserId: 'user', task: 'Pi task', effectiveDefinition: definition(),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
    executionEnvironment: { version: 1, kind: 'git_worktree', cwd: '/tmp/pi-worktree', sourceWorkspaceId: 'ws', baseCommit: 'abc', snapshotHash: 'a'.repeat(64), createdAt: 1 }, recoveryEnvelope: null };
}

class PiTransportSession implements AgentSession {
  id = 'pi-attempt'; runtimeId = 'pi'; owner: RuntimeSessionOwner = { kind: 'agent_run', runId: 'pi-run', attemptId: 'pi-attempt' };
  runtimeProfileHash: string | null = null;
  getHistory() { return []; } getPendingAssistant() { return undefined; } cancel() {}
  async *send() { yield { kind: 'chunk' as const, text: 'unstructured fallback must lose' }; yield { kind: 'turn_end' as const }; }
}

test('fake Pi transport receives a node-free Run profile and structured submission wins', async () => {
  const session = new PiTransportSession(); let options: NewAgentSessionOptions | null = null; let loads = 0;
  const runtime: AgentRuntime = {
    id: 'pi', label: 'Pi fake', capabilities: { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['high'], apiKeys: true, warmSessions: false, saveContext: true, spawnBranches: false, nativeResume: false },
    async warm() {},
    async newSession(opts) {
      options = opts; session.runtimeProfileHash = opts.profileHash ?? null;
      const result: ResultBundleV1 = { version: 1, status: 'completed', source: 'inferred', handoff: { conclusion: 'Pi structured result', artifactsOrChanges: '', unresolvedIssues: '' }, artifacts: [], resourceMutations: [], externalActions: [] };
      (opts.toolProfile as RunWorkerToolProfile).runWorkerTools.submitAgentResult(opts.owner!, result);
      return session;
    },
    async loadSession() { loads += 1; return session; }, releaseSession() {}, async shutdown() {},
  };
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, adapters: [new PiRunAdapter()] });
  const handle = await executor.resume(runSpec(), 'ignored-pi-token', async () => {});
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.resultBundle.handoff.conclusion, 'Pi structured result');
  assert.equal(loads, 0, 'Pi must use replay/new-session fallback instead of native resume');
  const captured = options as NewAgentSessionOptions | null;
  assert(captured);
  assert.equal(captured.parentChatId, undefined);
  assert.equal(captured.provider, 'anthropic');
  assert.equal(captured.model, 'pi-model');
  assert.equal(captured.reasoning, 'high');
  assert.equal(captured.cwd, '/tmp/pi-worktree');
});
