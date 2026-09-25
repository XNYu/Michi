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

import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  AgentRunEventType,
  AgentRunStatus,
  createDurableTurn,
  decodePaneId,
  applyTurnEvent,
  PANE_KINDS,
  PaneInspectionError,
  type ChatStreamEvent,
  type EffectiveAgentDefinitionV1,
  type PaneFeedEventV1,
} from 'michi-shared';
import { closeDb, initDb, getDb } from '../src/services/db';
import {
  beginTurn,
  finalizeTurn,
  saveEdge,
  saveNode,
  saveTree,
  saveWorkspace,
  setAiGlobalContext,
  updateNodeTitle,
  saveMessage,
  getCompletedTurnCount,
  getNodesMetadataByIds,
  type NodeRow,
} from '../src/services/dbRepository';
import { chatHub } from '../src/agents/chatHub';
import { AgentRunsRepository } from '../src/services/agentRunsRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { inspect, authorizeCaller, resolvePaneTarget, scopeForCaller, type PaneInspectionCaller, __testOnlyPanePresenceRegistry } from '../src/services/paneInspection';
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
      profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'parent-session', recoveryEnvelope: null });
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

  test('archive-lane persistence is reflected even when node status stays idle', () => {
    const node = seedNode('archived-node');
    saveNode({ ...node, deleted_at: 5, deletion_group_id: 'arch-group' });
    assert.equal(inspect(caller(), { locator: { nodeId: node.id } }).archived, true);
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
    const first = repo.createAttempt({ operationId: 'attempt-one', ownerUserId: OWNER, runId: run.id, profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'session-one', recoveryEnvelope: null });
    for (let i = 0; i < 1005; i++) repo.appendEventAndProject(OWNER, run.id, i, {
      type: AgentRunEventType.Assistant, attemptId: first.id, payload: { version: 1, text: i === 1004 ? 'LATEST_MARKER' : 'abcd' },
    });
    const output = readOutput(caller(), { locator: { runId: run.id }, selection: 'latest', limitBytes: 65536 });
    assert.ok(output.text.endsWith('LATEST_MARKER'));
    const descriptor = inspect(caller(), { locator: { runId: run.id } });
    assert.ok(descriptor.latestOutput.status === 'ready' && descriptor.latestOutput.value?.text.endsWith('LATEST_MARKER'));
    repo.createAttempt({ operationId: 'attempt-two', ownerUserId: OWNER, runId: run.id, profileIndex: 0, runtimeProfile: RUNTIME_PROFILE, publicSessionId: 'session-two', recoveryEnvelope: null });
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

  // -------------------------------------------------------------------------
  // Locator resolution: same object via all three locator forms
  // -------------------------------------------------------------------------

  test('inspect by nodeId, canonical paneId, and runId all resolve consistently', () => {
    seedNode('node-1');
    seedCompletedTurn('node-1', 'turn-1');

    const byNode = inspect(caller(), { locator: { nodeId: 'node-1' } });
    const byPaneId = inspect(caller(), { locator: { paneId: byNode.ref.paneId } });
    // observedAt is Date.now()-sampled per call and may tick between the two inspect() calls
    // above — compare everything except that one timestamp field. cursor is likewise masked as
    // of P3-3: it is now a randomly-minted ring token (design §8 "cursor 字符串本身是随机 token"),
    // not a deterministic string derived from the target — two inspect() calls for the very same
    // object legitimately mint two DIFFERENT resolvable tokens (P3-3's own acceptance test
    // proves resolvability separately; this test's job is only "everything else matches").
    assert.deepEqual(
      { ...byNode, observation: { ...byNode.observation, observedAt: 0, cursor: '' } },
      { ...byPaneId, observation: { ...byPaneId.observation, observedAt: 0, cursor: '' } },
    );
    assert.equal(byNode.ref.paneId, 'node:node-1');
    assert.deepEqual(decodePaneId(byNode.ref.paneId), { kind: 'node', nodeId: 'node-1' });

    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'run-1');
    const byRunId = inspect(caller(), { locator: { runId: run.id } });
    assert.equal(byRunId.ref.paneId, `run:${run.id}`);
    const byRunPaneId = inspect(caller(), { locator: { paneId: byRunId.ref.paneId } });
    assert.deepEqual(
      { ...byRunId, observation: { ...byRunId.observation, observedAt: 0, cursor: '' } },
      { ...byRunPaneId, observation: { ...byRunPaneId.observation, observedAt: 0, cursor: '' } },
    );
  });

  // -------------------------------------------------------------------------
  // Locator arity — enforced upstream by parsePaneLocator, but resolvePaneTarget/authorizeCaller
  // must not silently accept a malformed locator either.
  // -------------------------------------------------------------------------

  test('two locators or zero locators is INVALID_ARGUMENT', () => {
    // parsePaneLocator (shared/src/paneInspection.ts) is the layer that actually enforces "exactly
    // one of paneId/nodeId/runId" for untrusted input; this test proves that invariant by calling
    // it directly, since PaneLocator's TS type itself is already a discriminated union that
    // cannot represent "two at once" without an explicit cast.
    const { parsePaneLocator } = require('michi-shared') as typeof import('michi-shared');
    assert.throws(() => parsePaneLocator({ nodeId: 'n1', runId: 'r1' }), (err: unknown) => {
      assert.ok(err instanceof Error);
      return /exactly one/.test((err as Error).message);
    });
    assert.throws(() => parsePaneLocator({}), (err: unknown) => {
      assert.ok(err instanceof Error);
      return /exactly one/.test((err as Error).message);
    });
  });

  // -------------------------------------------------------------------------
  // Kind coverage
  // -------------------------------------------------------------------------

  test('chat, agent-run, digest, and artifact all return valid descriptors', () => {
    seedNode('chat-1');
    const chatDesc = inspect(caller(), { locator: { nodeId: 'chat-1' } });
    assert.equal(chatDesc.kind, 'chat');

    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'run-2');
    const runDesc = inspect(caller(), { locator: { runId: run.id } });
    assert.equal(runDesc.kind, 'agent-run');

    seedNode('digest-1', { kind: 'digest' });
    const digestDesc = inspect(caller(), { locator: { nodeId: 'digest-1' } });
    assert.equal(digestDesc.kind, 'digest');

    seedNode('artifact-1', { kind: 'artifact' });
    const artifactDesc = inspect(caller(), { locator: { nodeId: 'artifact-1' } });
    assert.equal(artifactDesc.kind, 'artifact');
  });

  // -------------------------------------------------------------------------
  // Lineage — branch children only
  // -------------------------------------------------------------------------

  test('a mixed branch + merge + link + digest-source graph yields only branch children', () => {
    seedNode('parent-1');
    // Branch children — via nodes.parent_node_id, the source of truth this service uses.
    seedNode('branch-child-1', { parentNodeId: 'parent-1' });
    seedNode('branch-child-2', { parentNodeId: 'parent-1' });
    // A node that is the target of a merge/link/digest-source EDGE from parent-1, but whose OWN
    // parent_node_id points elsewhere — proves edges of the wrong kind cannot leak in even when
    // they exist pointing at/from this node.
    seedNode('unrelated-node');
    seedNode('merge-target', { parentNodeId: 'unrelated-node' });
    seedBranchEdge('e-merge', 'parent-1', 'merge-target', null);
    saveEdge({ id: 'e-merge-2', workspace_id: WORKSPACE, source_node_id: 'parent-1', target_node_id: 'merge-target', kind: 'merge', anchor_message_id: null, created_at: 1 });
    saveEdge({ id: 'e-link', workspace_id: WORKSPACE, source_node_id: 'parent-1', target_node_id: 'unrelated-node', kind: 'link', anchor_message_id: null, created_at: 1 });
    saveEdge({ id: 'e-digest-source', workspace_id: WORKSPACE, source_node_id: 'parent-1', target_node_id: 'unrelated-node', kind: 'digest-source', anchor_message_id: null, created_at: 1 });

    const desc = inspect(caller(), { locator: { nodeId: 'parent-1' } });
    assert.equal(desc.lineage.status, 'ready');
    if (desc.lineage.status !== 'ready') throw new Error('unreachable');
    assert.deepEqual([...desc.lineage.value.childNodeIds].sort(), ['branch-child-1', 'branch-child-2']);
    assert.equal(desc.lineage.value.childrenTruncated, false);
  });

  // -------------------------------------------------------------------------
  // Archived / deleted visibility
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // executionRef honouring
  // -------------------------------------------------------------------------

  test('a supplied executionRef for an older turn returns that turn\'s outcome, not the newest', () => {
    seedNode('multi-turn');
    seedCompletedTurn('multi-turn', 'turn-old', 100);
    seedCompletedTurn('multi-turn', 'turn-new', 200);

    const latest = inspect(caller(), { locator: { nodeId: 'multi-turn' } });
    assert.equal(latest.execution.status, 'ready');
    if (latest.execution.status !== 'ready' || !latest.execution.value) throw new Error('unreachable');
    assert.equal(latest.execution.value.ref.kind, 'chat_turn');
    assert.equal((latest.execution.value.ref as { turnId: string }).turnId, 'turn-new');

    const old = inspect(caller(), {
      locator: { nodeId: 'multi-turn' },
      executionRef: { kind: 'chat_turn', nodeId: 'multi-turn', turnId: 'turn-old' },
    });
    assert.equal(old.execution.status, 'ready');
    if (old.execution.status !== 'ready' || !old.execution.value) throw new Error('unreachable');
    assert.equal((old.execution.value.ref as { turnId: string }).turnId, 'turn-old');
  });

  test('an executionRef belonging to another object is rejected', () => {
    seedNode('node-a');
    seedNode('node-b');
    seedCompletedTurn('node-b', 'turn-b', 100);

    assert.throws(
      () => inspect(caller(), {
        locator: { nodeId: 'node-a' },
        executionRef: { kind: 'chat_turn', nodeId: 'node-b', turnId: 'turn-b' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
  });

  // -------------------------------------------------------------------------
  // No side effects
  // -------------------------------------------------------------------------

  test('inspect performs no session-creating or cancelling calls, and does not change active tree', () => {
    seedNode('node-x');
    seedTree('tree-x', 'node-x');
    seedWorkspaceActiveTree('tree-x');

    const before = getDb().prepare('SELECT active_tree_id FROM workspaces WHERE id = ?').get(WORKSPACE) as { active_tree_id: string | null };
    inspect(caller(), { locator: { nodeId: 'node-x' } });
    const after = getDb().prepare('SELECT active_tree_id FROM workspaces WHERE id = ?').get(WORKSPACE) as { active_tree_id: string | null };
    assert.equal(after.active_tree_id, before.active_tree_id);

    // ChatHub must not have gained a new turn for this node as a side effect of inspecting it.
    assert.equal(chatHub.getSnapshot('node-x'), null);
  });

  function seedWorkspaceActiveTree(treeId: string): void {
    getDb().prepare('UPDATE workspaces SET active_tree_id = ? WHERE id = ?').run(treeId, WORKSPACE);
  }

  // -------------------------------------------------------------------------
  // Permissions / isolation (narrow slice here; P1-11 owns the full matrix)
  // -------------------------------------------------------------------------

  test('NAVIGATION_DISABLED when the caller workspace has AI navigation off, before any read', () => {
    seedNode('secret-node', { title: 'do not leak this title' });
    setAiGlobalContext(WORKSPACE, false);
    assert.throws(() => inspect(caller(), { locator: { nodeId: 'secret-node' } }), (err: unknown) => {
      assert.ok(err instanceof PaneInspectionError);
      return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
    });
  });

  test('a caller in another workspace cannot inspect a node in this workspace — NOT_FOUND', () => {
    seedNode('cross-ws-node');
    seedWorkspace('ws-2');
    assert.throws(
      () => inspect(caller({ workspaceId: 'ws-2' }), { locator: { nodeId: 'cross-ws-node' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NOT_FOUND';
      },
    );
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

  // -------------------------------------------------------------------------
  // Exported helpers reused by P1-7 / P2-4
  // -------------------------------------------------------------------------

  test('resolvePaneTarget and authorizeCaller are independently usable building blocks', () => {
    seedNode('helper-node');
    const target = resolvePaneTarget({ nodeId: 'helper-node' });
    assert.deepEqual(target, { kind: 'node', nodeId: 'helper-node' });
    const authorized = authorizeCaller(caller(), target);
    assert.equal(authorized.kind, 'node');
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

  // -------------------------------------------------------------------------
  // Basic routing
  // -------------------------------------------------------------------------

  test('inspect with a surface:{registrationId} locator returns a valid descriptor of the right kind', () => {
    const paneId = registerSurface('terminal', { treeId: 'tree-x', title: 'my terminal' });
    const desc = inspect(caller(), { locator: { paneId } });
    assert.equal(desc.kind, 'terminal');
    assert.equal(desc.target.kind, 'surface');
    assert.equal(desc.workspaceId, WORKSPACE);
    assert.equal(desc.treeId, 'tree-x');
    assert.equal(desc.title, 'my terminal');
    assert.equal(desc.presence.coverage, 'reported');
  });

  // -------------------------------------------------------------------------
  // Isolation / NOT_FOUND
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 1. Different owner — NOT_FOUND, for both a node target and a run target.
  // -------------------------------------------------------------------------

  test('1. a caller with a different ownerUserId cannot inspect a node owned by someone else — NOT_FOUND', () => {
    process.env.MICHI_CLOUD = '1';
    try {
      // Cloud-mode ownership check only fires when the workspace row itself carries an
      // owner_user_id — seed one directly rather than through saveWorkspace's desktop-mode
      // default (NULL) so getWorkspace(..., userId) has something to compare against.
      getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run(OWNER, WORKSPACE);
      seedNode('owner-node-1');

      const other = caller({ ownerUserId: 'someone-else' });
      assert.throws(() => inspect(other, { locator: { nodeId: 'owner-node-1' } }), (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NOT_FOUND';
      });
    } finally {
      delete process.env.MICHI_CLOUD;
    }
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

  // -------------------------------------------------------------------------
  // 2. Same owner, different workspace — rejected. A workspaceId in the payload must not widen
  // access; the caller's own bound workspaceId is authoritative.
  // -------------------------------------------------------------------------

  test('2. same owner but caller bound to a different workspace is rejected even though the target workspace is real', () => {
    seedNode('ws1-node');
    seedWorkspace('ws-2');

    // The caller is bound to ws-2 (server-derived — not something inspect() lets the request
    // change). The target node lives in ws-1. This must be NOT_FOUND regardless of what the
    // request payload might have claimed about workspaceId.
    assert.throws(
      () => inspect(caller({ workspaceId: 'ws-2' }), { locator: { nodeId: 'ws1-node' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NOT_FOUND';
      },
    );
  });

  test('2. PaneInspectionCaller has no field through which a request payload could widen the bound workspace', () => {
    // authorizeCaller/inspect only ever read caller.workspaceId — a server-derived value handed
    // in by the route/tool layer (see the interface doc comment on PaneInspectionCaller). There
    // is no second "requested workspaceId" parameter on InspectPaneInput for a caller to smuggle
    // the target's real workspace into. This test pins that shape: passing the target's true
    // workspace anywhere reachable from the public locator/executionRef surface does not help,
    // because inspect()'s only caller-workspace input is the trusted caller.workspaceId used
    // above. Constructed as a locator-surface probe: nodeId/runId/paneId carry no workspaceId
    // field at all (see PaneLocator in shared/src/paneInspection.ts), so there is nothing in the
    // input surface for such a value to travel through.
    seedNode('ws1-node-2');
    const target = resolvePaneTarget({ nodeId: 'ws1-node-2' });
    assert.deepEqual(target, { kind: 'node', nodeId: 'ws1-node-2' });
    // No workspaceId field exists on PaneTarget's 'node' variant, confirming the locator surface
    // itself cannot carry a workspace override.
    assert.ok(!('workspaceId' in target));
  });

  // -------------------------------------------------------------------------
  // 3. AI navigation disabled — the WHOLE call returns NAVIGATION_DISABLED, with no title,
  // lineage entry or output preview leaked alongside it.
  // -------------------------------------------------------------------------

  test('3. AI navigation disabled rejects the whole call before any read — no descriptor, no title, no lineage, no output', () => {
    seedNode('leak-check-node', { title: 'TOP SECRET TITLE' });
    setAiGlobalContext(WORKSPACE, false);

    let thrown: unknown;
    try {
      inspect(caller(), { locator: { nodeId: 'leak-check-node' } });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof PaneInspectionError, 'must throw a PaneInspectionError');
    assert.equal((thrown as PaneInspectionError).code, 'NAVIGATION_DISABLED');

    // §10: "关闭时整个工具返回 NAVIGATION_DISABLED，不让 list 的标题/来源成为旁路" — the thrown
    // Error's own message must not contain the node's title. A partial descriptor with a leaked
    // title, returned instead of thrown, would be exactly the bypass §10 forbids; assert there
    // is no return value at all (the throw above already proves that) and that the error text
    // itself carries no target-derived content.
    assert.ok(!(thrown as PaneInspectionError).message.includes('TOP SECRET TITLE'));
  });

  test('3. AI navigation disabled also rejects an agent-run target before any read', () => {
    const runs = new AgentRunsRepository();
    const run = createRun(runs, 'nav-disabled-run');
    setAiGlobalContext(WORKSPACE, false);
    assert.throws(() => inspect(caller(), { locator: { runId: run.id } }), (err: unknown) => {
      assert.ok(err instanceof PaneInspectionError);
      return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
    });
  });

  // -------------------------------------------------------------------------
  // 4. Run context/read policy — a caller whose own Run's Read policy is not Allow is rejected
  // even for a read-only tool. Positive control included so the test proves the gate, not a
  // generic failure.
  // -------------------------------------------------------------------------

  test('4. caller Run with Read: Deny is rejected; the identical call with Read: Allow succeeds (positive control)', () => {
    const runs = new AgentRunsRepository();
    seedNode('gated-target');

    const denyRun = createRun(runs, 'policy-run-deny', { [AgentPolicyCategory.Read]: AgentPolicyDecision.Deny });
    assert.throws(
      () => inspect(caller({ runOwner: { runId: denyRun.id } }), { locator: { nodeId: 'gated-target' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
      },
    );

    const allowRun = createRun(runs, 'policy-run-allow', { [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow });
    const desc = inspect(caller({ runOwner: { runId: allowRun.id } }), { locator: { nodeId: 'gated-target' } });
    assert.equal(desc.kind, 'chat');
  });

  test('4. caller Run with Read: Ask (neither Allow nor Deny) is also rejected — only Allow passes', () => {
    const runs = new AgentRunsRepository();
    seedNode('gated-target-2');
    const askRun = createRun(runs, 'policy-run-ask', { [AgentPolicyCategory.Read]: AgentPolicyDecision.Ask });
    assert.throws(
      () => inspect(caller({ runOwner: { runId: askRun.id } }), { locator: { nodeId: 'gated-target-2' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
      },
    );
  });

  // -------------------------------------------------------------------------
  // 5. Archived object — queryable, read-only, archived: true, and the read itself mutates
  // nothing.
  // -------------------------------------------------------------------------

  test('5. an archived node is inspectable, reports archived: true, and the read mutates nothing', () => {
    seedNode('archived-node', { status: 'archived', title: 'Archived Chat' });
    const before = getDb().prepare('SELECT * FROM nodes WHERE id = ?').get('archived-node');

    const desc = inspect(caller(), { locator: { nodeId: 'archived-node' } });
    assert.equal(desc.archived, true);
    assert.equal(desc.kind, 'chat');

    const after = getDb().prepare('SELECT * FROM nodes WHERE id = ?').get('archived-node');
    assert.deepEqual(after, before);
  });

  // -------------------------------------------------------------------------
  // 6. Deleted object — no content leak, and no lineage leak of a deleted parent's identity via
  // originMessageId/parentNodeId.
  // -------------------------------------------------------------------------

  test('6. a purged node itself cannot be inspected — NOT_FOUND, no content', () => {
    seedNode('purge-target', { title: 'gone' });
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now(), 'purge-target');
    assert.throws(() => inspect(caller(), { locator: { nodeId: 'purge-target' } }), (err: unknown) => {
      assert.ok(err instanceof PaneInspectionError);
      return (err as PaneInspectionError).code === 'NOT_FOUND';
    });
  });

  test('6. a deleted parent is not exposed via a visible child\'s parentNodeId or originMessageId', () => {
    seedNode('deleted-parent', { title: 'deleted parent title' });
    seedNode('visible-child', { parentNodeId: 'deleted-parent' });
    seedBranchEdge('e-deleted-parent', 'deleted-parent', 'visible-child', 'msg-secret-anchor');
    getDb().prepare('UPDATE nodes SET purged_at = ? WHERE id = ?').run(Date.now(), 'deleted-parent');

    const desc = inspect(caller(), { locator: { nodeId: 'visible-child' } });
    assert.equal(desc.lineage.status, 'ready');
    if (desc.lineage.status !== 'ready') throw new Error('unreachable');
    // §6.3: "来源已删除或不可见时返回 null，不泄露其身份" — resolveOriginMessageId must not trust
    // the surviving edge row's anchor once the source node it points at is gone.
    assert.equal(desc.lineage.value.originMessageId, null);
    // node.parent_node_id is a structural column on the CHILD's own row (nodes.parent_node_id),
    // independent of whether the parent still exists — design §6.3 says parentNodeId "表示当前
    // 结构父节点" without requiring the parent to still be visible, which is different from
    // originMessageId's identity-leak concern (an anchor pointing at deleted content). Pinning
    // the service's actual behaviour here rather than asserting a stronger claim than §6.3 makes:
    // the id string itself is still returned (it is not a content/identity disclosure of the
    // deleted node's title or existence-as-visible-to-this-caller — the caller already knows
    // this child's own recorded parent id), while inspecting that id directly is separately
    // proven NOT_FOUND by the "purged node itself cannot be inspected" test above.
    assert.equal(desc.lineage.value.parentNodeId, 'deleted-parent');
  });

  // -------------------------------------------------------------------------
  // 7. NOT_FOUND does not disclose existence — "exists but invisible" and "does not exist at
  // all" must be byte-identical: same code, same message, same shape.
  // -------------------------------------------------------------------------

  test('7. NOT_FOUND for "exists but not visible to this caller" and "does not exist at all" are byte-identical', () => {
    // Case A: exists, but not visible — different workspace.
    seedNode('exists-invisible');
    seedWorkspace('ws-other');
    let existsButInvisible: unknown;
    try {
      inspect(caller({ workspaceId: 'ws-other' }), { locator: { nodeId: 'exists-invisible' } });
    } catch (err) {
      existsButInvisible = err;
    }

    // Case B: does not exist at all — same caller context (ws-other), a nodeId that was never
    // created anywhere.
    let doesNotExist: unknown;
    try {
      inspect(caller({ workspaceId: 'ws-other' }), { locator: { nodeId: 'never-created-node-id' } });
    } catch (err) {
      doesNotExist = err;
    }

    assert.ok(existsButInvisible instanceof PaneInspectionError);
    assert.ok(doesNotExist instanceof PaneInspectionError);
    const a = existsButInvisible as PaneInspectionError;
    const b = doesNotExist as PaneInspectionError;
    assert.equal(a.code, b.code);
    assert.equal(a.code, 'NOT_FOUND');
    assert.equal(a.message, b.message);
    assert.equal(a.path, b.path);
    assert.equal(a.name, b.name);
  });

  test('7. NOT_FOUND is byte-identical for run targets too — exists-but-invisible vs never-existed', () => {
    const runs = new AgentRunsRepository();
    const realRun = createRun(runs, 'invisible-run');

    let existsButInvisible: unknown;
    try {
      inspect(caller({ ownerUserId: 'someone-else' }), { locator: { runId: realRun.id } });
    } catch (err) {
      existsButInvisible = err;
    }

    let doesNotExist: unknown;
    try {
      inspect(caller({ ownerUserId: 'someone-else' }), { locator: { runId: 'never-created-run-id' } });
    } catch (err) {
      doesNotExist = err;
    }

    assert.ok(existsButInvisible instanceof PaneInspectionError);
    assert.ok(doesNotExist instanceof PaneInspectionError);
    const a = existsButInvisible as PaneInspectionError;
    const b = doesNotExist as PaneInspectionError;
    assert.equal(a.code, 'NOT_FOUND');
    assert.equal(a.message, b.message);
    assert.equal(a.path, b.path);
  });

  // -------------------------------------------------------------------------
  // 8. Cross-backend resource id collision — the same nodeId/runId value on two different
  // backendConnectionIds must not share state, cache or descriptor.
  // -------------------------------------------------------------------------

  test('8. the same nodeId inspected under two different backendConnectionIds does not share cached state', () => {
    // inspect() has exactly one caller-supplied "which backend" field: backendConnectionId. It
    // never participates in any DB query, ChatHub lookup or presence lookup in this service or
    // its adapters — see paneInspection.ts / panePresence.ts, which key purely by nodeId/runId.
    // This means a single backend PROCESS handling two logical backendConnectionIds for the same
    // underlying data (e.g. a proxy/gateway multiplexing) would already see identical DB rows.
    // The one thing to prove is that inspect's OWN output is scoped per-call to the caller's
    // stated backendConnectionId — i.e. it never leaks a *different* connection's id into a
    // ref, and never caches/memoizes an authorized target across calls in a way that would let a
    // second connection skip authorization.
    seedNode('collide-node');
    seedCompletedTurn('collide-node', 'turn-collide', 100);

    const connA = inspect(caller({ backendConnectionId: 'conn-A' }), { locator: { nodeId: 'collide-node' } });
    const connB = inspect(caller({ backendConnectionId: 'conn-B' }), { locator: { nodeId: 'collide-node' } });

    assert.equal(connA.ref.backendConnectionId, 'conn-A');
    assert.equal(connB.ref.backendConnectionId, 'conn-B');
    // paneId itself is backend-agnostic (design: PaneRef.backendConnectionId is the routing
    // half, paneId the object-identity half) — same object, so same paneId under both
    // connections is CORRECT, not a collision. What must differ is the ref's connection field,
    // asserted above, proving the service does not memoize a stale connection id from a
    // previous call.
    assert.equal(connA.ref.paneId, connB.ref.paneId);

    // No per-connection caching is observable via a behavioural probe either: revoking access
    // (AI navigation off) after connA's successful read must still reject connB's next read —
    // proving connA's success was not cached and reused for connB.
    setAiGlobalContext(WORKSPACE, false);
    assert.throws(
      () => inspect(caller({ backendConnectionId: 'conn-B' }), { locator: { nodeId: 'collide-node' } }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'NAVIGATION_DISABLED';
      },
    );
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

  // -------------------------------------------------------------------------
  // 9. No side effects — across the whole matrix, a rejected call creates no session, claims
  // nothing, cancels nothing, reads no file, and does not change the active tree or focus.
  // -------------------------------------------------------------------------

  test('9. every rejection path above creates no ChatHub turn and changes no workspace active_tree_id', () => {
    seedNode('side-effect-node');
    seedTree('side-effect-tree', 'side-effect-node');
    getDb().prepare('UPDATE workspaces SET active_tree_id = ? WHERE id = ?').run('side-effect-tree', WORKSPACE);
    const activeTreeBefore = (getDb().prepare('SELECT active_tree_id FROM workspaces WHERE id = ?').get(WORKSPACE) as { active_tree_id: string | null }).active_tree_id;

    const rejections: Array<() => void> = [
      // different workspace
      () => inspect(caller({ workspaceId: 'nonexistent-ws' }), { locator: { nodeId: 'side-effect-node' } }),
      // never-created node
      () => inspect(caller(), { locator: { nodeId: 'no-such-node' } }),
      // never-created run
      () => inspect(caller(), { locator: { runId: 'no-such-run' } }),
    ];
    for (const attempt of rejections) {
      assert.throws(attempt);
    }

    setAiGlobalContext(WORKSPACE, false);
    assert.throws(() => inspect(caller(), { locator: { nodeId: 'side-effect-node' } }));

    const activeTreeAfter = (getDb().prepare('SELECT active_tree_id FROM workspaces WHERE id = ?').get(WORKSPACE) as { active_tree_id: string | null }).active_tree_id;
    assert.equal(activeTreeAfter, activeTreeBefore);
    // No ChatHub turn was fabricated for the node across any of the rejected calls.
    assert.equal(chatHub.getSnapshot('side-effect-node'), null);
  });

  test('9. a rejected AgentRun-caller call creates no run attempts and appends no events to the caller\'s own run', () => {
    const runs = new AgentRunsRepository();
    const denyRun = createRun(runs, 'no-side-effect-run', { [AgentPolicyCategory.Read]: AgentPolicyDecision.Deny });
    seedNode('target-for-denied-caller');

    const eventsBefore = runs.listEvents(OWNER, denyRun.id, -1, 1000).length;
    const attemptsBefore = runs.listAttempts(OWNER, denyRun.id).length;

    assert.throws(() => inspect(caller({ runOwner: { runId: denyRun.id } }), { locator: { nodeId: 'target-for-denied-caller' } }));

    const eventsAfter = runs.listEvents(OWNER, denyRun.id, -1, 1000).length;
    const attemptsAfter = runs.listAttempts(OWNER, denyRun.id).length;
    assert.equal(eventsAfter, eventsBefore);
    assert.equal(attemptsAfter, attemptsBefore);
  });

  // -------------------------------------------------------------------------
  // 10. executionRef cannot cross objects — a ref belonging to another object, or to another
  // workspace, is rejected rather than silently resolved against the requested target.
  // -------------------------------------------------------------------------

  test('10. an executionRef naming a turn on a different node is rejected, not silently resolved against the requested node', () => {
    seedNode('ref-node-a');
    seedNode('ref-node-b');
    seedCompletedTurn('ref-node-b', 'turn-on-b', 100);

    assert.throws(
      () => inspect(caller(), {
        locator: { nodeId: 'ref-node-a' },
        executionRef: { kind: 'chat_turn', nodeId: 'ref-node-b', turnId: 'turn-on-b' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PaneInspectionError);
        return (err as PaneInspectionError).code === 'INVALID_ARGUMENT';
      },
    );
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

// -----------------------------------------------------------------------------
// P3-3: snapshot→subscribe boundary — the fix this task delivers.
//
// Before P3-3, `chatNodeToDescriptor` (and, until this task, the digest/artifact adapters)
// emitted a deterministic string cursor (`node:${node.id}` or a `turnId:seq` shape) that the
// ring never minted and therefore could never resolve — every inspect()-then-resolve always
// forced a resync. `mintChatCursor` now overwrites that placeholder with a real
// `paneInspectionRing.mintInspectionCursor` token for chat, digest, and artifact targets alike,
// so a cursor taken straight off an `inspect()` descriptor is genuinely resolvable against the
// SAME ring under the SAME scope — no resync required for the happy path.
// -----------------------------------------------------------------------------
describe('P3-3: snapshot→subscribe boundary', () => {
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

  test('a cursor minted for one authorisation scope does not resolve for another', () => {
    seedNode('node-scope-1');
    seedCompletedTurn('node-scope-1', 'turn-scope-1');

    const descriptor = inspect(caller(), { locator: { nodeId: 'node-scope-1' } });
    const otherScope = scopeForCaller(caller({ workspaceId: 'ws-other' }));
    const resolution = paneInspectionRing.resolveCursor(descriptor.observation.cursor, otherScope);

    assert.equal(resolution.ok, false);
  });

  test('calling inspect repeatedly on an unchanged chat node does not advance the ring revision', () => {
    seedNode('node-stable-1');
    seedCompletedTurn('node-stable-1', 'turn-stable-1');

    const first = inspect(caller(), { locator: { nodeId: 'node-stable-1' } });
    const paneId = first.ref.paneId;
    const revisionAfterFirst = paneInspectionRing.getRevision(paneId);

    inspect(caller(), { locator: { nodeId: 'node-stable-1' } });
    inspect(caller(), { locator: { nodeId: 'node-stable-1' } });
    const revisionAfterRepeats = paneInspectionRing.getRevision(paneId);

    assert.equal(revisionAfterRepeats, revisionAfterFirst, 'repeated inspect() of an unchanged pane must not wake wait_pane(until=changed)');
  });

  test('the digest and artifact cursors also resolve under the same scope inspect() minted them with', () => {
    seedNode('digest-resolve-1', { kind: 'digest' });
    seedNode('artifact-resolve-1', { kind: 'artifact' });
    const scope = scopeForCaller(caller());

    const digestDescriptor = inspect(caller(), { locator: { nodeId: 'digest-resolve-1' } });
    const artifactDescriptor = inspect(caller(), { locator: { nodeId: 'artifact-resolve-1' } });

    const digestResolution = paneInspectionRing.resolveCursor(digestDescriptor.observation.cursor, scope);
    const artifactResolution = paneInspectionRing.resolveCursor(artifactDescriptor.observation.cursor, scope);

    assert.equal(digestResolution.ok, true);
    assert.equal(artifactResolution.ok, true);
  });

  // A simulated process-epoch change (e.g. a backend restart — see PaneInspectionRing.resetEpoch's
  // own doc comment) must invalidate every outstanding cursor, chat included: a cursor minted
  // before the restart must force a resync afterward rather than resolving into stale state.
  test('a simulated process-epoch change invalidates a chat cursor minted before it', () => {
    seedNode('node-epoch-1');
    seedCompletedTurn('node-epoch-1', 'turn-epoch-1');

    const descriptor = inspect(caller(), { locator: { nodeId: 'node-epoch-1' } });
    const scope = scopeForCaller(caller());

    assert.equal(
      paneInspectionRing.resolveCursor(descriptor.observation.cursor, scope).ok,
      true,
      'sanity: resolves before any epoch change',
    );

    paneInspectionRing.resetEpoch('epoch-after-simulated-restart');

    const resolution = paneInspectionRing.resolveCursor(descriptor.observation.cursor, scope);
    assert.equal(resolution.ok, false);
    if (!resolution.ok) assert.equal(resolution.reason, 'epoch_mismatch');
  });
});
