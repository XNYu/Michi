import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRunEventType, type EffectiveAgentDefinitionV1 } from 'michi-shared';
import type { AgentRuntime, AgentSession, LoadAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import type { AgentRunSpec } from '../src/agents/runs/ports';

function definition(): EffectiveAgentDefinitionV1 {
  return { version: 1, name: 'Claude worker', description: 'integration fake', instructions: 'Use Claude instructions',
    runtimeProfile: { version: 1, runtimeId: 'claude', modelId: 'claude-model', reasoning: 'xhigh' }, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'build', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: false, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 } };
}

function runSpec(): AgentRunSpec {
  return { runId: 'claude-run', attemptId: 'claude-attempt', workspaceId: 'ws', ownerUserId: 'user', task: 'Claude task', effectiveDefinition: definition(),
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp/claude-worktree', sourceWorkspaceId: 'ws', snapshotHash: 'b'.repeat(64), createdAt: 1 },
    recoveryEnvelope: { version: 1, completedWork: 'previous work', currentResourceState: {}, outstandingWork: 'finish it', failureBoundary: { version: 1, code: 'retry', category: 'transient', message: 'retry', retryable: true }, resultBundleDraft: null } };
}

class ClaudeTransportSession implements AgentSession {
  id = 'claude-attempt'; runtimeId = 'claude'; owner: RuntimeSessionOwner = { kind: 'agent_run', runId: 'claude-run', attemptId: 'claude-attempt' };
  runtimeProfileHash: string | null = null; nativeSessionId = 'claude-native-session';
  getHistory() { return []; } getPendingAssistant() { return undefined; } cancel() {}
  async *send() { yield { kind: 'chunk' as const, text: 'Claude completed' }; yield { kind: 'turn_end' as const }; }
}

test('fake Claude transport uses native resume token and emits a private checkpoint', async () => {
  const session = new ClaudeTransportSession(); let loadOptions: LoadAgentSessionOptions | null = null; let newSessions = 0;
  const runtime: AgentRuntime = {
    id: 'claude', label: 'Claude fake', capabilities: { modes: false, permissions: true, models: true, providerModels: false, reasoning: true, supportedReasoningLevels: ['xhigh'], apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: false, nativeResume: true },
    async warm() {}, async newSession() { newSessions += 1; return session; },
    async loadSession(opts) { loadOptions = opts; session.runtimeProfileHash = opts.profileHash ?? null; return session; },
    releaseSession() {}, async shutdown() {},
  };
  const events: Array<{ type: AgentRunEventType; nativeResumeToken?: unknown }> = [];
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, adapters: [new ClaudeRunAdapter()] });
  const handle = await executor.resume(runSpec(), 'resume-token', async (event) => { events.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  assert.equal(newSessions, 0);
  const captured = loadOptions as LoadAgentSessionOptions | null;
  assert(captured);
  assert.equal(captured.nativeResumeToken, 'resume-token');
  assert.equal(captured.nodeId, undefined, 'Run resume must not look up a conversation node');
  assert.equal(captured.cwd, '/tmp/claude-worktree');
  assert.equal(captured.model, 'claude-model');
  assert.equal(captured.reasoning, 'xhigh');
  assert.match(captured.bootstrapInstructions ?? '', /previous work/);
  assert.deepEqual(events[0], { type: AgentRunEventType.Checkpoint, payload: { version: 1, runtimeId: 'claude' }, nativeResumeToken: 'claude-native-session' });
});
