/**
 * Stored ends of background subagents that no turn will report, against a
 * real SQLite database: one node's rosters when its agent process ends, and
 * the startup sweep after a restart.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDurableTurn,
  SUBAGENT_RESTARTED_ERROR,
  SUBAGENT_SESSION_ENDED_ERROR,
  type SubagentEnd,
  type SubagentInfo,
} from 'michi-shared';
import { closeDb, getDb, initDb, isDbOpen } from '../src/services/db';
import { beginTurn, checkpointTurn, finalizeTurn, listMessages, saveMessage, saveNode, saveTree, saveWorkspace } from '../src/services/dbRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import {
  BACKGROUND_ROSTERS_SINCE_MS,
  BACKGROUND_SWEEP_MARGIN_MS,
  BACKGROUND_SWEEP_META_KEY,
  endNodeBackgroundSubagents,
  endOrphanedBackgroundSubagents,
} from '../src/services/backgroundSubagentEndsRepository';

function seedNode(nodeId: string, workspaceId = 'ws-1', ownerUserId: string | null = null): void {
  saveWorkspace({
    id: workspaceId, name: 'Workspace', created_at: 1, updated_at: 1,
    active_tree_id: `tree-${workspaceId}`, cwd: null, settings: null, owner_user_id: ownerUserId,
  } as Parameters<typeof saveWorkspace>[0]);
  saveTree({
    id: `tree-${workspaceId}`, workspace_id: workspaceId, root_node_id: nodeId,
    name: null, archived_at: null, pinned_at: null, last_active_at: 1, created_at: 1,
  });
  saveNode({
    id: nodeId, workspace_id: workspaceId, tree_id: `tree-${workspaceId}`, parent_node_id: null,
    kind: 'chat', title: null, branch_overview: null, status: 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null,
    follow_ups_source_message_id: null, acp_session_id: null, runtime_id: null,
    provider_id: null, model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  });
}

function agent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return {
    sessionName: 'Run the suite', agentName: 'Explore', initialQuery: 'Run the suite',
    status: 'terminated', group: '', dependsOn: [], source: 'claude', startedAt: 10, endedAt: 20,
    ...patch,
  };
}

function saveAssistant(id: string, nodeId: string, seq: number, metadata: unknown): void {
  saveMessage({
    id, node_id: nodeId, role: 'assistant', content: 'ok', seq, created_at: seq,
    metadata: metadata === null ? null : typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
  });
}

function rosterOf(messageId: string): SubagentInfo[] | undefined {
  const row = getDb().prepare('SELECT metadata FROM messages WHERE id = ?').get(messageId) as { metadata: string | null } | undefined;
  return row?.metadata ? JSON.parse(row.metadata).subagents : undefined;
}

function rawMetadata(messageId: string): string | null {
  return (getDb().prepare('SELECT metadata FROM messages WHERE id = ?').get(messageId) as { metadata: string | null }).metadata;
}

const STOPPED: SubagentEnd = { sessionId: 'toolu_bg', outcome: 'cancelled', endedAt: 500, error: SUBAGENT_SESSION_ENDED_ERROR };

describe('background subagent ends repository', () => {
  let tmpDir: string;
  let previousCloud: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-bg-ends-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    previousCloud = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD;
    else process.env.MICHI_CLOUD = previousCloud;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('ends every waiting copy of the agent in the node, leaves the rest of each row as it was, and is idempotent', () => {
    seedNode('node-1');
    const launch = agent({ sessionId: 'toolu_bg', background: true, activity: [{ id: 'a1', kind: 'tool', title: 'Read a.ts', status: 'completed', startedAt: 11, endedAt: 12 }] });
    const foreground = agent({ sessionId: 'toolu_fg', outcome: 'completed', result: 'done' });
    saveAssistant('a-launch', 'node-1', 1, { plan: [{ content: 'step', status: 'completed' }], subagents: [launch, foreground] });
    // A later turn carried it (still running then) next to another finished background agent.
    const carried = agent({ sessionId: 'toolu_bg', background: true, status: 'working', currentTool: 'Bash: npm test',
      activity: [{ id: 'a2', kind: 'tool', title: 'Bash: npm test', status: 'in_progress', startedAt: 30 }] });
    const finished = agent({ sessionId: 'toolu_done', background: true, outcome: 'completed', result: 'all green' });
    saveAssistant('a-carry', 'node-1', 3, { subagents: [carried, finished] });
    saveAssistant('a-plain', 'node-1', 5, { plan: [{ content: 'x', status: 'pending' }] });
    saveMessage({ id: 'u-1', node_id: 'node-1', role: 'user', content: '"background":true', seq: 0, created_at: 0 });
    const plainBefore = rawMetadata('a-plain');

    const first = endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [STOPPED]);
    assert.deepEqual(first, { workspaceId: 'ws-1', messageIds: ['a-launch', 'a-carry'] });

    const launchRow = JSON.parse(rawMetadata('a-launch')!);
    assert.deepEqual(launchRow.plan, [{ content: 'step', status: 'completed' }], 'other metadata is kept');
    assert.deepEqual(launchRow.subagents, [
      { ...launch, outcome: 'cancelled', endedAt: 500, error: SUBAGENT_SESSION_ENDED_ERROR },
      foreground,
    ]);
    const [carriedAfter, finishedAfter] = rosterOf('a-carry')!;
    assert.equal(carriedAfter.status, 'terminated');
    assert.equal(carriedAfter.outcome, 'cancelled');
    assert.equal(carriedAfter.currentTool, undefined);
    assert.deepEqual(carriedAfter.activity, [{ id: 'a2', kind: 'tool', title: 'Bash: npm test', status: 'interrupted', startedAt: 30, endedAt: 500 }]);
    assert.deepEqual(finishedAfter, finished, 'an agent with an outcome is final');
    assert.equal(rawMetadata('a-plain'), plainBefore);

    const launchAfter = rawMetadata('a-launch');
    const second = endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [{ ...STOPPED, endedAt: 900, error: 'later' }]);
    assert.deepEqual(second, { workspaceId: 'ws-1', messageIds: [] }, 'already ended: nothing changes');
    assert.equal(rawMetadata('a-launch'), launchAfter);
  });

  test('a known outcome (finished while idle) is recorded with its result', () => {
    seedNode('node-1');
    saveAssistant('a-launch', 'node-1', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [
      { sessionId: 'toolu_bg', outcome: 'completed', endedAt: 400, result: 'PROBE_MARKER', usage: { totalTokens: 9 } },
    ]);
    const [entry] = rosterOf('a-launch')!;
    assert.equal(entry.outcome, 'completed');
    assert.equal(entry.result, 'PROBE_MARKER');
    assert.equal(entry.endedAt, 400);
    assert.deepEqual(entry.usage, { totalTokens: 9 });
    assert.equal(entry.error, undefined);
  });

  test('is scoped to the node: the same agent id in another node is left alone', () => {
    seedNode('node-1');
    seedNode('node-2', 'ws-2');
    saveAssistant('a-1', 'node-1', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    saveAssistant('a-2', 'node-2', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    const before = rawMetadata('a-2');
    endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [STOPPED]);
    assert.equal(rosterOf('a-1')![0].outcome, 'cancelled');
    assert.equal(rawMetadata('a-2'), before);
  });

  test('another owner\'s node, a purged node or a missing node is not touched', () => {
    process.env.MICHI_CLOUD = '1';
    seedNode('node-b', 'ws-b', 'user-b');
    saveAssistant('a-b', 'node-b', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    const before = rawMetadata('a-b');
    assert.equal(endNodeBackgroundSubagents('user-a', 'node-b', [STOPPED]), null);
    assert.equal(endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-b', [STOPPED]), null, 'the local user is not user-b');
    assert.equal(rawMetadata('a-b'), before);
    assert.deepEqual(endNodeBackgroundSubagents('user-b', 'node-b', [STOPPED]), { workspaceId: 'ws-b', messageIds: ['a-b'] });

    delete process.env.MICHI_CLOUD;
    seedNode('node-purged', 'ws-p');
    saveAssistant('a-p', 'node-purged', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    getDb().prepare('UPDATE nodes SET purged_at = 1 WHERE id = ?').run('node-purged');
    const purgedBefore = rawMetadata('a-p');
    assert.equal(endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-purged', [STOPPED]), null);
    assert.equal(rawMetadata('a-p'), purgedBefore);
    assert.equal(endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-missing', [STOPPED]), null);
  });

  test('a row with unreadable metadata is skipped; the others still change', () => {
    seedNode('node-1');
    saveAssistant('a-bad', 'node-1', 1, '{"subagents":[{"background":true,');
    saveAssistant('a-odd', 'node-1', 2, { subagents: [null, 'x', { background: true }, agent({ sessionId: 'toolu_bg', background: true })] });
    const result = endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [STOPPED]);
    assert.deepEqual(result?.messageIds, ['a-odd']);
    assert.equal(rawMetadata('a-bad'), '{"subagents":[{"background":true,');
    const odd = rosterOf('a-odd')!;
    assert.deepEqual(odd.slice(0, 3), [null, 'x', { background: true }], 'malformed entries are written back as they were');
    assert.equal(odd[3].outcome, 'cancelled');
  });

  test('a closed database is not reopened', () => {
    seedNode('node-1');
    closeDb();
    assert.equal(endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [STOPPED]), null);
    assert.deepEqual(endOrphanedBackgroundSubagents(), { messages: 0, subagents: 0 });
    assert.equal(isDbOpen(), false);
    initDb();
  });

  /** A turn row for an assistant message (rosters are written by turns). */
  function turnFor(assistantId: string, nodeId: string, status: string, updatedAt: number): void {
    getDb().prepare(`INSERT INTO turns (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, started_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, 0, ?, ?)`).run(`t-${assistantId}`, nodeId, assistantId, status, updatedAt, updatedAt);
  }

  const NOW = BACKGROUND_ROSTERS_SINCE_MS + 30 * 24 * 60 * 60_000;

  test('startup ends Claude and Codex background agents still waiting, with no end time, once', () => {
    seedNode('node-1');
    seedNode('node-2', 'ws-2');
    const recent = NOW - 60_000;
    saveAssistant('a-claude', 'node-1', 1, { subagents: [
      agent({ sessionId: 'toolu_bg', background: true }),
      agent({ sessionId: 'toolu_fg', status: 'working' }),
      agent({ sessionId: 'toolu_ok', background: true, outcome: 'completed', result: 'r' }),
    ] });
    turnFor('a-claude', 'node-1', 'completed', recent);
    // An interrupted turn's last checkpoint: still `working` (recovery marked the turn error).
    saveAssistant('a-codex', 'node-2', 1, { subagents: [agent({ sessionId: 'child-1', source: 'codex', background: true, status: 'working', endedAt: undefined })] });
    turnFor('a-codex', 'node-2', 'error', recent);
    // Kiro and Crew never mark an agent background; one that did is not this sweep's.
    saveAssistant('a-kiro', 'node-2', 2, { subagents: [agent({ sessionId: 'kiro-1', source: 'kiro', background: true })] });
    turnFor('a-kiro', 'node-2', 'completed', recent);
    const kiroBefore = rawMetadata('a-kiro');
    // A turn still active (kept for Agent Run delivery) owns its row.
    const turn = createDurableTurn({ turnId: 't-active', assistantId: 'a-active', nodeId: 'node-1', workspaceId: 'ws-1', displayUserText: 'go', startedAt: 1 });
    beginTurn(turn);
    saveAssistant('a-active', 'node-1', 9, { subagents: [agent({ sessionId: 'toolu_live', background: true })] });
    const activeBefore = rawMetadata('a-active');
    // Older than any build that wrote background rosters: not read.
    saveAssistant('a-old', 'node-1', 3, { subagents: [agent({ sessionId: 'toolu_old', background: true })] });
    turnFor('a-old', 'node-1', 'completed', BACKGROUND_ROSTERS_SINCE_MS - 1);
    // No turn (an imported row): not read.
    saveAssistant('a-imported', 'node-1', 4, { subagents: [agent({ sessionId: 'toolu_imported', background: true })] });
    const untouched = ['a-old', 'a-imported'].map(rawMetadata);

    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW), { messages: 2, subagents: 2 });
    const [claudeBg, fg, ok] = rosterOf('a-claude')!;
    assert.equal(claudeBg.outcome, 'cancelled');
    assert.equal(claudeBg.status, 'terminated');
    assert.equal(claudeBg.error, SUBAGENT_RESTARTED_ERROR);
    assert.equal(claudeBg.endedAt, undefined, 'when it ended is unknown');
    assert.equal(fg.status, 'working', 'foreground entries are not this sweep\'s');
    assert.equal(fg.outcome, undefined);
    assert.equal(ok.outcome, 'completed');
    const [codexChild] = rosterOf('a-codex')!;
    assert.equal(codexChild.status, 'terminated');
    assert.equal(codexChild.outcome, 'cancelled');
    assert.equal(rawMetadata('a-kiro'), kiroBefore);
    assert.equal(rawMetadata('a-active'), activeBefore);
    assert.deepEqual(['a-old', 'a-imported'].map(rawMetadata), untouched);
    const swept = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(BACKGROUND_SWEEP_META_KEY) as { value: string };
    assert.equal(swept.value, String(NOW), 'the sweep remembers when it ran');

    const claudeAfter = rawMetadata('a-claude');
    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW + 1_000), { messages: 0, subagents: 0 }, 'a second startup finds nothing');
    assert.equal(rawMetadata('a-claude'), claudeAfter);
    assert.equal(listMessages('node-1').length, 5, 'no rows added or removed');
  });

  test('a later startup reads only turns updated since the last sweep, less the margin', () => {
    seedNode('node-1');
    getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(BACKGROUND_SWEEP_META_KEY, String(NOW));
    saveAssistant('a-before', 'node-1', 1, { subagents: [agent({ sessionId: 'toolu_a', background: true })] });
    turnFor('a-before', 'node-1', 'completed', NOW - BACKGROUND_SWEEP_MARGIN_MS - 1);
    saveAssistant('a-margin', 'node-1', 2, { subagents: [agent({ sessionId: 'toolu_b', background: true })] });
    turnFor('a-margin', 'node-1', 'completed', NOW - BACKGROUND_SWEEP_MARGIN_MS + 1);
    saveAssistant('a-since', 'node-1', 3, { subagents: [agent({ sessionId: 'toolu_c', background: true })] });
    turnFor('a-since', 'node-1', 'completed', NOW + 5_000);
    const before = rawMetadata('a-before');

    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW + 10_000), { messages: 2, subagents: 2 });
    assert.equal(rawMetadata('a-before'), before, 'swept by an earlier startup already');
    assert.equal(rosterOf('a-margin')![0].outcome, 'cancelled');
    assert.equal(rosterOf('a-since')![0].outcome, 'cancelled');
  });

  test('an unreadable watermark falls back to the first-sweep floor', () => {
    seedNode('node-1');
    getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(BACKGROUND_SWEEP_META_KEY, 'soon');
    saveAssistant('a-1', 'node-1', 1, { subagents: [agent({ sessionId: 'toolu_a', background: true })] });
    turnFor('a-1', 'node-1', 'completed', BACKGROUND_ROSTERS_SINCE_MS + 1);
    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW), { messages: 1, subagents: 1 });
  });

  test('startup gives an agent that reported back in a later turn that outcome, not "restarted"', () => {
    seedNode('node-1');
    // Normal Claude path: the launch copy stays pending; the CLI's own turn carries the outcome.
    saveAssistant('a-launch', 'node-1', 1, { subagents: [
      agent({ sessionId: 'toolu_bg', background: true }),
      agent({ sessionId: 'toolu_lost', background: true }),
    ] });
    turnFor('a-launch', 'node-1', 'completed', NOW - 5_000);
    saveAssistant('a-between', 'node-1', 2, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    turnFor('a-between', 'node-1', 'completed', NOW - 4_000);
    saveAssistant('self-1', 'node-1', 3, { subagents: [agent({
      sessionId: 'toolu_bg', background: true, outcome: 'completed', result: 'PROBE_MARKER', endedAt: NOW - 3_000,
      usage: { totalTokens: 12, toolUses: 3 },
    })] });
    turnFor('self-1', 'node-1', 'completed', NOW - 3_000);
    const reportBefore = rawMetadata('self-1');

    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW), { messages: 2, subagents: 3 });
    for (const id of ['a-launch', 'a-between']) {
      const copy = rosterOf(id)!.find((entry) => entry.sessionId === 'toolu_bg')!;
      assert.equal(copy.outcome, 'completed', `${id} takes the reported outcome`);
      assert.equal(copy.result, 'PROBE_MARKER');
      assert.equal(copy.endedAt, NOW - 3_000);
      assert.equal(copy.error, undefined);
      assert.deepEqual(copy.usage, { totalTokens: 12, toolUses: 3 });
    }
    const lost = rosterOf('a-launch')!.find((entry) => entry.sessionId === 'toolu_lost')!;
    assert.equal(lost.outcome, 'cancelled', 'an agent that never reported was cut off by the restart');
    assert.equal(lost.error, SUBAGENT_RESTARTED_ERROR);
    assert.equal(rawMetadata('self-1'), reportBefore, 'the report itself is left as it was');
  });

  test('startup finds a reported outcome on a row outside the window', () => {
    seedNode('node-1');
    getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(BACKGROUND_SWEEP_META_KEY, String(NOW));
    // The report has no turn row (imported); the pending copy's turn is in the window.
    saveAssistant('a-report', 'node-1', 1, { subagents: [agent({ sessionId: 'toolu_bg', background: true, outcome: 'failed', error: 'boom', endedAt: 99 })] });
    saveAssistant('a-pending', 'node-1', 2, { subagents: [agent({ sessionId: 'toolu_bg', background: true })] });
    turnFor('a-pending', 'node-1', 'completed', NOW + 5_000);

    assert.deepEqual(endOrphanedBackgroundSubagents(SUBAGENT_RESTARTED_ERROR, NOW + 10_000), { messages: 1, subagents: 1 });
    const [copy] = rosterOf('a-pending')!;
    assert.equal(copy.outcome, 'failed');
    assert.equal(copy.error, 'boom');
    assert.equal(copy.endedAt, 99);
  });

  test('an end recorded on an open turn\'s row survives that turn\'s checkpoint and finalize', () => {
    seedNode('node-1');
    // Stop in the launch turn: the only copy is in the open turn's message.
    const snapshot = createDurableTurn({ turnId: 't-1', assistantId: 'a-1', nodeId: 'node-1', workspaceId: 'ws-1', displayUserText: 'go', startedAt: 1 });
    beginTurn(snapshot);
    snapshot.assistantMessage.subagents = [agent({ sessionId: 'toolu_bg', background: true, status: 'working', endedAt: undefined })];
    snapshot.lastAppliedSeq = 3;
    checkpointTurn(snapshot);
    assert.equal(rosterOf('a-1')![0].outcome, undefined, 'checkpointed pending copy');

    // ClaudeSession.retireProcess -> registry end recorder.
    assert.deepEqual(endNodeBackgroundSubagents(LOCAL_AGENT_OWNER_ID, 'node-1', [STOPPED])?.messageIds, ['a-1']);

    // A checkpoint, then the synthetic turn_end, from the projection that never heard of the end.
    snapshot.lastAppliedSeq = 4;
    checkpointTurn(snapshot);
    assert.equal(rosterOf('a-1')![0].outcome, 'cancelled', 'kept by the checkpoint');
    snapshot.assistantMessage.subagents = [agent({ sessionId: 'toolu_bg', background: true, status: 'terminated' })];
    snapshot.status = 'cancelled';
    snapshot.lastAppliedSeq = 5;
    finalizeTurn(snapshot);
    const [copy] = rosterOf('a-1')!;
    assert.equal(copy.outcome, 'cancelled', 'kept by finalize');
    assert.equal(copy.error, SUBAGENT_SESSION_ENDED_ERROR);
    assert.equal(copy.endedAt, 500);
  });

  test('a turn\'s own outcome for its copy is written as the turn has it', () => {
    seedNode('node-1');
    const snapshot = createDurableTurn({ turnId: 't-1', assistantId: 'a-1', nodeId: 'node-1', workspaceId: 'ws-1', displayUserText: 'go', startedAt: 1 });
    beginTurn(snapshot);
    snapshot.assistantMessage.subagents = [agent({ sessionId: 'toolu_bg', background: true, status: 'working', endedAt: undefined })];
    snapshot.lastAppliedSeq = 3;
    checkpointTurn(snapshot);
    snapshot.assistantMessage.subagents = [agent({ sessionId: 'toolu_bg', background: true, outcome: 'completed', result: 'done', endedAt: 40 })];
    snapshot.status = 'completed';
    snapshot.lastAppliedSeq = 4;
    finalizeTurn(snapshot);
    const [copy] = rosterOf('a-1')!;
    assert.equal(copy.outcome, 'completed');
    assert.equal(copy.result, 'done');
  });
});
