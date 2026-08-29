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

  test('preserves the snapshotted Definition revision after Definition deletion', () => {
    getDb().prepare(`INSERT INTO agent_definitions (
      id, owner_user_id, scope, workspace_id, name, description, instructions,
      runtime_profile, fallback_chain, tool_refs, skill_refs, mcp_server_refs,
      permission_policy, context_policy, default_run_ttl_ms, status, revision,
      created_at, updated_at
    ) VALUES (?, ?, 'workspace', ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'enabled', 3, 1, 1)`).run(
      'definition-1', 'owner-a', 'ws-a', effectiveDefinition.name, effectiveDefinition.instructions,
      JSON.stringify(effectiveDefinition.runtimeProfile), JSON.stringify({ version: 1, profiles: [] }),
      JSON.stringify({ version: 1, values: [] }), JSON.stringify({ version: 1, values: [] }),
      JSON.stringify({ version: 1, values: [] }), JSON.stringify(effectiveDefinition.permissionPolicy),
      JSON.stringify(effectiveDefinition.contextPolicy),
    );
    const runs = repo();
    const created = runs.createRun({ ...createInput(), definitionId: 'definition-1', definitionRevision: 3 });
    getDb().prepare('DELETE FROM agent_definitions WHERE id = ?').run('definition-1');
    const historical = runs.getRun('owner-a', created.id);
    assert.equal(historical?.definitionId, null);
    assert.equal(historical?.definitionRevision, 3);
  });

  test('persists an exact nested parent Attempt and rejects mismatched ancestry', () => {
    const runs = repo();
    const parent = runs.createRun(createInput('parent-spawn'));
    const attempt = runs.createAttempt({ operationId: 'parent-attempt', ownerUserId: 'owner-a', runId: parent.id,
      profileIndex: 0, runtimeProfile: effectiveDefinition.runtimeProfile, publicSessionId: 'parent-session', recoveryEnvelope: null });
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

  test('desktop local owner sentinel can use legacy NULL-owner workspaces only outside cloud mode', () => {
    getDb().prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, NULL, 1, 1)')
      .run('ws-local', 'Local');
    const runs = repo();
    const localInput = { ...createInput('local-spawn'), ownerUserId: 'local-user', workspaceId: 'ws-local' };
    assert.equal(runs.createRun(localInput).ownerUserId, 'local-user');
    process.env.MICHI_CLOUD = '1';
    try {
      assert.throws(() => runs.createRun({ ...localInput, operationId: 'cloud-spawn' }), /workspace not found/);
    } finally {
      delete process.env.MICHI_CLOUD;
    }
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
    const attempt = runs.createAttempt({ operationId: 'attempt-op', ownerUserId: 'owner-a',
      runId: created.id, profileIndex: 0, runtimeProfile: effectiveDefinition.runtimeProfile,
      publicSessionId: 'public-session-1', recoveryEnvelope: null });
    assert.equal(attempt.attemptIndex, 0);
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
