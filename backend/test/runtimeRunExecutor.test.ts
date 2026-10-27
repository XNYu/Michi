import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentPolicyCategory, AgentPolicyDecision, AgentRunEventType, type EffectiveAgentDefinitionV1, type JsonValue } from 'michi-shared';
import type { AgentRuntime, AgentSession, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import { RuntimeRunExecutor, classifyRuntimeRunError, decisionToOptionId } from '../src/agents/runs/runtimeRunExecutor';
import { RuntimeRunAdapterRegistry } from '../src/agents/runs/runtimeRunAdapterRegistry';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
import type { AgentRunExecutionEvent, AgentRunSpec } from '../src/agents/runs/ports';
import { FileRunContextSnapshotStore } from '../src/agents/runs/runContextSnapshotStore';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { runOwner, sameHostOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

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
  id = 'attempt-1'; runtimeId = 'pi'; owner: RuntimeSessionOwner = runOwner('run-1', 'attempt-1');
  runtimeProfileHash: string | null = null; nativeSessionId: string | null = null;
  cancelled = 0; steered: string[] = [];
  getHistory() { return []; } getPendingAssistant() { return undefined; }
  async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> { yield { kind: 'chunk', text: 'answer' }; yield { kind: 'thought', text: 'thinking' }; yield { kind: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' }; yield { kind: 'usage_summary', contextUsagePercentage: 1, totalCredits: 0, turnDurationMs: 4, inputTokens: 3, outputTokens: 2 }; yield { kind: 'turn_end', stopReason: 'end_turn' }; }
  async cancel() { this.cancelled += 1; }
  async steer(text: string) { this.steered.push(text); return { accepted: true }; }
}

class FakeRuntime implements AgentRuntime {
  readonly descriptor = UNKNOWN_RUNTIME_DESCRIPTOR;
  id = 'pi'; label = 'fake'; capabilities = { modes: false, permissions: true, models: true, providerModels: true, reasoning: true, supportedReasoningLevels: ['medium' as const], apiKeys: true, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false };
  session = new FakeSession(); options: NewAgentSessionOptions | null = null; releases: Array<[string, RuntimeSessionOwner | undefined]> = [];
  async warm() {} async newSession(options: NewAgentSessionOptions) { this.options = options; this.session.runtimeProfileHash = options.profileHash ?? null; return this.session; }
  releaseSession(id: string, owner?: RuntimeSessionOwner) { this.releases.push([id, owner]); }
  async shutdown() {}
}

test('runtime permission broker preserves allow, ask, and deny policy decisions', async () => {
  // Adapters send canonical tool names; see permissionToolNames.test.ts.
  const decisionFor = async (policyDecision: AgentPolicyDecision, toolName = 'write') => {
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
      owner: runOwner(run.runId, run.attemptId),
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
  assert.equal(await decisionFor(AgentPolicyDecision.Allow, 'Write'), 'deny', 'a runtime-native name is an external action');
});

test('steering and cancellation stay scoped to the active Attempt', async () => {
  const runtime = new FakeRuntime();
  const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() });
  const handle = await executor.start(spec(), async () => {});
  await handle.input('queued direction');
  await handle.input('urgent direction', 'immediate');
  await handle.cancel('stop');
  assert.deepEqual(runtime.session.steered, ['queued direction']);
  assert.equal(runtime.session.cancelled, 2);
  assert(runtime.releases.every(([id, owner]) => id === 'attempt-1' && owner !== undefined && sameHostOwner(owner, runOwner('run-1', 'attempt-1'))));
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
  assert.deepEqual(runtime.releases, [['attempt-1', runOwner('run-1', 'attempt-1')]]);
});

class RecordingPermissionSession extends FakeSession {
  responses: Array<[number, string]> = [];
  failNext: Error | null = null;
  override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
    yield { kind: 'permission_request', requestId: 7, title: 'Approve write?', options: [] };
    yield { kind: 'turn_end', stopReason: 'end_turn' };
  }
  respondToPermission(requestId: number, optionId: string) {
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    this.responses.push([requestId, optionId]);
  }
}

async function waitingPermissionAttempt() {
  const session = new RecordingPermissionSession();
  const runtime = new FakeRuntime();
  runtime.session = session;
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() }).start(spec(), async () => {});
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'waiting');
  return { session, handle };
}

test('Run permission decisions map onto runtime option ids', () => {
  assert.equal(decisionToOptionId('deny'), 'reject_once');
  assert.equal(decisionToOptionId('allow_once'), 'allow_once');
  assert.equal(decisionToOptionId('allow_always'), 'allow_always');
});

for (const [text, expected] of [
  ['deny', 'reject_once'], ['no', 'reject_once'], ['reject', 'reject_once'],
  ['allow', 'allow_once'], ['allow_always', 'allow_always'],
] as const) {
  test(`Run permission input '${text}' answers the runtime with the ${expected} option`, async () => {
    const { session, handle } = await waitingPermissionAttempt();
    await handle.input(text);
    assert.deepEqual(session.responses, [[7, expected]]);
    assert.equal((await handle.continueAfterInput?.())?.status, 'completed');
  });
}

test('a failed permission answer surfaces to the caller and keeps the interaction pending', async () => {
  const { session, handle } = await waitingPermissionAttempt();
  session.failNext = new Error('Invalid permission option');
  await assert.rejects(handle.input('deny'), /Invalid permission option/);
  assert.deepEqual(session.responses, []);
  assert.throws(() => handle.continueAfterInput?.(), /has not been answered/);
  await handle.input('allow');
  assert.deepEqual(session.responses, [[7, 'allow_once']]);
  assert.equal((await handle.continueAfterInput?.())?.status, 'completed');
});

test('a failed user-input answer surfaces to the caller and keeps the interaction pending', async () => {
  class UserInputSession extends FakeSession {
    answered: Array<[number, Array<{ question: string; answer: string }>]> = [];
    failNext: Error | null = new Error('runtime rejected the answer');
    override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
      yield { kind: 'user_input_request', requestId: 11, questions: [{ id: 'q1', question: 'Which file?', options: [], multiSelect: false }] };
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    }
    respondToUserInput(requestId: number, answers: Array<{ question: string; answer: string }>) {
      if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
      this.answered.push([requestId, answers]);
    }
  }
  const session = new UserInputSession();
  const runtime = new FakeRuntime();
  runtime.session = session;
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() }).start(spec(), async () => {});
  const waiting = await handle.completion;
  assert.equal(waiting.status === 'waiting' && waiting.kind, 'user_input');
  await assert.rejects(handle.input('src/a.ts'), /runtime rejected the answer/);
  assert.deepEqual(session.answered, []);
  assert.throws(() => handle.continueAfterInput?.(), /has not been answered/);
  await handle.input('src/b.ts');
  assert.deepEqual(session.answered, [[11, [{ id: 'q1', question: 'Which file?', answer: 'src/b.ts' }]]]);
  assert.equal((await handle.continueAfterInput?.())?.status, 'completed');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Claude-like session: the native id may only be learned during the first turn (system/init). */
class LateNativeIdSession extends FakeSession {
  override runtimeId = 'claude';
  turns = 0;
  readonly firstTurnStarted = deferred();
  readonly releaseFirstTurn = deferred();
  getNativeResumeToken?: () => JsonValue;
  constructor(private readonly learnedId: string, initialId: string | null, withResumeToken: boolean) {
    super();
    this.nativeSessionId = initialId;
    if (withResumeToken) this.getNativeResumeToken = () => ({ engine: 'sdk', sessionId: this.nativeSessionId });
  }
  override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
    this.turns += 1;
    if (this.turns === 1) {
      this.nativeSessionId = this.learnedId;
      yield { kind: 'chunk', text: 'first turn' };
      this.firstTurnStarted.resolve();
      await this.releaseFirstTurn.promise;
    } else {
      yield { kind: 'chunk', text: 'second turn' };
    }
    yield { kind: 'turn_end', stopReason: 'end_turn' };
  }
}

/** Run two turns (task + one queued supplemental input) and return the emitted events. */
async function runTwoTurnClaudeAttempt(session: LateNativeIdSession) {
  const runtime = new FakeRuntime();
  runtime.id = 'claude';
  runtime.capabilities.nativeResume = true;
  runtime.session = session;
  const events: AgentRunExecutionEvent[] = [];
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() })
    .start(spec('claude'), async (event) => { events.push(event); });
  await session.firstTurnStarted.promise;
  await handle.input('more direction');
  session.releaseFirstTurn.resolve();
  assert.equal((await handle.completion).status, 'completed');
  assert.equal(session.turns, 2);
  return events;
}

for (const withResumeToken of [false, true]) {
  test(`a fresh Attempt checkpoints the native id learned during its first turn (getNativeResumeToken: ${withResumeToken})`, async () => {
    const session = new LateNativeIdSession('native-late', null, withResumeToken);
    const events = await runTwoTurnClaudeAttempt(session);
    const checkpoints = events.filter((event) => event.type === AgentRunEventType.Checkpoint);
    assert.equal(checkpoints.length, 1, 'exactly one checkpoint; the unchanged id in turn two is not re-emitted');
    assert.deepEqual(checkpoints[0], { type: AgentRunEventType.Checkpoint, payload: { version: 1, runtimeId: 'claude' },
      nativeResumeToken: withResumeToken ? { engine: 'sdk', sessionId: 'native-late' } : 'native-late' });
    const index = (predicate: (event: AgentRunExecutionEvent) => boolean) => events.findIndex(predicate);
    const checkpointAt = index((event) => event.type === AgentRunEventType.Checkpoint);
    assert(checkpointAt > index((event) => event.type === AgentRunEventType.Assistant), 'checkpoint follows the first turn');
    assert(checkpointAt < index((event) => event.type === AgentRunEventType.SteeringApplied), 'checkpoint precedes the second turn');
  });
}

test('a native id known before the first turn is checkpointed up front and not repeated', async () => {
  const session = new LateNativeIdSession('native-known', 'native-known', true);
  const events = await runTwoTurnClaudeAttempt(session);
  const checkpoints = events.filter((event) => event.type === AgentRunEventType.Checkpoint);
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(events[0], { type: AgentRunEventType.Checkpoint, payload: { version: 1, runtimeId: 'claude' },
    nativeResumeToken: { engine: 'sdk', sessionId: 'native-known' } });
});

/** Claude-like session that learns its native id mid-turn and then pauses on an approval in `pauseTurn`. */
class PausingNativeIdSession extends FakeSession {
  override runtimeId = 'claude';
  turns = 0;
  responses: Array<[number, string]> = [];
  readonly firstTurnStarted = deferred();
  readonly releaseFirstTurn = deferred();
  constructor(private readonly pauseTurn: 1 | 2) { super(); }
  override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
    this.turns += 1;
    if (this.turns === 1) {
      this.firstTurnStarted.resolve();
      await this.releaseFirstTurn.promise;
    }
    if (this.turns === this.pauseTurn) {
      this.nativeSessionId = 'native-paused';
      yield { kind: 'permission_request', requestId: 9, title: 'Approve write?', options: [] };
    }
    yield { kind: 'chunk', text: `turn ${this.turns}` };
    yield { kind: 'turn_end', stopReason: 'end_turn' };
  }
  respondToPermission(requestId: number, optionId: string) { this.responses.push([requestId, optionId]); }
}

for (const pauseTurn of [1, 2] as const) {
  test(`an Attempt checkpoints a newly learned native id before pausing on an approval (turn ${pauseTurn})`, async () => {
    const session = new PausingNativeIdSession(pauseTurn);
    const runtime = new FakeRuntime();
    runtime.id = 'claude';
    runtime.capabilities.nativeResume = true;
    runtime.session = session;
    const events: AgentRunExecutionEvent[] = [];
    const checkpoints = () => events.filter((event) => event.type === AgentRunEventType.Checkpoint);
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() })
      .start(spec('claude'), async (event) => { events.push(event); });
    await session.firstTurnStarted.promise;
    if (pauseTurn === 2) await handle.input('more direction');
    session.releaseFirstTurn.resolve();

    const waiting = await handle.completion;
    assert.equal(waiting.status, 'waiting');
    assert.equal(session.turns, pauseTurn);
    assert.deepEqual(checkpoints(), [{ type: AgentRunEventType.Checkpoint, payload: { version: 1, runtimeId: 'claude' },
      nativeResumeToken: 'native-paused' }], 'the paused Attempt is already resumable while it waits');
    assert(events.findIndex((event) => event.type === AgentRunEventType.Checkpoint)
      > events.findIndex((event) => event.type === AgentRunEventType.InteractionRequested));

    await handle.input('allow');
    assert.deepEqual(session.responses, [[9, 'allow_once']]);
    assert.equal((await handle.continueAfterInput?.())?.status, 'completed');
    assert.equal(checkpoints().length, 1, 'the unchanged id is not re-emitted when the turn ends');
  });
}

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

test('reported artifacts persist in their original Run payload form and reach the Result Bundle', async () => {
  class ArtifactSession extends FakeSession {
    override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> {
      yield { kind: 'host_event', type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 10 } };
      yield { kind: 'host_event', type: 'artifact_updated', payload: { name: 'notes', filePath: '.contexts/notes.md' } };
      yield { kind: 'host_event', type: 'spawn_branches', payload: { topics: [] } };
      yield { kind: 'host_event', type: 'image', payload: { path: 'chart.png', mimeType: 'image/png', size: 16 } };
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    }
  }
  const runtime = new FakeRuntime();
  runtime.session = new ArtifactSession();
  const events: AgentRunExecutionEvent[] = [];
  const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() })
    .start(spec(), async (event) => { events.push(event); });
  const outcome = await handle.completion;
  assert.equal(outcome.status, 'completed');

  // The bytes Agent Run storage has always held for these events: the artifact event, kind first.
  assert.deepEqual(events.map((event) => JSON.stringify(event)), [
    '{"type":"result_bundle_updated","payload":{"version":1,"artifact":{"kind":"artifact_saved","contextId":"ctx-1","name":"notes","filePath":".contexts/notes.md","size":10}}}',
    '{"type":"result_bundle_updated","payload":{"version":1,"artifact":{"kind":"artifact_updated","name":"notes","filePath":".contexts/notes.md"}}}',
    JSON.stringify({ type: AgentRunEventType.ResultBundleUpdated, payload: outcome.status === 'completed' ? outcome.resultBundle : null }),
  ]);
  assert.deepEqual(outcome.status === 'completed' ? outcome.resultBundle.artifacts : null, [
    { id: 'ctx-1', name: 'notes', kind: 'runtime_artifact', uri: '.contexts/notes.md', sha256: null, size: 10 },
    { id: 'attempt-1:notes', name: 'notes', kind: 'runtime_artifact', uri: '.contexts/notes.md', sha256: null, size: null },
  ]);
});

test('the retryable a runtime_error event carries reaches the Run error', async () => {
  class FailingSession extends FakeSession {
    constructor(private readonly failure: NormalizedEvent) { super(); }
    override async *send(_text: string): AsyncGenerator<NormalizedEvent, void, unknown> { yield this.failure; }
  }
  const outcome = async (failure: NormalizedEvent) => {
    const runtime = new FakeRuntime();
    runtime.session = new FailingSession(failure);
    const executor = new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() });
    return (await executor.start(spec(), async () => {})).completion;
  };
  const failed = (retryable: boolean) => ({ status: 'failed', recoveryEnvelope: null,
    error: { version: 1, code: 'runtime_terminal', category: 'terminal', message: 'Model failed', retryable } });
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed', code: 'generic', retryable: true }), failed(true));
  assert.deepEqual(await outcome({ kind: 'runtime_error', error: 'Model failed' }), failed(false));
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

for (const scenario of ['provider-disabled', 'model-disabled', 'level-unsupported', 'locked-model', 'catalog-failure'] as const) {
  test(`Run profile validates model/provider capabilities before session creation: ${scenario}`, async () => {
    const runtime = new FakeRuntime();
    runtime.capabilities.supportedReasoningLevels = ['medium'];
    Object.assign(runtime, {
      listProviders: async () => [{ id: 'provider', label: 'Provider', defaultModel: scenario === 'locked-model' ? 'required-model' : 'model',
        ...(scenario === 'locked-model' ? { modelLocked: true } : {}),
        ...(scenario === 'provider-disabled' ? { supportsReasoning: false } : {}),
      }],
      verifyProviderKey: async () => ({ ok: true }),
      listModels: async () => {
        if (scenario === 'catalog-failure') throw new Error('offline');
        return [{ id: 'model', ...(scenario === 'model-disabled' ? { supportsReasoning: false } : {}),
          ...(scenario === 'level-unsupported' ? { supportedReasoningLevels: ['low'] } : {}) }];
      },
    });
    const handle = await new RuntimeRunExecutor({ resolveRuntime: () => runtime, registry: defaultRegistry() }).start(spec(), async () => {});
    const outcome = await handle.completion;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') {
      assert.equal(outcome.error.code, scenario === 'locked-model' ? 'model_unsupported'
        : scenario === 'catalog-failure' ? 'model_capabilities_unavailable' : 'reasoning_unsupported');
    }
    assert.equal(runtime.options, null, 'invalid/unverifiable settings never allocate a session or silently clamp');
  });
}
