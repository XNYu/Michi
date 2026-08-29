import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor, classifyRuntimeRunError } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import { FileRunContextSnapshotStore } from '../src/agents/runs/runContextSnapshotStore';
import type { NormalizedEvent } from '../src/services/chatEvents';

/** Default four-adapter registry used by tests. */
function defaultRegistry(): RuntimeRunAdapterRegistry {
  return new RuntimeRunAdapterRegistry([
    new PiRunAdapter(), new ClaudeRunAdapter(), new KiroRunAdapter(), new CodexRunAdapter(),
  ]);
}

function definition(runtimeId = 'pi'): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'test', instructions: 'Follow the exact worker instructions.',
    runtimeProfile: { version: 1, runtimeId, providerId: 'provider', modelId: 'model', reasoning: 'medium' },
    fallbackChain: [], capabilitySnapshot: { version: 1, entries: [{ id: 'read_file', kind: 'tool', revision: '1', schemaHash: 'a'.repeat(64), contentHash: null, configHash: 'b'.repeat(64), publicConfig: {}, credentialBindingIds: [] }] },
    permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 },
  };
}

function spec(runtimeId = 'pi'): AgentRunSpec {
  return {
    runId: 'run-1', attemptId: 'attempt-1', workspaceId: 'workspace-1', ownerUserId: 'owner-1', task: 'Do the work',
    effectiveDefinition: definition(runtimeId),
    contextManifest: { version: 1, entries: [{ kind: 'summary', label: 'brief', content: 'only this context', sha256: 'c'.repeat(64) }], assembledAt: 1, estimatedChars: 17 },
    expectedResult: { version: 1, format: 'result_bundle', instructions: 'Return evidence' },
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp/worktree', sourceWorkspaceId: 'workspace-1', snapshotHash: 'd'.repeat(64), createdAt: 1 },
    recoveryEnvelope: null,
  };
}

class FakeSession implements AgentSession {
  id = 'attempt-1'; runtimeId = 'pi'; owner: RuntimeSessionOwner = { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' };
  runtimeProfileHash: string | null = null; nativeSessionId: string | null = null;
  cancelled = 0; steered: string[] = [];
  getHistory() { return []; } getPendingAssistant() { return undefined; }
  async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> { yield { kind: 'chunk', text: 'answer' }; yield { kind: 'thought', text: 'thinking' }; yield { kind: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' }; yield { kind: 'usage_summary', contextUsagePercentage: 1, totalCredits: 0, turnDurationMs: 4, inputTokens: 3, outputTokens: 2 }; yield { kind: 'turn_end', stopReason: 'end_turn' }; }
  async cancel() { this.cancelled += 1; }
  async steer(text: string) { this.steered.push(text); return { accepted: true }; }
}

class FakeRuntime implements AgentRuntime {
  id = 'pi'; label = 'fake'; capabilities = { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['medium' as const], apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false };
  session = new FakeSession(); options: NewAgentSessionOptions | null = null; releases: Array<[string, RuntimeSessionOwner | undefined]> = [];
  async warm() {} async newSession(options: NewAgentSessionOptions) { this.options = options; this.session.runtimeProfileHash = options.profileHash ?? null; return this.session; }
  releaseSession(id: string, owner?: RuntimeSessionOwner) { this.releases.push([id, owner]); }
  async shutdown() {}
}

test('runtime executor maps one ordered stream and binds exact Run session inputs', async () => {
  const runtime = new FakeRuntime();
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() });
  const events: Array<{ type: AgentRunEventType }> = [];
  const handle = await executor.start(spec(), async (event) => { events.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(events.map((event) => event.type), [AgentRunEventType.Assistant, AgentRunEventType.Thought, AgentRunEventType.ToolCall, AgentRunEventType.Usage, AgentRunEventType.ResultBundleUpdated]);
  assert.equal(runtime.options?.sessionId, 'attempt-1');
  assert.deepEqual(runtime.options?.owner, { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' });
  assert.equal(runtime.options?.cwd, '/tmp/worktree');
  assert.equal(runtime.options?.parentChatId, undefined);
  assert.equal(runtime.options?.enableFollowUps, false);
  assert.match(runtime.options?.bootstrapInstructions ?? '', /Follow the exact worker instructions/);
  assert.match(runtime.options?.bootstrapInstructions ?? '', /only this context/);
  assert.match(runtime.options?.bootstrapInstructions ?? '', /Return evidence/);
  assert.equal(runtime.options?.toolProfile?.allowedToolNames?.includes('submit_agent_result'), true);
  assert.deepEqual(runtime.releases, [['attempt-1', { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' }]]);
});

test('runtime permission broker preserves allow, ask, and deny policy decisions', async () => {
  const decisionFor = async (policyDecision: AgentPolicyDecision, toolName = 'Write') => {
    const runtime = new FakeRuntime();
    const run = spec();
    run.effectiveDefinition = {
      ...run.effectiveDefinition,
      permissionPolicy: {
        ...run.effectiveDefinition.permissionPolicy,
        categories: { [AgentPolicyCategory.FilesystemWrite]: policyDecision },
      },
    };
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() }).start(run, async () => {});
    const broker = runtime.options?.permissionBroker;
    assert(broker, 'runtime must receive the durable Run permission broker');
    const decision = await broker.requestPermission({
      owner: { kind: 'agent_run', runId: run.runId, attemptId: run.attemptId },
      ownerUserId: run.ownerUserId,
      workspaceId: run.workspaceId,
      toolName,
      input: {},
    });
    await handle.completion;
    return decision;
  };

  assert.equal(await decisionFor(AgentPolicyDecision.Allow), 'allow_once');
  assert.equal(await decisionFor(AgentPolicyDecision.Ask), 'ask');
  assert.equal(await decisionFor(AgentPolicyDecision.Deny), 'deny');
  assert.equal(await decisionFor(AgentPolicyDecision.Deny, 'submit_agent_result'), 'allow_once');
});

test('steering and cancellation stay scoped to the active Attempt', async () => {
  const runtime = new FakeRuntime();
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() });
  const handle = await executor.start(spec(), async () => {});
  await handle.input('queued direction');
  await handle.input('urgent direction', 'immediate');
  await handle.cancel('stop');
  assert.deepEqual(runtime.session.steered, ['queued direction', 'urgent direction']);
  assert.equal(runtime.session.cancelled, 2);
  assert(runtime.releases.every(([id, owner]) => id === 'attempt-1' && owner?.kind === 'agent_run' && owner.attemptId === 'attempt-1'));
});

test('runtime permission requests produce a waiting outcome and input targets that request', async () => {
  let response: [number, string] | null = null;
  class PermissionSession extends FakeSession {
    override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
      yield { kind: 'permission_request', requestId: 7, title: 'Approve write?', options: [] };
    }
    respondToPermission(requestId: number, optionId: string) { response = [requestId, optionId]; }
  }
  const session = new PermissionSession();
  const runtime = new FakeRuntime();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() });
  const handle = await executor.start(spec(), async () => {});
  const outcome = await handle.completion;
  assert.deepEqual(outcome, { status: 'waiting', kind: 'permission', request: {
    kind: 'permission_request', requestId: 7, title: 'Approve write?', options: [],
  } });
  await handle.input('allow_once');
  assert.deepEqual(response, [7, 'allow_once']);
  const continued = await handle.continueAfterInput?.();
  assert.equal(continued?.status, 'completed');
  assert.deepEqual(runtime.releases, [['attempt-1', { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' }]]);
});

test('unsupported runtimes and common runtime failures receive structured classifications', async () => {
  const unsupported = new RuntimeRunExecutor({ resolveRuntime: () => undefined, registry: new RuntimeRunAdapterRegistry() });
  const outcome = await (await unsupported.start(spec('kiro'), async () => {})).completion;
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.error.category, 'incompatible');
    assert.match(outcome.error.message, /unsupported/);
    assert.match(outcome.error.message, /\(none\)/);
  }
  assert.equal(classifyRuntimeRunError(new Error('missing API key')).category, 'auth_permission');
  assert.equal(classifyRuntimeRunError(new Error('unknown model x')).category, 'incompatible');
  assert.equal(classifyRuntimeRunError(new Error('concurrency capacity reached')).category, 'capacity');
  assert.equal(classifyRuntimeRunError(new Error('process timed out')).category, 'transient');
});

test('kiro adapter is accepted when both runtime and adapter exist', async () => {
  class FakeKiroRuntime extends FakeRuntime {
    override id = 'kiro';
    override capabilities = { ...new FakeRuntime().capabilities, apiKeys: false, providerModels: false, models: false, nativeResume: true };
  }
  class KiroSession extends FakeSession {
    override id = 'attempt-1';
    override runtimeId = 'kiro';
    override nativeSessionId = 'acp-session-42';
  }
  const runtime = new FakeKiroRuntime();
  const session = new KiroSession();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({ resolveRuntime: (id) => id === 'kiro' ? runtime : undefined, registry: defaultRegistry() });
  const events: Array<{ type: AgentRunEventType }> = [];
  const handle = await executor.start(spec('kiro'), async (event) => { events.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  assert.equal(runtime.options?.sessionId, 'attempt-1');
  assert.deepEqual(runtime.options?.owner, { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' });
  // Kiro checkpoint should emit the native ACP session id
  const checkpoint = events.find((event) => event.type === AgentRunEventType.Checkpoint);
  assert(checkpoint, 'Kiro session with nativeSessionId should emit a checkpoint');
});

test('codex adapter is accepted when both runtime and adapter exist', async () => {
  class FakeCodexRuntime extends FakeRuntime {
    override id = 'codex';
    override capabilities = { ...new FakeRuntime().capabilities, apiKeys: false, providerModels: false, models: false, nativeResume: true };
  }
  class CodexSession extends FakeSession {
    override id = 'attempt-1';
    override runtimeId = 'codex';
    override nativeSessionId = 'thread-abc123';
  }
  const runtime = new FakeCodexRuntime();
  const session = new CodexSession();
  runtime.session = session;
  const executor = new RuntimeRunExecutor({ resolveRuntime: (id) => id === 'codex' ? runtime : undefined, registry: defaultRegistry() });
  const events: Array<{ type: AgentRunEventType }> = [];
  const handle = await executor.start(spec('codex'), async (event) => { events.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');
  assert.equal(runtime.options?.sessionId, 'attempt-1');
  assert.deepEqual(runtime.options?.owner, { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' });
  const checkpoint = events.find((event) => event.type === AgentRunEventType.Checkpoint);
  assert(checkpoint, 'Codex session with nativeSessionId should emit a checkpoint');
});

test('kiro fails with missing adapter when adapter not in registry', async () => {
  class FakeKiroRuntime extends FakeRuntime { override id = 'kiro'; }
  const runtime = new FakeKiroRuntime();
  // Registry with only Pi and Claude — no Kiro adapter
  const piClaudeOnly = new RuntimeRunAdapterRegistry([new PiRunAdapter(), new ClaudeRunAdapter()]);
  const executor = new RuntimeRunExecutor({ resolveRuntime: (id) => id === 'kiro' ? runtime : undefined, registry: piClaudeOnly });
  const outcome = await (await executor.start(spec('kiro'), async () => {})).completion;
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.error.category, 'incompatible');
    assert.match(outcome.error.message, /kiro/);
    assert.match(outcome.error.message, /pi, claude/);
  }
});

test('codex fails with missing runtime even when adapter exists', async () => {
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => undefined, registry: defaultRegistry() });
  const outcome = await (await executor.start(spec('codex'), async () => {})).completion;
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.error.category, 'incompatible');
    assert.match(outcome.error.message, /not registered/);
  }
});

test('kiro adapter rejects incompatible runtime missing nativeResume', async () => {
  class NoResumeKiro extends FakeRuntime {
    override id = 'kiro';
    override capabilities = { ...new FakeRuntime().capabilities, nativeResume: false };
  }
  const runtime = new NoResumeKiro();
  const executor = new RuntimeRunExecutor({ resolveRuntime: (id) => id === 'kiro' ? runtime : undefined, registry: defaultRegistry() });
  const outcome = await (await executor.start(spec('kiro'), async () => {})).completion;
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.error.category, 'incompatible');
    assert.match(outcome.error.message, /incompatible.*native-resume/);
  }
});

test('dynamic error message enumerates all registered adapter runtimes', async () => {
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => undefined, registry: defaultRegistry() });
  const outcome = await (await executor.start(spec('nonexistent'), async () => {})).completion;
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.match(outcome.error.message, /pi/);
    assert.match(outcome.error.message, /claude/);
    assert.match(outcome.error.message, /kiro/);
    assert.match(outcome.error.message, /codex/);
  }
});

test('file context snapshots are immutable, verified, owner-bound, and symlink-safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'michi-run-context-'));
  try {
    const sources = path.join(root, 'sources'); await mkdir(sources);
    const source = path.join(sources, 'input.txt'); await writeFile(source, 'snapshot bytes');
    const digest = createHash('sha256').update('snapshot bytes').digest('hex');
    const store = new FileRunContextSnapshotStore({ dataDir: path.join(root, 'data'), allowedSourceRoots: [sources] });
    const manifest = { version: 1 as const, entries: [{ kind: 'file' as const, workspacePath: 'input.txt', snapshotPath: source, size: 14, sha256: digest }], assembledAt: 1, estimatedChars: 14 };
    const first = await store.snapshot({ ownerUserId: 'owner-1', workspaceId: 'workspace-1', runOperationId: 'run-1', manifest });
    await writeFile(source, 'mutated');
    assert.equal(await readFile(first.entries[0].kind === 'file' ? first.entries[0].snapshotPath : '', 'utf8'), 'snapshot bytes');
    const repeated = await store.snapshot({ ownerUserId: 'owner-1', workspaceId: 'workspace-1', runOperationId: 'run-1', manifest });
    assert.deepEqual(repeated, first);
    await assert.rejects(() => store.snapshot({ ownerUserId: 'owner-2', workspaceId: 'workspace-1', runOperationId: 'run-1', manifest }), /another owner/);
    const link = path.join(sources, 'link.txt'); await symlink(source, link);
    await assert.rejects(() => store.snapshot({ ownerUserId: 'owner-1', workspaceId: 'workspace-1', runOperationId: 'run-2', manifest: { ...manifest, entries: [{ ...manifest.entries[0], snapshotPath: link }] } }), /non-symlink/);
    await store.cleanup('run-1'); await store.cleanup('run-1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
