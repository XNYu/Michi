/**
 * Tests for PaneInspectionService.inspect — the acceptance criteria from the P1-6 brief.
 *
 * Uses a fresh temp-SQLite MICHI_DATA_DIR per test (mirrors turnPersistenceRepository.test.ts /
 * trimNodeRepository.test.ts) plus the real ChatHub and AgentRunsRepository, since both are
 * cheap, in-process and exactly what P1-6 is meant to drive — no fake ChatHub/run repository was
 * needed to keep this fast and free of a real agent CLI (chatHub.ts starts no process itself; it
 * only records turn state pushed into it via beginTurn/applyTurnEvent-style snapshots).
 *
 * P1-11 will extend this same file with the isolation matrix — describe names below are kept
 * narrow and literal so the two sets do not tangle.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentPolicyCategory, AgentPolicyDecision, AgentRunEventType, AgentRunStatus, createDurableTurn, applyTurnEvent, PANE_KINDS, PaneInspectionError, type ChatStreamEvent, type EffectiveAgentDefinitionV1, type PaneFeedEventV1 } from 'michi-shared';
import { closeDb, initDb, getDb } from '../src/services/db';
import { beginTurn, finalizeTurn, saveEdge, saveNode, saveTree, saveWorkspace, updateNodeTitle, saveMessage, getCompletedTurnCount, getNodesMetadataByIds, type NodeRow } from '../src/services/dbRepository';

import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { inspect, scopeForCaller, type PaneInspectionCaller, __testOnlyPanePresenceRegistry } from '../src/services/paneInspection';
import { paneInspectionRing } from '../src/services/paneInspectionRing';
import { PanePresenceRegistry } from '../src/services/panePresence';
import { type SurfacePaneKind } from '../src/services/paneInspectionProjection.surface';
import { readOutput } from '../src/services/paneInspectionOutput';
import { waitPane } from '../src/services/paneInspectionWait';
import { PaneFeed, systemPaneSubscribeClock, configurePaneInspectionEventBus } from '../src/services/paneInspectionSubscribe';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { buildPaneInspectionCaller } from '../src/agents/paneInspectionTools';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pane-inspection-'));
}

// Desktop-mode fixtures: saveWorkspace() leaves owner_user_id NULL (no MICHI_CLOUD set for these
// tests), so the caller's ownerUserId must be the fixed desktop identity for
// workspaceOwnerMatches()/AgentRunsRepository's assertWorkspaceOwner to accept it — a plain
// "owner-1" string would fail every owner-scoped read against a desktop-mode workspace.
const OWNER = LOCAL_AGENT_OWNER_ID;
const WORKSPACE = 'ws-1';

function caller(overrides: Partial<PaneInspectionCaller> = {}): PaneInspectionCaller {
  return {
    ownerUserId: OWNER,
    workspaceId: WORKSPACE,
    backendConnectionId: 'conn-1',
    ...overrides,
  };
}

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

function seedWorkspace(id = WORKSPACE): void {
  saveWorkspace({
    id, name: 'Workspace', created_at: 1, updated_at: 1,
    active_tree_id: null, cwd: null, settings: null,
    deleted_at: null, archived_at: null,
  });
}

interface NodeOpts {
  parentNodeId?: string | null;
  treeId?: string | null;
  status?: string;
  kind?: string;
  title?: string | null;
  runtimeId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  createdAt?: number;
  spawnedByAgent?: number;
}

function seedNode(id: string, opts: NodeOpts = {}): NodeRow {
  const row: NodeRow = {
    id, workspace_id: WORKSPACE,
    tree_id: opts.treeId ?? null,
    parent_node_id: opts.parentNodeId ?? null,
    kind: opts.kind ?? 'chat', title: opts.title ?? null, branch_overview: null,
    status: opts.status ?? 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: opts.spawnedByAgent ?? 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: null, runtime_id: opts.runtimeId ?? null, provider_id: opts.providerId ?? null,
    model_id: opts.modelId ?? null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: opts.createdAt ?? 1,
  };
  saveNode(row);
  return row;
}

function seedTree(id: string, rootNodeId: string): void {
  saveTree({
    id, workspace_id: WORKSPACE, root_node_id: rootNodeId,
    name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1,
  });
}

function seedBranchEdge(id: string, sourceNodeId: string, targetNodeId: string, anchorMessageId: string | null): void {
  saveEdge({
    id, workspace_id: WORKSPACE,
    source_node_id: sourceNodeId, target_node_id: targetNodeId,
    kind: 'branch', anchor_message_id: anchorMessageId, created_at: 1,
  });
}

/** Drives a full begin -> chunk -> done -> finalize turn so a real completed turn row exists. */
function seedCompletedTurn(nodeId: string, turnId: string, startedAt = 100): void {
  let snapshot = createDurableTurn({
    turnId, assistantId: `a-${turnId}`, nodeId, workspaceId: WORKSPACE,
    displayUserText: 'hello', startedAt,
  });
  beginTurn(snapshot);
  snapshot = applyTurnEvent(snapshot, event('chunk', { text: 'hi there', seq: 1 }));
  snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'end_turn', seq: 2 }));
  finalizeTurn(snapshot);
}

const RUNTIME_PROFILE = { version: 1 as const, runtimeId: 'pi' };
const HASH = 'a'.repeat(64);

function effectiveDefinition(overrides: Partial<EffectiveAgentDefinitionV1['permissionPolicy']['categories']> = {}): EffectiveAgentDefinitionV1 {
  return {
    version: 1, name: 'Worker', description: 'Works', instructions: 'Work',
    runtimeProfile: RUNTIME_PROFILE, fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: {
      version: 1, preset: 'research', categories: { [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow, ...overrides },
      maxDelegationDepth: 1, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1,
    },
    contextPolicy: {
      version: 1, includeWorkspaceInstructions: false, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1_000,
    },
  };
}

function createRun(repo: AgentRunsRepository, id: string, overrides: Partial<EffectiveAgentDefinitionV1['permissionPolicy']['categories']> = {}) {
  return repo.createRun({
    operationId: `op-${id}`, ownerUserId: OWNER, workspaceId: WORKSPACE,
    definitionId: null, definitionRevision: null,
    effectiveDefinition: effectiveDefinition(overrides),
    invocationMode: 'manual', completionMode: 'detach' as any,
    parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null,
    parentMessageId: null, parentToolCallId: null,
    task: 'do the thing',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: WORKSPACE, snapshotHash: HASH, createdAt: 1 },
    expiresAt: null,
    initialEvent: { type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: null, to: AgentRunStatus.Queued } },
  });
}

describe('PaneInspectionService.inspect', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace();
  });

  afterEach(() => {
    configurePaneInspectionEventBus(undefined);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('desktop null-owner MCP tools use the bound workspace; cloud remains fail-closed', async () => {
    seedNode('desktop-node');
    const slot = new McpSlotRegistry().create('desktop-session', tmpDir, null, {
      onSpawnBranches: async () => [], onSaveArtifact: () => null,
      onUpdateArtifact: () => null, onShowImage: () => ({ error: 'unused' }),
    }, { workspaceId: WORKSPACE, nodeId: 'desktop-node' });
    const tools = (buildMcpServerForSlot(slot) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>;
    })._registeredTools;
    for (const [name, args] of Object.entries({
      inspect_pane: { nodeId: 'desktop-node' }, read_pane_output: { nodeId: 'desktop-node' },
      list_panes: { scope: 'all' }, wait_pane: { nodeId: 'desktop-node', until: 'changed', cursor: 'unknown', timeoutMs: 1 },
    })) {
      const result = await tools[name].handler(args);
      assert.notEqual(result.isError, true, result.content[0].text);
    }
    const binding = { ownerUserId: null, workspaceId: WORKSPACE, backendConnectionId: 'local' };
    assert.equal(buildPaneInspectionCaller(binding).ownerUserId, OWNER);
    process.env.MICHI_CLOUD = '1';
    try { assert.throws(() => buildPaneInspectionCaller(binding), /not yet bound/); }
    finally { delete process.env.MICHI_CLOUD; }
    assert.throws(() => buildPaneInspectionCaller({ ...binding, workspaceId: null }), /not yet bound/);
  });

  test('MCP inspection tools respect both registration and invocation allowlists', async () => {
    const slot = new McpSlotRegistry().create('run-session', tmpDir, OWNER, {
      onSpawnBranches: async () => [], onSaveArtifact: () => null,
      onUpdateArtifact: () => null, onShowImage: () => ({ error: 'unused' }),
    }, { workspaceId: WORKSPACE });
    slot.exposedToolNames = new Set(['inspect_pane']);
    const tools = (buildMcpServerForSlot(slot) as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    })._registeredTools;
    for (const name of ['read_pane_output', 'wait_pane', 'list_panes']) assert.equal(tools[name], undefined);
    slot.exposedToolNames = new Set();
    await assert.rejects(() => tools.inspect_pane.handler({ nodeId: 'ignored' }), /not exposed/);
  });

  test('Run message-context denial applies to previews, output, and resumed feeds', () => {
    seedNode('restricted-target');
    seedCompletedTurn('restricted-target', 'restricted-turn');
    const run = createRun(new AgentRunsRepository(), 'restricted-caller');
    const restricted = caller({ runOwner: { runId: run.id } });
    const before = inspect(restricted, { locator: { nodeId: 'restricted-target' } });
    const definition = { ...run.effectiveDefinition, contextPolicy: { ...run.effectiveDefinition.contextPolicy, allowMessageContext: false } };
    getDb().prepare('UPDATE agent_runs SET effective_definition = ? WHERE id = ?').run(JSON.stringify(definition), run.id);
    assert.throws(() => inspect(restricted, { locator: { nodeId: 'restricted-target' } }), /context policy/);
    assert.throws(() => readOutput(restricted, { locator: { nodeId: 'restricted-target' }, selection: 'latest', limitBytes: 1024 }), /context policy/);
    const events: PaneFeedEventV1[] = [];
    const feed = new PaneFeed({ clock: systemPaneSubscribeClock, ring: paneInspectionRing });
    try {
      feed.subscribe(restricted, before.ref.paneId, before.observation.cursor, { emit: (event) => { events.push(event); } });
      assert.deepEqual(events.map((event) => event.type), ['access_revoked']);
    } finally { feed.stop(); }
  });

  test('persisted previews and first-start survive a new empty turn without misattributing output', () => {
    seedNode('persisted-node');
    seedCompletedTurn('persisted-node', 'first-turn', 100);
    const empty = createDurableTurn({ turnId: 'second-turn', assistantId: 'second-answer', nodeId: 'persisted-node', workspaceId: WORKSPACE, displayUserText: 'again', startedAt: 200 });
    beginTurn(empty);
    const descriptor = inspect(caller(), { locator: { nodeId: 'persisted-node' } });
    assert.equal(descriptor.timeline.firstExecutionStartedAt, 100);
    assert.equal(descriptor.latestOutput.status, 'ready');
    if (descriptor.latestOutput.status === 'ready') {
      assert.equal(descriptor.latestOutput.value?.text, 'hi there');
      assert.equal(descriptor.latestOutput.value?.outputId, 'chat_turn:first-turn');
      const output = readOutput(caller(), { locator: { nodeId: 'persisted-node' }, outputId: descriptor.latestOutput.value!.outputId, selection: 'latest', limitBytes: 1024 });
      assert.equal(output.text, 'hi there');
    }
    const revision = paneInspectionRing.getRevision(descriptor.ref.paneId);
    inspect(caller(), { locator: { nodeId: 'persisted-node' }, executionRef: { kind: 'chat_turn', nodeId: 'persisted-node', turnId: 'first-turn' } });
    assert.equal(paneInspectionRing.getRevision(descriptor.ref.paneId), revision);
  });

  test('mixed legacy history remains partial in both individual and batch metadata', () => {
    seedNode('legacy-node');
    saveMessage({ id: 'legacy-answer', node_id: 'legacy-node', role: 'assistant', content: 'old answer', seq: 0, created_at: 1 });
    seedCompletedTurn('legacy-node', 'modern-turn');
    assert.deepEqual(getCompletedTurnCount('legacy-node', OWNER), { count: null, coverage: 'partial' });
    assert.deepEqual(getNodesMetadataByIds(['legacy-node'], OWNER).get('legacy-node')?.completedTurns, { count: null, coverage: 'partial' });
    assert.equal(inspect(caller(), { locator: { nodeId: 'legacy-node' } }).timeline.firstExecutionStartedAt, null);
  });

  test('legacy previews can be read by output identity without exposing user messages or another node', () => {
    seedNode('legacy-only');
    seedNode('unrelated-node');
    saveMessage({ id: 'legacy-visible', node_id: 'legacy-only', role: 'assistant', content: 'legacy answer', seq: 0, created_at: 1 });
    saveMessage({ id: 'user-input', node_id: 'legacy-only', role: 'user', content: 'private prompt', seq: 1, created_at: 2 });
    const descriptor = inspect(caller(), { locator: { nodeId: 'legacy-only' } });
    assert.ok(descriptor.latestOutput.status === 'ready' && descriptor.latestOutput.value);
    const preview = descriptor.latestOutput.value;
    assert.equal(preview.outputId, 'chat-message:legacy-visible');
    const input = { locator: { nodeId: 'legacy-only' }, selection: 'latest' as const, limitBytes: 1024 };
    const output = readOutput(caller(), { ...input, outputId: preview.outputId });
    assert.equal(output.text, 'legacy answer');
    assert.equal(output.outputRevision, preview.outputRevision);
    assert.equal(output.execution, null);
    assert.equal(readOutput(caller(), input).outputId, preview.outputId);
    assert.throws(() => readOutput(caller(), { ...input, outputId: 'chat-message:user-input' }), /not available/);
    assert.throws(() => readOutput(caller(), { ...input, locator: { nodeId: 'unrelated-node' }, outputId: preview.outputId }), /not available/);
  });

  test('an explicit outputId cannot override a conflicting execution identity', () => {
    seedNode('output-target');
    seedCompletedTurn('output-target', 'output-turn');
    const input = { locator: { nodeId: 'output-target' }, selection: 'execution' as const, limitBytes: 1024, outputId: 'chat_turn:output-turn' };
    assert.throws(() => readOutput(caller(), { ...input, executionRef: { kind: 'agent_run', runId: 'other-run' } }), /not available/);
    assert.throws(() => readOutput(caller(), { ...input, executionRef: { kind: 'chat_turn', nodeId: 'other-node', turnId: 'output-turn' } }), /not available/);
  });

  test('Run lineage exposes visible parents and hides parents outside the workspace', () => {
    seedTree('run-tree', 'run-parent');
    seedNode('run-parent', { treeId: 'run-tree' });
    seedCompletedTurn('run-parent', 'parent-turn');
    const repo = new AgentRunsRepository();
    const parent = createRun(repo, 'parent-run');
    const attempt = repo.createAttempt({ operationId: 'parent-attempt', ownerUserId: OWNER, runId: parent.id,
      profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, recoveryEnvelope: null });
    const runChild = createRun(repo, 'run-child');
    getDb().prepare("UPDATE agent_runs SET invocation_mode = 'delegated', parent_run_id = ?, parent_attempt_id = ? WHERE id = ?")
      .run(parent.id, attempt.id, runChild.id);
    const runLineage = inspect(caller(), { locator: { runId: runChild.id } }).lineage;
    assert.ok(runLineage.status === 'ready');
    assert.equal(runLineage.value.parentRunId, parent.id);
    assert.equal(runLineage.value.parentNodeId, null);

    const run = createRun(repo, 'chat-child');
    getDb().prepare("UPDATE agent_runs SET invocation_mode = 'delegated', parent_node_id = ?, parent_turn_id = ?, parent_message_id = ? WHERE id = ?")
      .run('run-parent', 'parent-turn', 'a-parent-turn', run.id);
    const descriptor = inspect(caller(), { locator: { runId: run.id } });
    assert.ok(descriptor.lineage.status === 'ready');
    assert.deepEqual(descriptor.lineage.value, { parentNodeId: 'run-parent', parentRunId: null, originMessageId: 'a-parent-turn',
      treeRootNodeId: 'run-parent', childNodeIds: [], childrenTruncated: false });
    seedWorkspace('hidden-workspace');
    getDb().prepare('UPDATE agent_runs SET workspace_id = ? WHERE id = ?').run('hidden-workspace', parent.id);
    getDb().prepare('UPDATE nodes SET workspace_id = ? WHERE id = ?').run('hidden-workspace', 'run-parent');
    const hidden = inspect(caller(), { locator: { runId: run.id } });
    assert.ok(hidden.lineage.status === 'ready');
    assert.equal(hidden.lineage.value.parentNodeId, null);
    assert.equal(hidden.lineage.value.parentRunId, null);
    assert.equal(hidden.lineage.value.originMessageId, null);
    assert.equal(hidden.lineage.value.treeRootNodeId, null);
    const hiddenRunLineage = inspect(caller(), { locator: { runId: runChild.id } }).lineage;
    assert.ok(hiddenRunLineage.status === 'ready');
    assert.equal(hiddenRunLineage.value.parentRunId, null);
  });

  test('real inspect, wait and resumed feed preserve intervening changes and usable replay cursors', async () => {
    seedNode('resumed-node');
    const before = inspect(caller(), { locator: { nodeId: 'resumed-node' } });
    updateNodeTitle('resumed-node', 'renamed before wait');
    const waited = await waitPane(caller(), { locator: { nodeId: 'resumed-node' }, until: 'changed', cursor: before.observation.cursor, timeoutMs: 10 });
    assert.equal(waited.reason, 'changed');
    const events: PaneFeedEventV1[] = [];
    const feed = new PaneFeed({ clock: systemPaneSubscribeClock, ring: paneInspectionRing });
    try {
      feed.subscribe(caller(), before.ref.paneId, before.observation.cursor, { emit: (event) => { events.push(event); } });
      assert.ok(events.some((event) => 'descriptor' in event && event.descriptor?.title === 'renamed before wait'));
      const replay = paneInspectionRing.resolveCursor(before.observation.cursor, scopeForCaller(caller()));
      assert.ok(replay.ok && replay.replay.length > 0);
      if (replay.ok) for (const retained of replay.replay) {
        const payload = retained.event.payload as PaneFeedEventV1;
        assert.ok(payload.cursor);
        assert.equal(paneInspectionRing.resolveCursor(payload.cursor, scopeForCaller(caller())).ok, true);
      }
    } finally { feed.stop(); }
  });

  test('run output pages past 1000 events and preserves old attempt output identities', () => {
    const repo = new AgentRunsRepository();
    const run = createRun(repo, 'large-output');
    const first = repo.createAttempt({ operationId: 'attempt-one', ownerUserId: OWNER, runId: run.id, profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, recoveryEnvelope: null });
    for (let i = 0; i < 1005; i++) repo.appendEventAndProject(OWNER, run.id, i, {
      type: AgentRunEventType.Assistant, attemptId: first.id, payload: { version: 1, text: i === 1004 ? 'LATEST_MARKER' : 'abcd' },
    });
    const output = readOutput(caller(), { locator: { runId: run.id }, selection: 'latest', limitBytes: 65536 });
    assert.ok(output.text.endsWith('LATEST_MARKER'));
    const descriptor = inspect(caller(), { locator: { runId: run.id } });
    assert.ok(descriptor.latestOutput.status === 'ready' && descriptor.latestOutput.value?.text.endsWith('LATEST_MARKER'));
    repo.createAttempt({ operationId: 'attempt-two', ownerUserId: OWNER, runId: run.id, profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, recoveryEnvelope: null });
    assert.equal(readOutput(caller(), { locator: { runId: run.id }, selection: 'latest', outputId: output.outputId, limitBytes: 65536 }).text, output.text);
  });

  test('production event-bus configuration wakes default waits immediately and sends the final descriptor', async () => {
    const repo = new AgentRunsRepository();
    const run = createRun(repo, 'live-run');
    repo.appendEventAndProject(OWNER, run.id, 0, { type: AgentRunEventType.RunStatusChanged,
      payload: { version: 1, from: AgentRunStatus.Queued, to: AgentRunStatus.Preparing } }, { status: AgentRunStatus.Preparing });
    repo.appendEventAndProject(OWNER, run.id, 1, { type: AgentRunEventType.RunStatusChanged,
      payload: { version: 1, from: AgentRunStatus.Preparing, to: AgentRunStatus.Running } }, { status: AgentRunStatus.Running, startedAt: run.createdAt });
    const bus = new AgentRunEventBus();
    configurePaneInspectionEventBus(bus);
    const events: PaneFeedEventV1[] = [];
    const feed = new PaneFeed({ clock: systemPaneSubscribeClock, ring: paneInspectionRing });
    try {
      feed.subscribe(caller(), `run:${run.id}`, undefined, { emit: (event) => { events.push(event); } });
      const waiting = waitPane(caller(), { locator: { runId: run.id }, until: 'terminal', executionRef: { kind: 'agent_run', runId: run.id }, timeoutMs: 500 });
      const event = repo.appendEventAndProject(OWNER, run.id, 2, {
        type: AgentRunEventType.RunStatusChanged, payload: { version: 1, from: AgentRunStatus.Running, to: AgentRunStatus.Completed },
      }, { status: AgentRunStatus.Completed, completedAt: run.createdAt + 100 });
      bus.publishCommitted(event);
      assert.equal((await waiting).reason, 'terminal');
      const final = events.find((entry) => entry.type === 'execution_settled');
      assert.ok(final?.type === 'execution_settled');
      assert.equal(final.descriptor?.activity, 'idle');
      assert.equal(final.descriptor?.observation.cursor, final.cursor);
    } finally { feed.stop(); }
  });

  test('a deleted (purged) node does not leak content or lineage — NOT_FOUND', () => {
    seedNode('to-purge');
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now(), 'to-purge');
    assert.throws(() => inspect(caller(), { locator: { nodeId: 'to-purge' } }), (err: unknown) => {
      assert.ok(err instanceof PaneInspectionError);
      return (err as PaneInspectionError).code === 'NOT_FOUND';
    });
  });

  test('a branch child whose origin source is deleted does not leak the source id via originMessageId', () => {
    seedNode('origin-parent');
    seedNode('branch-child', { parentNodeId: 'origin-parent' });
    seedBranchEdge('e1', 'origin-parent', 'branch-child', 'msg-42');
    // Purge the source AFTER creating the edge — the edge row survives (no cascade modeled here),
    // but getNode('origin-parent') must now return null, so resolveOriginMessageId must not trust
    // the edge's anchor blindly.
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now(), 'origin-parent');
    // origin-parent itself is now invisible, but branch-child (the inspected node) is untouched.
    const desc = inspect(caller(), { locator: { nodeId: 'branch-child' } });
    assert.equal(desc.lineage.status, 'ready');
    if (desc.lineage.status !== 'ready') throw new Error('unreachable');
    assert.equal(desc.lineage.value.originMessageId, null);
  });

  test('a visible branch anchor is reported as originMessageId', () => {
    seedNode('origin-parent-2');
    seedNode('branch-child-2', { parentNodeId: 'origin-parent-2' });
    seedBranchEdge('e2', 'origin-parent-2', 'branch-child-2', 'msg-99');
    const desc = inspect(caller(), { locator: { nodeId: 'branch-child-2' } });
    assert.equal(desc.lineage.status, 'ready');
    if (desc.lineage.status !== 'ready') throw new Error('unreachable');
    assert.equal(desc.lineage.value.originMessageId, 'msg-99');
  });

  test('an AgentRun caller whose own Read policy denies Read cannot inspect anything', () => {
    const runs = new AgentRunsRepository();
    const callerRun = createRun(runs, 'caller-run-1', { [AgentPolicyCategory.Read]: AgentPolicyDecision.Deny });
    seedNode('target-node');
    assert.throws(
      () => inspect(caller({ runOwner: { runId: callerRun.id } }), { locator: { nodeId: 'target-node' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
      },
    );
  });
});

// ---------------------------------------------------------------------------
// P1-6b: surface targets routed through the surface projection.
//
// Self-contained describe block, kept deliberately separate from
// 'PaneInspectionService.inspect' above (which P1-11 is also extending in parallel) so the two
// sets of tests never need to touch the same lines.
// ---------------------------------------------------------------------------

describe('PaneInspectionService.inspect — surface targets (P1-6b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Registers a live surface presence view against the service's own (test-only-exported)
   *  presence registry, and returns the resulting `surface:{registrationId}` paneId. This is the
   *  only way to make a `surface:` locator resolve to anything other than NOT_FOUND — there is no
   *  DB row for a surface target (design §4.2). */
  function registerSurface(
    kind: SurfacePaneKind,
    opts: { workspaceId?: string; treeId?: string | null; title?: string | null } = {},
  ): string {
    const presenceCaller = { ownerUserId: OWNER, workspaceId: opts.workspaceId ?? WORKSPACE, connectionId: 'conn-1' };
    const { registrationId, paneId } = __testOnlyPanePresenceRegistry.allocateSurfaceRegistration(presenceCaller, kind);
    const result = __testOnlyPanePresenceRegistry.submitPresence(
      presenceCaller,
      {
        viewRevision: 1,
        windowId: 'window-a',
        views: [{
          paneId, windowId: 'window-a', uiPaneId: `ui-${kind}`,
          treeId: opts.treeId ?? null, visible: true, openedAtClient: null,
          surfaceTitle: opts.title ?? null,
        }],
      },
    );
    assert.equal(result.ok, true, 'test setup: surface presence submission must succeed');
    return paneId;
  }

  test('an unknown registrationId is NOT_FOUND, not an empty descriptor', () => {
    const { paneId } = (() => {
      const alloc = __testOnlyPanePresenceRegistry.allocateSurfaceRegistration(
        { ownerUserId: OWNER, workspaceId: WORKSPACE, connectionId: 'conn-1' },
        'files',
      );
      return alloc;
    })();
    // Deliberately never submitted to presence — no lease has ever reported this registrationId.
    assert.throws(
      () => inspect(caller(), { locator: { paneId } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NOT_FOUND';
      },
    );
  });

  test('an expired registration is NOT_FOUND, not an empty descriptor', () => {
    let now = 1_000;
    const registry = new PanePresenceRegistry(undefined, { now: () => now, ttlMs: 60_000 });
    const presenceCaller = { ownerUserId: OWNER, workspaceId: WORKSPACE, connectionId: 'conn-1' };
    const { registrationId, paneId } = registry.allocateSurfaceRegistration(presenceCaller, 'diff');
    const submitted = registry.submitPresence(
      presenceCaller,
      { viewRevision: 1, windowId: 'window-a', views: [{ paneId, windowId: 'window-a', uiPaneId: 'ui-diff', treeId: null, visible: true, openedAtClient: null, surfaceTitle: null }] },
    );
    assert.equal(submitted.ok, true);
    assert.equal(registry.getSurfaceRegistrationInfo(registrationId) !== null, true, 'sanity: registration is live before expiry');

    now += 120_000; // past ttlMs — the lease is now expired and swept on next access.
    assert.equal(registry.getSurfaceRegistrationInfo(registrationId), null);
  });

  // -------------------------------------------------------------------------
  // 11-kind coverage — the strong assertion P2-3 had to weaken (P1-6/surface routing did not yet
  // exist when P2-3 was written). With both present, inspect() must produce a descriptor for
  // EVERY PaneKind, given an appropriate target. Fails loudly (by name) if one kind falls through.
  // -------------------------------------------------------------------------

  test('every PaneKind in the shared PANE_KINDS array is inspectable', () => {
    seedNode('coverage-chat-node', { kind: 'chat' });
    seedNode('coverage-digest-node', { kind: 'digest' });
    seedNode('coverage-artifact-node', { kind: 'artifact' });
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'coverage-run-1');

    const targetForKind: Record<string, () => { locator: { nodeId: string } | { runId: string } | { paneId: string } }> = {
      chat: () => ({ locator: { nodeId: 'coverage-chat-node' } }),
      'agent-run': () => ({ locator: { runId: run.id } }),
      digest: () => ({ locator: { nodeId: 'coverage-digest-node' } }),
      artifact: () => ({ locator: { nodeId: 'coverage-artifact-node' } }),
      launcher: () => ({ locator: { paneId: registerSurface('launcher') } }),
      files: () => ({ locator: { paneId: registerSurface('files') } }),
      review: () => ({ locator: { paneId: registerSurface('review') } }),
      file: () => ({ locator: { paneId: registerSurface('file') } }),
      diff: () => ({ locator: { paneId: registerSurface('diff') } }),
      terminal: () => ({ locator: { paneId: registerSurface('terminal') } }),
      browser: () => ({ locator: { paneId: registerSurface('browser') } }),
    };

    const failures: string[] = [];
    for (const kind of PANE_KINDS) {
      const buildInput = targetForKind[kind];
      if (!buildInput) {
        failures.push(`${kind}: no target builder registered in this test — PANE_KINDS grew without this coverage test being updated`);
        continue;
      }
      try {
        const desc = inspect(caller(), buildInput());
        if (desc.kind !== kind) {
          failures.push(`${kind}: inspect() returned a descriptor of kind "${desc.kind}" instead`);
        }
      } catch (err) {
        failures.push(`${kind}: inspect() threw ${err instanceof PaneInspectionError ? err.code : String(err)} instead of returning a descriptor`);
      }
    }

    assert.deepEqual(failures, [], `every PaneKind must be inspectable; failures:\n${failures.join('\n')}`);
    // Belt-and-suspenders: PANE_KINDS itself must actually contain 11 entries, so a future
    // shrinkage of the shared union doesn't silently make this test vacuous.
    assert.equal(PANE_KINDS.length, 11);
  });
});

// ---------------------------------------------------------------------------
// P1-11: authorisation and isolation matrix (design §10, COMMON.md decisions 6/7/9/10, brief
// §15 acceptance items). Self-contained describe block — does not touch or restructure the
// `PaneInspectionService.inspect` block above (owned by P1-6). P1-6b's own describe block lives
// in this same file and is likewise left untouched.
// ---------------------------------------------------------------------------

describe('P1-11: authorisation and isolation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace();
  });

  afterEach(() => {
    closeDb();
    delete process.env.MICHI_CLOUD;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('1. a caller with a different ownerUserId cannot inspect a run owned by someone else — NOT_FOUND', () => {
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'owner-run-1');
    // AgentRunsRepository.getRun queries `WHERE id = ? AND owner_user_id = ?` directly — no
    // MICHI_CLOUD gate needed for a run target; ownership is unconditional there.
    const other = caller({ ownerUserId: 'someone-else' });
    assert.throws(() => inspect(other, { locator: { runId: run.id } }), (err: unknown) => {
      assert.ok(err instanceof PaneInspectionError);
      return (err as PaneInspectionError).code === 'NOT_FOUND';
    });
  });

  test('8. authorizeCaller re-checks ownership on every call — a second caller cannot ride a first caller\'s success', () => {
    // A more direct construction of the "collision" concern at the layer this service actually
    // controls: two DIFFERENT owners inspecting the SAME nodeId value in immediate succession.
    // If any state were cached keyed only by nodeId (ignoring which caller/backend asked), the
    // second call could incorrectly reuse the first caller's authorization.
    process.env.MICHI_CLOUD = '1';
    try {
      getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run(OWNER, WORKSPACE);
      seedNode('shared-id-node');

      const first = inspect(caller({ ownerUserId: OWNER }), { locator: { nodeId: 'shared-id-node' } });
      assert.equal(first.kind, 'chat');

      assert.throws(
        () => inspect(caller({ ownerUserId: 'someone-else' }), { locator: { nodeId: 'shared-id-node' } }),
        (err: unknown) => {
          assert.ok(err instanceof PaneInspectionError);
          return (err as PaneInspectionError).code === 'NOT_FOUND';
        },
      );
    } finally {
      delete process.env.MICHI_CLOUD;
    }
  });

  test('10. an executionRef naming a turn in a different workspace is rejected even if the turnId is real', () => {
    seedWorkspace('ws-cross');
    // Build the cross-workspace node directly to avoid coupling to seedNode's WORKSPACE constant.
    saveNode({
      id: 'cross-ws-node', workspace_id: 'ws-cross', tree_id: null, parent_node_id: null,
      kind: 'chat', title: null, branch_overview: null, status: 'idle',
      position_x: null, position_y: null, minimized: 0, deleted_at: null,
      deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
      pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
      acp_session_id: null, runtime_id: null, provider_id: null,
      model_id: null, reasoning: null, resume_fingerprint: null,
      composer_draft: null, external_session_id: null, trim_snapshot: null,
      created_at: 1,
    });
    // seedCompletedTurn hardcodes workspaceId: WORKSPACE (via createDurableTurn), so it cannot
    // seed a turn on a node that lives in a different workspace — coreBeginTurn itself enforces
    // node.workspace_id === snapshot.workspaceId. Build the turn with the correct workspaceId
    // directly rather than widening the shared helper (owned by P1-6/P1-6b).
    let snapshot = createDurableTurn({
      turnId: 'turn-cross-ws', assistantId: 'a-turn-cross-ws', nodeId: 'cross-ws-node',
      workspaceId: 'ws-cross', displayUserText: 'hello', startedAt: 100,
    });
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, event('chunk', { text: 'hi there', seq: 1 }));
    snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'end_turn', seq: 2 }));
    finalizeTurn(snapshot);

    seedNode('ref-node-same-ws');

    // The ref names a real turn (turn-cross-ws) that exists in ws-cross, but the request targets
    // a node in the caller's own workspace (ref-node-same-ws, in WORKSPACE). validateExecutionRefForNode
    // checks `row.node_id !== node.id`, which already rejects this (the turn's node_id is
    // cross-ws-node, not ref-node-same-ws) without needing a separate workspace comparison — this
    // test pins that a real, existing, differently-scoped turnId cannot be smuggled in this way.
    assert.throws(
      () => inspect(caller(), {
        locator: { nodeId: 'ref-node-same-ws' },
        executionRef: { kind: 'chat_turn', nodeId: 'ref-node-same-ws', turnId: 'turn-cross-ws' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
  });

  test('10. an agent_run executionRef naming a different run is rejected, not silently resolved against the requested run', () => {
    const runs = new AgentRunsRepository();
    const runA = createRun(runs, 'ref-run-a');
    const runB = createRun(runs, 'ref-run-b');

    assert.throws(
      () => inspect(caller(), {
        locator: { runId: runA.id },
        executionRef: { kind: 'agent_run', runId: runB.id },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
  });

  test('10. a chat_turn executionRef against an agent_run target (wrong ref kind) is rejected', () => {
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'kind-mismatch-run');
    seedNode('unrelated-node-for-kind-mismatch');
    seedCompletedTurn('unrelated-node-for-kind-mismatch', 'turn-kind-mismatch', 100);

    assert.throws(
      () => inspect(caller(), {
        locator: { runId: run.id },
        executionRef: { kind: 'chat_turn', nodeId: 'unrelated-node-for-kind-mismatch', turnId: 'turn-kind-mismatch' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
  });
});
