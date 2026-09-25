import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentDefinitionStatus,
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunStatus,
  type AgentDefinitionDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
  type AgentRunInteractionDtoV1,
  type EffectiveAgentDefinitionV1,
  type ResultBundleV1,
} from 'michi-shared';
import { AgentRunCoordinator } from '../src/agents/runs/agentRunCoordinator';

const hash = 'a'.repeat(64);
const permission = { version: 1 as const, preset: 'custom' as const,
  categories: Object.fromEntries(Object.values(AgentPolicyCategory).map((key) => [key, AgentPolicyDecision.Allow])),
  maxDelegationDepth: 3, maxConcurrentRuns: 3, maxWallTimeMs: 60_000, maxAttempts: 3,
  maxTokens: null, maxSpendMicros: null };
const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: false, allowMessageContext: true,
  allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000 };
const profile = { version: 1 as const, runtimeId: 'fake', modelId: 'model', options: {} };
const capabilityEntry = { id: 'read', kind: 'tool' as const, revision: 'v1', schemaHash: hash,
  contentHash: hash, configHash: hash, publicConfig: {}, credentialBindingIds: [] };

function effective(): EffectiveAgentDefinitionV1 {
  return { version: 1, name: 'Worker', description: 'Does bounded work', instructions: 'Do the task',
    runtimeProfile: profile, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [{ ...capabilityEntry }] },
    permissionPolicy: permission, contextPolicy };
}

function result(): ResultBundleV1 {
  return { version: 1, status: 'completed', source: 'submitted',
    handoff: { conclusion: 'Done', artifactsOrChanges: '', unresolvedIssues: '' },
    artifacts: [], resourceMutations: [], externalActions: [] };
}

class MemoryRepo {
  runs = new Map<string, AgentRunDtoV1>(); events = new Map<string, AgentRunEventV1[]>();
  attempts = new Map<string, Array<any>>(); interactions = new Map<string, AgentRunInteractionDtoV1>();
  claims = 0; nextAttempt = 1; nextInteraction = 1;
  createRun(input: any) {
    const id = `run-${this.runs.size + 1}`; const now = 1_000;
    const run = { version: 1, id, ownerUserId: input.ownerUserId, workspaceId: input.workspaceId,
      definitionId: input.definitionId, definitionRevision: input.definitionRevision,
      effectiveDefinition: input.effectiveDefinition, invocationMode: input.invocationMode,
      completionMode: input.completionMode, parentRunId: input.parentRunId, parentAttemptId: input.parentAttemptId, parentNodeId: input.parentNodeId,
      parentTurnId: input.parentTurnId, parentMessageId: input.parentMessageId, parentToolCallId: input.parentToolCallId,
      task: input.task, contextManifest: input.contextManifest, expectedResult: input.expectedResult,
      executionEnvironment: input.executionEnvironment, status: AgentRunStatus.Queued, waitingReason: null,
      activeAttemptId: null, resultBundle: null, latestEventSeq: 0, createdAt: now, startedAt: null,
      completedAt: null, archivedAt: null, expiresAt: input.expiresAt } as AgentRunDtoV1;
    this.runs.set(id, run); this.events.set(id, [{ version: 1, runId: id, seq: 0, attemptId: null,
      type: input.initialEvent.type, payload: input.initialEvent.payload, createdAt: now }]); return run;
  }
  getRun(owner: string, id: string) { const run = this.runs.get(id); return run?.ownerUserId === owner ? run : null; }
  listRuns() { return [...this.runs.values()]; }
  listAttempts(_owner: string, id: string) { return this.attempts.get(id) ?? []; }
  getLatestAttemptRecovery(_owner: string, id: string) {
    const attempt = this.attempts.get(id)?.at(-1);
    return attempt ? {
      attemptId: attempt.id,
      profileIndex: attempt.profileIndex,
      recoveryEnvelope: attempt.recoveryEnvelope ?? null,
      nativeResumeToken: attempt.nativeResumeToken ?? null,
    } : null;
  }
  listEvents(_owner: string, id: string, after = -1, limit = 500) { return (this.events.get(id) ?? []).filter((event) => event.seq > after).slice(0, limit); }
  claimRun(owner: string, id: string, _leaseOwner: string, leaseToken: string, _expires: number, expected: number) {
    const run = this.getRun(owner, id); if (!run || run.latestEventSeq !== expected
      || ![AgentRunStatus.Queued, AgentRunStatus.Recovering].includes(run.status)) return null;
    this.claims += 1; (run as any).leaseToken = leaseToken;
    return this.append(owner, run, AgentRunEventType.RunStatusChanged,
      { version: 1, from: run.status, to: AgentRunStatus.Preparing }, { status: AgentRunStatus.Preparing });
  }
  heartbeat(owner: string, id: string, lease: string) { return (this.getRun(owner, id) as any)?.leaseToken === lease; }
  createAttempt(input: any) { const attempt = { id: `attempt-${this.nextAttempt++}`, attemptIndex: this.nextAttempt - 2,
    profileIndex: input.profileIndex, status: 'preparing', recoveryEnvelope: input.recoveryEnvelope ?? null }; const list = this.attempts.get(input.runId) ?? [];
    list.push(attempt); this.attempts.set(input.runId, list); return attempt; }
  checkpointAttempt() { return true; }
  appendEventAndProject(owner: string, id: string, expected: number, event: any, patch: any = {}) {
    const run = this.getRun(owner, id)!; assert.equal(run.latestEventSeq, expected);
    return this.append(owner, run, event.type, event.payload, patch, event.attemptId ?? null);
  }
  private append(_owner: string, run: AgentRunDtoV1, type: AgentRunEventType, payload: any, patch: any, attemptId: string | null = null) {
    Object.assign(run, patch); run.latestEventSeq += 1;
    const event = { version: 1 as const, runId: run.id, seq: run.latestEventSeq, attemptId, type, payload, createdAt: 1_000 + run.latestEventSeq };
    this.events.get(run.id)!.push(event); return event;
  }
  finalizeAttempt(owner: string, id: string, attemptId: string, _lease: string, attemptStatus: string,
    runStatus: AgentRunStatus, bundle: ResultBundleV1 | null, _error: any, expected: number, event: any) {
    const run = this.getRun(owner, id)!; const attempt = this.attempts.get(id)!.find((item) => item.id === attemptId)!;
    attempt.status = attemptStatus; this.append(owner, run, event.type, event.payload,
      { status: runStatus, waitingReason: null, resultBundle: bundle, completedAt: 2_000 }, attemptId);
    assert.equal(expected + 1, run.latestEventSeq); return run;
  }
  finishAttemptForRecovery(owner: string, id: string, attemptId: string, _lease: string, _error: any, expected: number) {
    const run = this.getRun(owner, id)!; assert.equal(run.latestEventSeq, expected);
    (this.attempts.get(id)!.find((item) => item.id === attemptId)!).status = 'failed';
    (run as any).leaseToken = null;
    return this.append(owner, run, AgentRunEventType.RecoveryStarted,
      { version: 1, attemptId }, { status: AgentRunStatus.Recovering }, attemptId);
  }
  releaseLease() { return true; }
  administrativelyCancelRun(owner: string, id: string, leaseToken: string | null) {
    const run = this.getRun(owner, id); if (!run) return null;
    const currentLease = (run as any).leaseToken ?? null;
    if (leaseToken !== null && currentLease !== leaseToken) throw new Error('run lease lost');
    if (leaseToken === null && currentLease !== null) throw new Error('Run is leased by another live instance');
    const attempt = this.attempts.get(id)?.find((item) => item.id === run.activeAttemptId);
    if (attempt) attempt.status = 'cancelled';
    (run as any).leaseToken = null;
    return this.append(owner, run, AgentRunEventType.RunStatusChanged,
      { version: 1, from: run.status, to: AgentRunStatus.Cancelled, reason: 'administrative_delete' },
      { status: AgentRunStatus.Cancelled, waitingReason: null, completedAt: 2_000 });
  }
  createInteraction(_owner: string, runId: string, attemptId: string | null, kind: any, request: any) {
    const interaction = { version: 1 as const, id: `interaction-${this.nextInteraction++}`, runId, attemptId,
      kind, status: 'pending' as const, request, response: null, createdAt: 1, resolvedAt: null };
    this.interactions.set(interaction.id, interaction); return interaction;
  }
  getInteraction(_owner: string, id: string) { return this.interactions.get(id) ?? null; }
  listInteractions(_owner: string, runId: string) { return [...this.interactions.values()].filter((item) => item.runId === runId); }
  resolveInteraction(_owner: string, id: string, _status: any, response: any) { const item = this.interactions.get(id); if (!item) return null;
    Object.assign(item, { status: 'resolved', response, resolvedAt: 2 }); return item; }
}

class FakeClock {
  value = 1_000; timers: Array<() => void> = [];
  now = () => this.value;
  setTimeout = (callback: () => void) => { this.timers.push(callback); return callback; };
  clearTimeout = (_handle: unknown) => {};
  tick() { this.timers.splice(0).forEach((callback) => callback()); }
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

function setup(outcome: any = { status: 'completed', resultBundle: result() }, continuedOutcome?: any) {
  const repository = new MemoryRepo(); const clock = new FakeClock(); let starts = 0; let resumes = 0; let bindingError = false;
  let inputError: Error | null = null; let startError: Error | null = null; let resumedToken: any = null;
  const inputs: Array<{ text: string; mode?: 'queued' | 'immediate' }> = []; const cancels: Array<string | null> = [];
  const completion = outcome === 'deferred' ? deferred<any>() : null;
  const ports: any = {
    repository, definitions: { get: () => null },
    capabilities: { assertRuntimeReady: () => {}, resolve: () => ({ version: 1, entries: [{ ...capabilityEntry }] }),
      validateBindings: () => { if (bindingError) throw new Error('credential binding revoked'); } },
    contexts: { snapshot: async ({ manifest }: any) => structuredClone(manifest), cleanup: async () => {} },
    environments: { prepare: async ({ runId, workspaceId }: any) => ({ leaseId: 'lease-env', ownerRunId: runId,
      access: 'read_only', snapshot: { version: 1, kind: 'shared_workspace', cwd: '/workspace', sourceWorkspaceId: workspaceId,
        snapshotHash: hash, createdAt: clock.now() }, provenance: { version: 1, sourceRepositoryRoot: null, baseCommit: null,
        stagedPatchHash: null, unstagedPatchHash: null, untrackedFiles: [], skippedSensitivePaths: [] },
      buildChangeSet: async () => null, cleanup: async () => ({ removed: false }) }) },
    executor: { start: async () => { starts += 1; if (startError) throw startError; return {
      completion: completion?.promise ?? Promise.resolve(outcome),
      ...(continuedOutcome === undefined ? {} : { continueAfterInput: async () => continuedOutcome }),
      input: async (text: string, mode?: 'queued' | 'immediate') => { if (inputError) throw inputError; inputs.push({ text, mode }); },
      cancel: async (reason: string | null) => { cancels.push(reason); },
    }; }, resume: async (_spec: any, token: any) => { resumes += 1; resumedToken = token; return {
      completion: completion?.promise ?? Promise.resolve(outcome),
      ...(continuedOutcome === undefined ? {} : { continueAfterInput: async () => continuedOutcome }),
      input: async (text: string, mode?: 'queued' | 'immediate') => { if (inputError) throw inputError; inputs.push({ text, mode }); },
      cancel: async (reason: string | null) => { cancels.push(reason); },
    }; } },
    workspaces: { resolve: () => ({ cwd: '/workspace', permissionPolicy: permission }) },
    notifier: { notify: async () => {} }, parentSink: { deliver: async () => 'delivered' }, resourceCleaner: { cleanup: async () => {} },
    clock, instanceId: 'coordinator-1', nextId: (() => { let id = 0; return (kind: string) => `${kind}-${++id}`; })(),
    platformPermissionPolicy: permission, maxRunTtlMs: 10_000_000,
  };
  return { repository, clock, completion, inputs, cancels,
    get starts() { return starts; }, get resumes() { return resumes; }, get resumedToken() { return resumedToken; },
    setBindingError() { bindingError = true; }, setInputError(error: Error | null) { inputError = error; },
    setStartError(error: Error | null) { startError = error; }, ports };
}

function spawnInput() {
  return { operationId: 'spawn-1', ownerUserId: 'owner', workspaceId: 'ws', definitionId: null,
    ephemeralDefinition: effective(), invocationMode: 'manual' as const, completionMode: AgentRunCompletionMode.Wait,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
    task: 'Do work', contextManifest: { version: 1 as const, entries: [], assembledAt: 1, estimatedChars: 0 },
    permissionRestriction: null, environment: { version: 1 as const, kind: 'auto' as const }, expectedResult: null, runTtlMs: null };
}

describe('AgentRunCoordinator', () => {
  test('full happy path completes with zero UI subscribers and committed event order', async () => {
    const fixture = setup(); const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    const completed = await coordinator.start('owner', queued.id);
    assert.equal(completed?.status, AgentRunStatus.Completed);
    assert.equal(completed?.resultBundle?.handoff.conclusion, 'Done');
    assert.deepEqual(fixture.repository.listEvents('owner', queued.id).map((event) => event.seq), [0, 1, 2, 3]);
  });

  test('spawn forwards the exact nested Parent Attempt into durable creation', async () => {
    const fixture = setup(); const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn({ ...spawnInput(), invocationMode: 'delegated',
      parentRunId: 'parent-run', parentAttemptId: 'parent-attempt' });
    assert.equal(queued.parentRunId, 'parent-run');
    assert.equal(queued.parentAttemptId, 'parent-attempt');
  });

  test('two coordinators race one Run and only one executor starts', async () => {
    const fixture = setup('deferred');
    const first = new AgentRunCoordinator(fixture.ports); const second = new AgentRunCoordinator({ ...fixture.ports, instanceId: 'coordinator-2' });
    const queued = await first.spawn(spawnInput()); const pending = first.start('owner', queued.id);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(await second.start('owner', queued.id), null);
    assert.equal(fixture.starts, 1);
    fixture.completion!.resolve({ status: 'completed', resultBundle: result() });
    assert.equal((await pending)?.status, AgentRunStatus.Completed);
  });

  test('waiting interaction remains durable across coordinator recreation', async () => {
    const fixture = setup({ status: 'waiting', kind: 'permission', request: { version: 1, tool: 'bash' } });
    const first = new AgentRunCoordinator(fixture.ports); const queued = await first.spawn(spawnInput());
    assert.equal((await first.start('owner', queued.id))?.status, AgentRunStatus.Waiting);
    const recreated = new AgentRunCoordinator({ ...fixture.ports, instanceId: 'coordinator-2' });
    assert.equal(recreated.check('owner', queued.id)?.status, AgentRunStatus.Waiting);
    assert.equal(fixture.repository.interactions.size, 1);
    const interaction = [...fixture.repository.interactions.values()][0];
    await assert.rejects(() => recreated.respondInteraction('owner', queued.id, interaction.id,
      { version: 1, text: 'approve' }, 'respond-after-restart'), /remains waiting/);
    assert.equal(recreated.check('owner', queued.id)?.status, AgentRunStatus.Waiting);
    assert.equal(fixture.repository.interactions.get(interaction.id)?.status, 'pending');
  });

  test('recovery uses the latest Attempt profile, envelope, and private native resume token', async () => {
    const fixture = setup();
    const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    const run = fixture.repository.runs.get(queued.id)!;
    run.effectiveDefinition.fallbackChain.push({ version: 1, runtimeId: 'fake-fallback', modelId: 'fallback' });
    run.status = AgentRunStatus.Recovering;
    fixture.repository.attempts.set(run.id, [{
      id: 'attempt-old', attemptIndex: 0, profileIndex: 1, status: 'failed',
      recoveryEnvelope: { version: 1, completedWork: [], currentResourceState: {}, relevantArtifacts: [], outstandingWork: [], failureBoundary: 'restart' },
      nativeResumeToken: { sessionId: 'native-1' },
    }]);
    const completed = await coordinator.start('owner', run.id);
    assert.equal(completed?.status, AgentRunStatus.Completed);
    assert.equal(fixture.starts, 0);
    assert.equal(fixture.resumes, 1);
    assert.deepEqual(fixture.resumedToken, { sessionId: 'native-1' });
    assert.equal(fixture.repository.attempts.get(run.id)?.at(-1)?.profileIndex, 1);
    assert.equal(fixture.repository.attempts.get(run.id)?.at(-1)?.recoveryEnvelope?.failureBoundary, 'restart');
  });

  test('responding to a durable interaction resumes and settles the same Attempt', async () => {
    const fixture = setup(
      { status: 'waiting', kind: 'permission', request: { version: 1, tool: 'bash' } },
      { status: 'completed', resultBundle: result() },
    );
    const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    assert.equal((await coordinator.start('owner', queued.id))?.status, AgentRunStatus.Waiting);
    const interaction = [...fixture.repository.interactions.values()][0];
    assert.ok(interaction);
    const resolved = await coordinator.respondInteraction('owner', queued.id, interaction.id,
      { version: 1, text: 'allow_once' }, 'respond-1');
    assert.equal(resolved?.status, 'resolved');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(coordinator.check('owner', queued.id)?.status, AgentRunStatus.Completed);
    assert.deepEqual(fixture.inputs, [{ text: 'allow_once', mode: 'queued' }]);
  });

  test('failed runtime input leaves the interaction pending and the Run waiting', async () => {
    const fixture = setup({ status: 'waiting', kind: 'permission', request: { version: 1, tool: 'bash' } });
    const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    assert.equal((await coordinator.start('owner', queued.id))?.status, AgentRunStatus.Waiting);
    const interaction = [...fixture.repository.interactions.values()][0];
    fixture.setInputError(new Error('runtime input rejected'));
    await assert.rejects(() => coordinator.respondInteraction('owner', queued.id, interaction.id,
      { version: 1, text: 'allow_once' }, 'respond-failed'), /runtime input rejected/);
    assert.equal(coordinator.check('owner', queued.id)?.status, AgentRunStatus.Waiting);
    assert.equal(fixture.repository.interactions.get(interaction.id)?.status, 'pending');
  });

  test('bounded wait timeout reports stillRunning and never calls cancel', async () => {
    const fixture = setup(); const coordinator = new AgentRunCoordinator(fixture.ports); const queued = await coordinator.spawn(spawnInput());
    const waiting = coordinator.wait('owner', queued.id, 50); fixture.clock.tick();
    assert.deepEqual(await waiting, { run: queued, resultBundle: null, stillRunning: true });
  });

  test('revoked bindings fail durably before executor start and snapshots do not mutate', async () => {
    const fixture = setup(); const coordinator = new AgentRunCoordinator(fixture.ports); const queued = await coordinator.spawn(spawnInput());
    (spawnInput().ephemeralDefinition!.capabilitySnapshot.entries[0] as any).revision = 'changed-elsewhere';
    assert.equal(queued.effectiveDefinition.capabilitySnapshot.entries[0].revision, 'v1');
    fixture.setBindingError();
    const failed = await coordinator.start('owner', queued.id);
    assert.equal(failed?.status, AgentRunStatus.Failed);
    assert.equal(fixture.starts, 0);
  });

  test('steering and cancellation are scoped to the active Attempt', async () => {
    const fixture = setup('deferred'); const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput()); const pending = coordinator.start('owner', queued.id);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const active = coordinator.check('owner', queued.id)?.activeAttemptId;
    assert.ok(active);
    await assert.rejects(coordinator.input('owner', queued.id, { version: 1, text: 'stale', mode: 'queued', expectedAttemptId: 'old-attempt' }, 'input-stale'), /expected Attempt/);
    assert.equal(await coordinator.input('owner', queued.id, { version: 1, text: 'continue', mode: 'immediate', expectedAttemptId: active }, 'input-1'), true);
    assert.deepEqual(fixture.inputs, [{ text: 'continue', mode: 'immediate' }]);
    await assert.rejects(coordinator.cancel('owner', queued.id, 'stop', 'old-attempt', 'cancel-stale'), /expected Attempt/);
    assert.equal(await coordinator.cancel('owner', queued.id, 'stop', active, 'cancel-1'), true);
    assert.deepEqual(fixture.cancels, ['stop']);
    fixture.completion!.resolve({ status: 'cancelled' });
    assert.equal((await pending)?.status, AgentRunStatus.Cancelled);
  });

  test('queued cancellation is durable and idempotent before an executor starts', async () => {
    const fixture = setup(); const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    assert.equal(await coordinator.cancel('owner', queued.id, 'not needed', null, 'cancel-queued'), true);
    assert.equal(await coordinator.cancel('owner', queued.id, 'not needed', null, 'cancel-queued'), true);
    assert.equal(coordinator.check('owner', queued.id)?.status, AgentRunStatus.Cancelled);
    assert.equal(fixture.repository.listEvents('owner', queued.id).filter((event) => event.type === AgentRunEventType.CancellationRequested).length, 1);
    assert.equal(fixture.starts, 0);
  });

  test('shutdown checkpoints a live Attempt for recovery even when cancel completion races', async () => {
    const fixture = setup('deferred');
    const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    const running = coordinator.start('owner', queued.id);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await coordinator.shutdown();
    fixture.completion!.resolve({ status: 'cancelled' });
    assert.equal((await running)?.status, AgentRunStatus.Recovering);
    assert.equal(coordinator.check('owner', queued.id)?.status, AgentRunStatus.Recovering);
  });

  test('administrative quiescence cancels a local live handle and clears its lease', async () => {
    const fixture = setup('deferred');
    const coordinator = new AgentRunCoordinator(fixture.ports);
    const queued = await coordinator.spawn(spawnInput());
    const running = coordinator.start('owner', queued.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await coordinator.quiesceForAdministrativeDeletion('owner', queued.id);
    assert.deepEqual(fixture.cancels, ['administrative owner deletion']);
    assert.equal(fixture.repository.getRun('owner', queued.id)?.status, AgentRunStatus.Cancelled);
    fixture.completion!.resolve({ status: 'cancelled' });
    assert.equal((await running)?.status, AgentRunStatus.Cancelled);
  });

  test('administrative quiescence refuses a lease held by another live coordinator', async () => {
    const fixture = setup('deferred');
    const owner = new AgentRunCoordinator(fixture.ports);
    const other = new AgentRunCoordinator({ ...fixture.ports, instanceId: 'coordinator-2' });
    const queued = await owner.spawn(spawnInput());
    const running = owner.start('owner', queued.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => other.quiesceForAdministrativeDeletion('owner', queued.id),
      /leased by another live instance/,
    );
    fixture.completion!.resolve({ status: 'cancelled' });
    await running;
  });
});
