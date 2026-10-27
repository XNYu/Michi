import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  AgentRunStatus,
  type EffectiveAgentDefinitionV1,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { AgentRunsRepository, type CreateAgentRunInput } from '../src/services/agentRunsRepository';
import { AgentRunCoordinator } from '../src/agents/runs/agentRunCoordinator';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import type { RunWorkerToolProfile } from '../src/agents/runs/runWorkerTools';
import type { AgentRuntime, NewAgentSessionOptions, RuntimeSessionOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { hostOwner, runOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

const HASH = 'a'.repeat(64);
let tmpDir: string;
let now = 1000;
let ids: Record<string, number>;

const effectiveDefinition: EffectiveAgentDefinitionV1 = {
  version: 1, name: 'Researcher', description: 'Researches', instructions: 'Research carefully',
  runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [],
  capabilitySnapshot: { version: 1, entries: [] },
  permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1,
    maxConcurrentRuns: 2, maxWallTimeMs: 60_000, maxAttempts: 2 },
  contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
    allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 },
};

function createInput(operationId = 'spawn-1'): CreateAgentRunInput {
  return {
    operationId, ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionId: null,
    definitionRevision: null, effectiveDefinition, invocationMode: AgentRunInvocationMode.Manual,
    completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null, parentNodeId: null,
    parentTurnId: null, parentMessageId: null, parentToolCallId: null,
    task: 'Research SQLite leases',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp/ws-a',
      sourceWorkspaceId: 'ws-a', snapshotHash: HASH, createdAt: 1 },
    expiresAt: null,
    initialEvent: { type: AgentRunEventType.RunStatusChanged,
      payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
  };
}

describe('AgentRunsRepository', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-agent-runs-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb(); initDb(); now = 1000; ids = {};
    getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run('ws-a', 'A', 'owner-a');
    getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run('ws-b', 'B', 'owner-b');
  });
  afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function repo(): AgentRunsRepository {
    return new AgentRunsRepository({ now: () => ++now, createId: (kind) => `${kind}-${ids[kind] = (ids[kind] ?? 0) + 1}` });
  }

  test('atomically creates a Run plus zero-based initial event and replays operation IDs', () => {
    const runs = repo();
    const first = runs.createRun(createInput());
    const replay = runs.createRun(createInput());
    assert.deepEqual(replay, first);
    assert.equal(first.latestEventSeq, 0);
    assert.equal(first.completionMode, AgentRunCompletionMode.Detach);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM agent_run_events').get() as { count: number }).count, 1);
    assert.throws(() => runs.createRun({ ...createInput(), task: 'changed' }), /different payload/);
  });

  test('persists an exact nested parent Attempt and rejects mismatched ancestry', () => {
    const runs = repo();
    const parent = runs.createRun(createInput('parent-spawn'));
    const attempt = runs.createAttempt({ operationId: 'parent-attempt', ownerUserId: 'owner-a', runId: parent.id,
      profileIndex: 0, runtimeProfile: effectiveDefinition.runtimeProfile, recoveryEnvelope: null });
    const child = runs.createRun({ ...createInput('child-spawn'), invocationMode: AgentRunInvocationMode.Delegated,
      parentRunId: parent.id, parentAttemptId: attempt.id });
    assert.equal(child.parentRunId, parent.id);
    assert.equal(child.parentAttemptId, attempt.id);
    assert.throws(() => runs.createRun({ ...createInput('bad-child'), invocationMode: AgentRunInvocationMode.Delegated,
      parentRunId: parent.id, parentAttemptId: 'attempt-missing' }), /parent Run not found/);
    assert.throws(() => runs.createRun({ ...createInput('half-child'), invocationMode: AgentRunInvocationMode.Delegated,
      parentRunId: parent.id, parentAttemptId: null }), /matching nullability/);
  });

  test('every read/write is owner bounded and workspace ownership is enforced', () => {
    const runs = repo();
    const created = runs.createRun(createInput());
    assert.equal(runs.getRun('owner-b', created.id), null);
    assert.throws(() => runs.getRun('', created.id), /ownerUserId/);
    assert.throws(() => runs.createRun({ ...createInput('wrong-ws'), workspaceId: 'ws-b' }), /workspace not found/);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE operation_id = 'agent-run:wrong-ws'").get() as { count: number }).count, 0);
  });

  test('two claims race and exactly one lease plus transition event wins', () => {
    const runs = repo();
    const created = runs.createRun(createInput());
    const won = runs.claimRun('owner-a', created.id, 'worker-a', 'lease-a', 5000, 0);
    const lost = runs.claimRun('owner-a', created.id, 'worker-b', 'lease-b', 5000, 0);
    assert.equal(won?.seq, 1);
    assert.equal(lost, null);
    const row = getDb().prepare('SELECT lease_token, latest_event_seq, status FROM agent_runs WHERE id = ?').get(created.id) as any;
    assert.deepEqual({ lease: row.lease_token, seq: row.latest_event_seq, status: row.status },
      { lease: 'lease-a', seq: 1, status: 'preparing' });
    assert.equal(runs.heartbeat('owner-a', created.id, 'wrong-lease', 6000), false);
    assert.equal(runs.heartbeat('owner-a', created.id, 'lease-a', 6000), true);
  });

  test('attempt creation, checkpoint, contiguous event CAS, and finalize are transactional', () => {
    const runs = repo();
    const created = runs.createRun(createInput());
    runs.claimRun('owner-a', created.id, 'worker-a', 'lease-a', 5000, 0);
    const attemptInput = { operationId: 'attempt-op', ownerUserId: 'owner-a',
      runId: created.id, profileIndex: 0, runtimeProfile: effectiveDefinition.runtimeProfile,
      recoveryEnvelope: null };
    const attempt = runs.createAttempt(attemptInput);
    assert.equal(attempt.attemptIndex, 0);
    assert.deepEqual(runs.createAttempt(attemptInput), attempt);
    assert.equal(runs.listAttempts('owner-a', created.id)[0].publicSessionId, attempt.id);
    assert.equal((getDb().prepare('SELECT public_session_id FROM agent_run_attempts WHERE id = ?')
      .get(attempt.id) as { public_session_id: string }).public_session_id, attempt.id);
    assert.equal(runs.checkpointAttempt('owner-a', created.id, attempt.id, 'lease-a', { cursor: 1 }), true);
    assert.deepEqual(runs.getLatestAttemptRecovery('owner-a', created.id), {
      attemptId: attempt.id, profileIndex: 0, recoveryEnvelope: null, nativeResumeToken: { cursor: 1 },
    });
    assert.equal(runs.getLatestAttemptRecovery('owner-b', created.id), null);
    const running = runs.appendEventAndProject('owner-a', created.id, 1, {
      type: AgentRunEventType.RunStatusChanged, attemptId: attempt.id,
      payload: { version: 1, from: AgentRunStatus.Preparing, to: AgentRunStatus.Running },
    }, { status: AgentRunStatus.Running, startedAt: now });
    assert.equal(running.seq, 2);
    assert.throws(() => runs.appendEventAndProject('owner-a', created.id, 1, {
      type: AgentRunEventType.Thought, payload: { text: 'stale' },
    }), /sequence conflict/);
    const result = { version: 1 as const, status: 'completed' as const, source: 'submitted' as const,
      handoff: { conclusion: 'Done', artifactsOrChanges: '', unresolvedIssues: '' },
      artifacts: [], resourceMutations: [], externalActions: [] };
    const done = runs.finalizeAttempt('owner-a', created.id, attempt.id, 'lease-a', 'completed',
      AgentRunStatus.Completed, result, null, 2,
      { type: AgentRunEventType.ResultBundleUpdated, payload: result });
    assert.equal(done.status, AgentRunStatus.Completed);
    assert.equal(done.latestEventSeq, 3);
    assert.equal(done.resultBundle?.handoff.conclusion, 'Done');
  });

  test('legacy public session metadata reads as the Attempt id without rewriting native recovery metadata', () => {
    const runs = repo();
    const run = runs.createRun(createInput());
    const attempt = runs.createAttempt({ operationId: 'attempt-op', ownerUserId: 'owner-a',
      runId: run.id, profileIndex: 0, runtimeProfile: effectiveDefinition.runtimeProfile, recoveryEnvelope: null });
    const token = JSON.stringify({ nativeSessionId: 'opaque-private-session', cursor: 7 });
    getDb().prepare('UPDATE agent_run_attempts SET public_session_id = ?, native_resume_token = ? WHERE id = ?')
      .run('operation-legacy', token, attempt.id);

    assert.equal(runs.listAttempts('owner-a', run.id)[0].publicSessionId, attempt.id);
    assert.deepEqual(runs.listAttempts('owner-b', run.id), []);
    assert.deepEqual(runs.getLatestAttemptRecovery('owner-a', run.id)?.nativeResumeToken, JSON.parse(token));
    const stored = getDb().prepare('SELECT public_session_id, native_resume_token FROM agent_run_attempts WHERE id = ?')
      .get(attempt.id) as { public_session_id: string; native_resume_token: string };
    assert.deepEqual({ ...stored }, { public_session_id: 'operation-legacy', native_resume_token: token });
  });

  test('real coordinator, repository and executor share one public Attempt identity for runtime effects and release', async () => {
    const runs = repo();
    const run = runs.createRun(createInput());
    const effectPath = path.join(tmpDir, 'attempt-effect.txt');
    const releases: Array<[string, RuntimeSessionOwner | undefined]> = [];
    const options: NewAgentSessionOptions[] = [];
    const nativeResumeToken = { nativeSessionId: 'private-native-session', cursor: 1 };
    const runtime: AgentRuntime = {
      descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
      id: 'pi', label: 'isolated test runtime',
      capabilities: { modes: false, permissions: true, models: true, providerModels: false,
        reasoning: true, supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false,
        spawnBranches: false, nativeResume: false },
      async warm() {}, async shutdown() {},
      async newSession(input) {
        options.push(input);
        const owner = input.owner!;
        const michi = hostOwner(owner);
        assert.equal(michi.kind, 'agent_run');
        if (michi.kind !== 'agent_run') throw new Error('expected Agent Run owner');
        assert.equal(input.sessionId, michi.attemptId);
        assert.equal(michi.runId, run.id);
        assert.equal(input.ownerUserId, 'owner-a');
        assert.equal(input.workspaceId, 'ws-a');
        const tools = (input.toolProfile as RunWorkerToolProfile).runWorkerTools;
        return {
          id: input.sessionId!, owner, runtimeId: 'pi', runtimeProfileHash: input.profileHash,
          nativeSessionId: 'private-native-session', getNativeResumeToken: () => nativeResumeToken,
          getHistory: () => [], getPendingAssistant: () => undefined, async cancel() {},
          async *send(): AsyncGenerator<NormalizedEvent, void, unknown> {
            const bundle = { version: 1, status: 'completed', source: 'submitted',
              handoff: { conclusion: 'Created effect', artifactsOrChanges: 'attempt-effect.txt', unresolvedIssues: '' },
              artifacts: [{ id: 'effect', name: 'attempt-effect.txt', kind: 'file', uri: effectPath, sha256: null, size: null }],
              resourceMutations: [], externalActions: [] };
            assert.throws(() => tools.submitAgentResult(runOwner(run.id, 'operation-wrong-owner'), bundle), /owner does not match/);
            fs.writeFileSync(effectPath, michi.attemptId);
            tools.submitAgentResult(owner, bundle);
            yield { kind: 'chunk', text: 'Created effect' };
            yield { kind: 'turn_end', stopReason: 'end_turn' };
          },
        };
      },
      releaseSession(id, owner) { releases.push([id, owner]); },
    };
    const coordinator = new AgentRunCoordinator({
      repository: runs, definitions: { get: () => null },
      capabilities: { assertRuntimeReady() {}, resolve: () => ({ version: 1, entries: [] }) },
      contexts: { snapshot: async ({ manifest }) => manifest, cleanup: async () => {} },
      environments: { async prepare() { throw new Error('existing Run uses its persisted environment'); } },
      executor: new RuntimeRunExecutor({ resolveRuntime: () => runtime, adapters: [new PiRunAdapter()] }),
      workspaces: { resolve: () => ({ cwd: tmpDir, permissionPolicy: effectiveDefinition.permissionPolicy }) },
      notifier: { notify: async () => {} }, parentSink: { deliver: async () => 'delivered' },
      resourceCleaner: { cleanup: async () => {} }, instanceId: 'identity-test',
      platformPermissionPolicy: effectiveDefinition.permissionPolicy, maxRunTtlMs: 60_000,
      clock: { now: () => now, setTimeout: () => null, clearTimeout() {} },
      nextId: (kind) => `${kind}-${ids[kind] = (ids[kind] ?? 0) + 1}`,
    });

    assert.equal(await coordinator.start('owner-b', run.id), null);
    assert.equal(options.length, 0);
    assert.equal(fs.existsSync(effectPath), false);
    const completed = await coordinator.start('owner-a', run.id);
    const [attempt] = runs.listAttempts('owner-a', run.id);
    const owner: RuntimeSessionOwner = runOwner(run.id, attempt.id);
    assert.equal(completed?.status, AgentRunStatus.Completed);
    assert.equal(attempt.publicSessionId, attempt.id);
    assert.equal((getDb().prepare('SELECT public_session_id FROM agent_run_attempts WHERE id = ?')
      .get(attempt.id) as { public_session_id: string }).public_session_id, attempt.id);
    assert.equal(options.length, 1);
    assert.equal(options[0].sessionId, attempt.publicSessionId);
    assert.deepEqual(options[0].owner, owner);
    assert.deepEqual(releases, [[attempt.publicSessionId, owner]]);
    assert.equal(fs.readFileSync(effectPath, 'utf8'), attempt.publicSessionId);
    assert.equal(completed?.resultBundle?.artifacts[0].uri, effectPath);
    assert.deepEqual(runs.getLatestAttemptRecovery('owner-a', run.id)?.nativeResumeToken, nativeResumeToken);
    assert(runs.listEvents('owner-a', run.id).filter((event) => event.attemptId !== null)
      .every((event) => event.attemptId === attempt.publicSessionId));
    assert.deepEqual(runs.listAttempts('owner-b', run.id), []);
  });

  test('interactions and Watches are durable, unique, owner-scoped, and fire once', () => {
    const runs = repo();
    const created = runs.createRun(createInput());
    const sibling = runs.createRun(createInput('spawn-2'));
    const interaction = runs.createInteraction('owner-a', created.id, null, 'permission', { tool: 'bash' }, 'interaction-op');
    const resolved = runs.resolveInteraction('owner-a', interaction.id, 'resolved', { allow: true }, 'resolve-op');
    assert.equal(resolved?.status, 'resolved');
    assert.equal(runs.resolveInteraction('owner-b', interaction.id, 'resolved', {}, 'wrong-owner'), null);

    const watch = runs.createWatch('owner-a', 'ws-a', [created.id, created.id],
      { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'watch-op');
    assert.deepEqual(watch.runIds, [created.id]);
    assert.equal(runs.addWatchMembers('owner-a', watch.id, [created.id]), 0);
    assert.deepEqual(runs.updateWatch('owner-a', watch.id, [sibling.id], { version: 1, kind: 'quorum', count: 2 })?.runIds, [created.id, sibling.id]);
    assert.throws(() => runs.updateWatch('owner-a', watch.id, ['missing-run']), /watch Run not found/);
    assert.deepEqual(runs.getWatch('owner-a', watch.id)?.runIds, [created.id, sibling.id]);
    assert.equal(runs.fireWatch('owner-a', watch.id), true);
    assert.equal(runs.fireWatch('owner-a', watch.id), false);
    assert.equal(runs.deleteRun('owner-a', created.id), true);
    assert.equal(runs.deleteRun('owner-a', sibling.id), true);
    assert.deepEqual(runs.getWatch('owner-a', watch.id)?.runIds, []);
  });

  test('startup recovery discovery pages active and fired Watches with pending delivery across owners', () => {
    const runs = repo();
    const activeRun = runs.createRun(createInput('active-run'));
    const pendingRun = runs.createRun(createInput('pending-run'));
    const deliveredRun = runs.createRun(createInput('delivered-run'));
    const ownerBRun = runs.createRun({ ...createInput('owner-b-run'), ownerUserId: 'owner-b', workspaceId: 'ws-b' });
    const active = runs.createWatch('owner-a', 'ws-a', [activeRun.id], { version: 1, kind: 'deadline', at: 10 }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'active-watch');
    const pending = runs.createWatch('owner-a', 'ws-a', [pendingRun.id], { version: 1, kind: 'all' }, 'wake',
      { parentRunId: pendingRun.id, parentNodeId: null, parentTurnId: null }, 'pending-watch');
    const delivered = runs.createWatch('owner-a', 'ws-a', [deliveredRun.id], { version: 1, kind: 'all' }, 'wake',
      { parentRunId: deliveredRun.id, parentNodeId: null, parentTurnId: null }, 'delivered-watch');
    const ownerB = runs.createWatch('owner-b', 'ws-b', [ownerBRun.id], { version: 1, kind: 'manual' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'owner-b-watch');
    runs.fireWatch('owner-a', pending.id);
    runs.fireWatch('owner-a', delivered.id);
    runs.markWatchDelivery('owner-a', delivered.id, 'delivered');
    runs.deleteRun('owner-a', activeRun.id);

    const firstActivePage = runs.listActiveWatchesForRecovery(null, 1);
    const secondActivePage = runs.listActiveWatchesForRecovery(firstActivePage[0].id, 10);
    assert.deepEqual([...firstActivePage, ...secondActivePage].map((watch) => watch.id), [active.id, ownerB.id]);
    assert.deepEqual(firstActivePage[0].runIds, [], 'historical empty membership remains discoverable for an inert audit');
    assert.deepEqual(runs.listFiredWatchesPendingDelivery().map((watch) => watch.id), [pending.id]);
    assert.equal(runs.listFiredWatchesPendingDelivery()[0].ownerUserId, 'owner-a');
  });

  test('bounded search includes archived terminal Runs and TTL candidates without cross-owner leakage', () => {
    const runs = repo();
    const created = runs.createRun({ ...createInput(), expiresAt: 900 });
    getDb().prepare(`UPDATE agent_runs SET status='completed', completed_at=1100, archived_at=1100,
      handoff_search_text='sqlite complete' WHERE id = ?`).run(created.id);
    const hidden = runs.listRuns('owner-a', { version: 1, workspaceId: 'ws-a', q: 'sqlite', includeArchived: false });
    const visible = runs.listRuns('owner-a', { version: 1, workspaceId: 'ws-a', q: 'sqlite', includeArchived: true, limit: 500 });
    assert.equal(hidden.length, 0);
    assert.equal(visible.length, 1);
    assert.equal(runs.listTtlCandidates('owner-a', 'ws-a', 1000).length, 1);
    assert.throws(() => runs.listRuns('owner-b', { version: 1, workspaceId: 'ws-a' }), /workspace not found/);
  });
});
