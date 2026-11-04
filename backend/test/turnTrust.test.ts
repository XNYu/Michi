// Turn trust storage (services/turnTrust.ts, migration 0060): recording from a
// turn's runtime events in chatHub, queries during and after the turn, a
// reopened database, and cleanup with the node or workspace.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { mapAgentEvent, type MapperContext } from '../src/agents/pi/eventMapper';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  deleteWorkspace, emptyWorkspaceTrash, purgeWorkspaceNodes, saveNode, saveTree, saveWorkspace, softDeleteNode,
} from '../src/services/dbRepository';
import { activeTurnTrust, getTurnTrust, observeTurnTrust, recordUntrustedSource } from '../src/services/turnTrust';

/** A runtime turn's events; `hold` pauses before the event at that index until released. */
function scripted(events: NormalizedEvent[], hold?: number) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  async function* run(): AsyncIterableIterator<NormalizedEvent> {
    for (let index = 0; index < events.length; index += 1) {
      if (index === hold) {
        // The hub asked for this event, so it has handled every one before it.
        reached();
        await released;
      }
      yield events[index];
    }
  }
  return { run, paused, release };
}

function session(runtimeId: string, send: () => AsyncIterableIterator<NormalizedEvent>): AgentSession {
  return { id: 'chat-1', runtimeId, getHistory: () => [], getPendingAssistant: () => undefined, send, cancel: () => {} };
}

const tool = (toolCallId: string, toolName: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ kind: 'tool_call', toolCallId, title: toolName, status: 'in_progress', kindType: 'tool', toolName, ...extra }) as NormalizedEvent;
const done = (toolCallId: string): NormalizedEvent =>
  ({ kind: 'tool_call_update', toolCallId, title: '', status: 'completed', kindType: 'tool', output: 'ok' });

function rows(nodeId: string): Array<{ turn_id: string; tool: string }> {
  return (getDb().prepare('SELECT turn_id, tool FROM turn_trust WHERE node_id = ? ORDER BY rowid').all(nodeId) as Array<{ turn_id: string; tool: string }>)
    .map((row) => ({ turn_id: row.turn_id, tool: row.tool }));
}

function node(id: string, extra: Record<string, unknown> = {}): void {
  saveNode({
    id, workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: id === 'node-1' ? null : 'node-1',
    kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, ...extra,
  });
}

// The module remembers recorded sources per turn for the life of the process,
// so each test uses its own turn ids.
describe('turn trust', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-turn-trust-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' });
    saveTree({ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1', last_active_at: 1, created_at: 1 });
    node('node-1');
    node('node-2', { runtime_id: 'kiro' });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a turn that fetched a page is untrusted while it runs and after it ends', async () => {
    const script = scripted([
      tool('t1', 'Read'),
      done('t1'),
      tool('t2', 'WebFetch'),
      done('t2'),
      tool('t3', 'WebFetch'),
      { kind: 'chunk', text: 'answer' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ], 4);
    const hub = new ChatHub({ retentionMs: 50 });
    const started = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'go', session: session('claude', script.run), turnId: 'turn-fetch' });

    await script.paused;
    const running = activeTurnTrust('node-1');
    assert.deepEqual(running, { turnId: 'turn-fetch', untrusted: true, sources: [{ tool: 'WebFetch', runtimeId: 'claude' }] });
    script.release();
    await started.done;

    assert.equal(activeTurnTrust('node-1'), null, 'no running turn');
    assert.deepEqual(getTurnTrust({ nodeId: 'node-1', turnId: 'turn-fetch' }), {
      untrusted: true, sources: [{ tool: 'WebFetch', runtimeId: 'claude' }],
    });
    assert.deepEqual(rows('node-1'), [{ turn_id: 'turn-fetch', tool: 'WebFetch' }], 'one row per source, however often it ran');
  });

  test('a turn of file reads and Michi tools stays trusted', async () => {
    const script = scripted([
      tool('t1', 'Read'),
      tool('t2', 'set_branch_overview', { mcpServer: '__michi_internal__', hostTool: true }),
      tool('t3', 'apply_patch'),
      { kind: 'chunk', text: 'answer' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ], 3);
    const hub = new ChatHub({ retentionMs: 50 });
    const started = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'go', session: session('codex', script.run), turnId: 'turn-local' });
    await script.paused;
    assert.deepEqual(activeTurnTrust('node-1'), { turnId: 'turn-local', untrusted: false, sources: [] });
    script.release();
    await started.done;
    assert.deepEqual(getTurnTrust({ nodeId: 'node-1', turnId: 'turn-local' }), { untrusted: false, sources: [] });
    assert.deepEqual(rows('node-1'), []);
  });

  test("Pi's in-process tools reach the same path; a tool executor's own record joins them", async () => {
    const ctx: MapperContext = { cumulative: { inputTokens: 0, outputTokens: 0, totalCost: 0 }, runStartMs: 0 };
    const pi = (event: Record<string, unknown>) => [...mapAgentEvent(event, ctx)];
    const script = scripted([
      ...pi({ type: 'tool_execution_start', toolCallId: 'p1', toolName: 'read', args: { path: 'a.ts' } }),
      ...pi({ type: 'tool_execution_end', toolCallId: 'p1', toolName: 'read', result: 'x' }),
      ...pi({ type: 'tool_execution_start', toolCallId: 'p2', toolName: 'web_search', args: { query: 'news' } }),
      ...pi({ type: 'tool_execution_end', toolCallId: 'p2', toolName: 'web_search', result: 'x' }),
      ...pi({ type: 'tool_execution_start', toolCallId: 'p3', toolName: 'mcp__github__get_issue', args: {} }),
      ...pi({ type: 'tool_execution_start', toolCallId: 'p4', toolName: 'fetch_content', args: { url: 'https://example.com' } }),
      { kind: 'turn_end' },
    ], 6);
    const hub = new ChatHub({ retentionMs: 50 });
    const started = await hub.startTurn({ chatId: 'chat-1', nodeId: 'node-1', text: 'go', session: session('pi', script.run), turnId: 'turn-pi' });
    await script.paused;
    // What fetch_content's executor does: find the running turn of its chat and record what it read.
    const active = activeTurnTrust('node-1');
    assert.ok(active);
    recordUntrustedSource({ nodeId: 'node-1', turnId: active.turnId }, { tool: 'fetch_content', runtimeId: 'pi', detail: 'https://example.com/' });
    script.release();
    await started.done;
    assert.deepEqual(getTurnTrust({ nodeId: 'node-1', turnId: 'turn-pi' }).sources, [
      { tool: 'web_search', runtimeId: 'pi' },
      { tool: 'get_issue', runtimeId: 'pi', detail: 'mcp:github' },
      { tool: 'fetch_content', runtimeId: 'pi' },
      { tool: 'fetch_content', runtimeId: 'pi', detail: 'https://example.com/' },
    ]);
  });

  test("a turn the runtime starts on its own records too, under the node's runtime", async () => {
    const hub = new ChatHub({ retentionMs: 50 });
    async function* events(): AsyncIterableIterator<NormalizedEvent> {
      yield tool('t1', 'execute_bash');
      yield { kind: 'chunk', text: 'background result' };
      yield { kind: 'turn_end' };
    }
    hub.startSelfTurn({ chatId: 'chat-2', nodeId: 'node-2', events: events() });
    let turn: { turn_id: string; status: string } | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      turn = getDb().prepare('SELECT turn_id, status FROM turns WHERE node_id = ?').get('node-2') as typeof turn;
      if (turn && turn.status !== 'active') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(turn?.status, 'completed');
    assert.deepEqual(getTurnTrust({ nodeId: 'node-2', turnId: turn!.turn_id }).sources, [{ tool: 'execute_bash', runtimeId: 'kiro' }]);
  });

  test('a call without a name is judged by its kind and a web title; once named, by its name', () => {
    const ref = { nodeId: 'node-1', turnId: 'turn-k' };
    const acp = (toolCallId: string, title: string, kindType: string, toolName?: string): NormalizedEvent =>
      ({ kind: 'tool_call', toolCallId, title, status: 'pending', kindType, ...(toolName ? { toolName } : {}) });
    observeTurnTrust(ref, 'kiro', acp('a', 'Reading a.ts', 'read'));
    observeTurnTrust(ref, 'kiro', { kind: 'tool_call_update', toolCallId: 'a', title: '', status: 'completed', kindType: 'read' });
    observeTurnTrust(ref, 'kiro', acp('b', 'Searching files', 'search'));
    assert.deepEqual(getTurnTrust(ref).sources, []);
    observeTurnTrust(ref, 'kiro', acp('c', 'Open https://example.com', 'read'));
    observeTurnTrust(ref, 'kiro', acp('d', 'Something', 'other'));
    observeTurnTrust(ref, 'kiro', acp('g', 'Searching the web for news', 'search'));
    // Judged trusted by kind, then named by a later update.
    observeTurnTrust(ref, 'kiro', acp('e', 'Working', 'read'));
    observeTurnTrust(ref, 'kiro', { kind: 'tool_call_update', toolCallId: 'e', title: '', status: 'in_progress', kindType: 'read', toolName: 'web_fetch' });
    // A delta without name or ACP kind has nothing to judge.
    observeTurnTrust(ref, 'codex', { kind: 'tool_call_update', toolCallId: 'f', title: '', status: 'in_progress', kindType: 'bash', detail: 'x' });
    assert.deepEqual(getTurnTrust(ref).sources, [
      { tool: 'fetch', runtimeId: 'kiro', detail: 'Open https://example.com' },
      { tool: 'other', runtimeId: 'kiro', detail: 'Something' },
      { tool: 'fetch', runtimeId: 'kiro', detail: 'Searching the web for news' },
      { tool: 'web_fetch', runtimeId: 'kiro' },
    ]);
  });

  test("a subagent's untrusted tool counts for the turn that runs it", () => {
    const ref = { nodeId: 'node-1', turnId: 'turn-s' };
    const activity = (toolKind: string, extra: Record<string, unknown> = {}): NormalizedEvent =>
      ({ kind: 'subagent_tool_activity', subagentSessionId: 'sub-1', toolCallId: `c-${toolKind}`, title: toolKind, status: 'in_progress', toolKind, ...extra }) as NormalizedEvent;
    observeTurnTrust(ref, 'claude', activity('Read'));
    observeTurnTrust(ref, 'claude', activity('Grep'));
    observeTurnTrust(ref, 'claude', activity('WebFetch', { activityKind: 'message' }));
    assert.deepEqual(getTurnTrust(ref).sources, []);
    observeTurnTrust(ref, 'claude', activity('WebFetch'));
    assert.deepEqual(getTurnTrust(ref).sources, [{ tool: 'WebFetch', runtimeId: 'claude', detail: 'subagent:sub-1' }]);
  });

  test('sources survive a reopened database; turns stay apart', () => {
    recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-a' }, { tool: 'web_search', runtimeId: 'pi', detail: 'query' });
    recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-a' }, { tool: 'web_search', runtimeId: 'pi', detail: 'query' });
    recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-b' }, { tool: 'Bash', runtimeId: 'claude' });
    closeDb();
    initDb();
    assert.deepEqual(rows('node-1'), [{ turn_id: 'turn-a', tool: 'web_search' }, { turn_id: 'turn-b', tool: 'Bash' }]);
    assert.deepEqual(getTurnTrust({ nodeId: 'node-1', turnId: 'turn-a' }), {
      untrusted: true, sources: [{ tool: 'web_search', runtimeId: 'pi', detail: 'query' }],
    });
    assert.deepEqual(getTurnTrust({ nodeId: 'node-1', turnId: 'turn-c' }), { untrusted: false, sources: [] });
    assert.deepEqual(getTurnTrust({ nodeId: 'node-2', turnId: 'turn-a' }), { untrusted: false, sources: [] });
  });

  test('a turn keeps at most 50 sources; it stays untrusted', () => {
    for (let index = 0; index < 60; index += 1) {
      recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-many' }, { tool: 'WebFetch', runtimeId: 'claude', detail: `https://example.com/${index}` });
    }
    const trust = getTurnTrust({ nodeId: 'node-1', turnId: 'turn-many' });
    assert.equal(trust.untrusted, true);
    assert.equal(trust.sources.length, 50);
  });

  test('a source for a node that does not exist fails for an executor, and never for the hub', () => {
    assert.throws(() => recordUntrustedSource({ nodeId: 'missing', turnId: 't' }, { tool: 'WebFetch', runtimeId: 'claude' }), /FOREIGN KEY/);
    assert.throws(() => recordUntrustedSource({ nodeId: '', turnId: 't' }, { tool: 'WebFetch', runtimeId: 'claude' }), /nodeId/);
    assert.doesNotThrow(() => observeTurnTrust({ nodeId: 'missing-2', turnId: 't' }, 'claude', tool('x', 'WebFetch')));
    // This process still knows what it could not write.
    assert.equal(getTurnTrust({ nodeId: 'missing-2', turnId: 't' }).untrusted, true);
  });

  test('trash keeps sources; a purge deletes them with the messages', () => {
    recordUntrustedSource({ nodeId: 'node-2', turnId: 'turn-purge' }, { tool: 'WebFetch', runtimeId: 'claude' });
    recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-purge' }, { tool: 'WebFetch', runtimeId: 'claude' });
    softDeleteNode('node-2', Date.now(), 'group-1');
    assert.equal(rows('node-2').length, 1, 'a node in the trash can come back');
    assert.equal(emptyWorkspaceTrash('ws-1'), 1);
    assert.deepEqual(rows('node-2'), []);
    assert.equal(getTurnTrust({ nodeId: 'node-2', turnId: 'turn-purge' }).untrusted, false);
    assert.equal(rows('node-1').length, 1, 'other nodes keep theirs');
    purgeWorkspaceNodes('ws-1', ['node-1']);
    assert.deepEqual(rows('node-1'), []);
  });

  test('deleting the workspace deletes its sources', () => {
    recordUntrustedSource({ nodeId: 'node-1', turnId: 'turn-ws' }, { tool: 'Bash', runtimeId: 'claude' });
    recordUntrustedSource({ nodeId: 'node-2', turnId: 'turn-ws-2' }, { tool: 'Bash', runtimeId: 'claude' });
    deleteWorkspace('ws-1');
    assert.deepEqual(rows('node-1'), []);
    assert.deepEqual(rows('node-2'), []);
  });

  test('a hard-deleted node takes its sources along', () => {
    recordUntrustedSource({ nodeId: 'node-2', turnId: 'turn-hard' }, { tool: 'Bash', runtimeId: 'claude' });
    getDb().prepare('DELETE FROM nodes WHERE id = ?').run('node-2');
    assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM turn_trust').get() as { n: number }).n, 0);
  });
});
