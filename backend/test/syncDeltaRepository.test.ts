/**
 * Tests for syncWorkspaceDelta — the INCREMENTAL delta sync path that
 * complements syncWorkspaceState (the full-snapshot reconcile).
 *
 * Delta contract: upsert the rows in `upserts.*`, apply the explicit
 * `deletes.*` id lists, and for each node in the RECONCILE SET reconcile that
 * node's messages (delete any DB message whose derived id is absent from the
 * delta's set for that node). Reconcile set = (nodes in upserts.messages) ∪
 * (messageReconcileNodeIds). A node in messageReconcileNodeIds but absent from
 * upserts.messages has an empty authority set → all its messages are wiped.
 * Absence from both sets means "unchanged". Nodes are never physically deleted
 * here (anti-revival).
 *
 * The key invariant under test is CONVERGENCE: applying a delta representing
 * one change yields the same DB state a full sync of the post-change snapshot
 * would produce.
 *
 * Same harness as syncReconcileRepository.test.ts: node:test with a fresh
 * MICHI_DATA_DIR per test, exercising the repository fn directly (no Express).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  syncWorkspaceState,
  syncWorkspaceDelta,
  listNodes, listEdges, listTrees, listContexts, listMessages,
  purgeWorkspaceNodes, deleteWorkspace,
  WorkspaceRow, TreeRow, NodeRow, EdgeRow, MessageRow, ContextRow,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-syncdelta-test-'));
}

function makeWorkspace(id: string, overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id, name: 'test', cwd: null, active_tree_id: null,
    created_at: 1, updated_at: 1, settings: null,
    deleted_at: null, archived_at: null,
    ...overrides,
  };
}

function makeTree(wsId: string, id: string, rootNodeId: string): TreeRow {
  return {
    id, workspace_id: wsId, root_node_id: rootNodeId,
    name: null, archived_at: null, pinned_at: null,
    last_active_at: 1, created_at: 1,
  };
}

function makeNode(wsId: string, id: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id, workspace_id: wsId,
    tree_id: null, parent_node_id: null,
    kind: 'chat', title: id, status: 'idle',
    position_x: null, position_y: null, minimized: 0,
    deleted_at: null, deletion_group_id: null,
    spawned_by_agent: 0, current_mode_id: null, pane_width: null,
    digest: null, follow_ups: null, acp_session_id: null,
    runtime_id: null, provider_id: null, model_id: null,
    reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null,
    created_at: 1,
    ...overrides,
  };
}

function makeEdge(wsId: string, id: string, source: string, target: string): EdgeRow {
  return {
    id, workspace_id: wsId,
    source_node_id: source, target_node_id: target, kind: 'branch',
  };
}

function makeMessage(nodeId: string, id: string, content = 'hi'): MessageRow {
  return {
    id, node_id: nodeId, role: 'user',
    content, blocks: null, tool_calls: null, seq: 0, created_at: 1,
  };
}

function makeContext(wsId: string, id: string): ContextRow {
  return {
    id, workspace_id: wsId, name: id, file_path: `/${id}`,
    size: null, auto_inject: 0, source: 'user',
    created_at: 1, updated_at: 1,
  };
}

function rawCount(table: string, where = ''): number {
  const sql = `SELECT COUNT(*) as cnt FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return (getDb().prepare(sql).get() as { cnt: number }).cnt;
}

describe('syncWorkspaceDelta', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Seed an initial workspace via the full path so deltas apply on top of real state.
  function seedFull(over: {
    trees?: TreeRow[]; nodes?: NodeRow[]; edges?: EdgeRow[];
    messages?: MessageRow[]; contexts?: ContextRow[];
  } = {}): WorkspaceRow {
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws,
      trees: over.trees ?? [],
      nodes: over.nodes ?? [],
      edges: over.edges ?? [],
      messages: over.messages ?? [],
      contexts: over.contexts ?? [],
    });
    return ws;
  }

  test('delta upsert adds a new node/edge/message without touching unrelated rows', () => {
    seedFull({
      nodes: [makeNode('ws1', 'n1')],
      edges: [],
      messages: [makeMessage('n1', 'm1')],
    });

    const ok = syncWorkspaceDelta('ws1', {
      upserts: {
        nodes: [makeNode('ws1', 'n2', { title: 'second' })],
        edges: [makeEdge('ws1', 'e1', 'n1', 'n2')],
        messages: [makeMessage('n2', 'm2')],
      },
    });

    assert.equal(ok.tombstoned, false);
    // New rows added.
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);
    assert.deepEqual(listEdges('ws1').map((e) => e.id).sort(), ['e1']);
    assert.deepEqual(listMessages('n2').map((m) => m.id), ['m2']);
    // Unrelated existing rows untouched (n1 + its message, not in the delta).
    assert.deepEqual(listMessages('n1').map((m) => m.id), ['m1']);
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'n1');
  });

  test('delta updates an existing node title (no duplicate)', () => {
    seedFull({ nodes: [makeNode('ws1', 'n1', { title: 'before' })] });

    syncWorkspaceDelta('ws1', {
      upserts: { nodes: [makeNode('ws1', 'n1', { title: 'after' })] },
    });

    const rows = listNodes('ws1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'after');
    assert.equal(rawCount('nodes', "id = 'n1'"), 1);
  });

  test('delta deletes.edges removes that edge; an unlisted edge is untouched', () => {
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2'), makeEdge('ws1', 'e2', 'n2', 'n1')],
    });

    syncWorkspaceDelta('ws1', { deletes: { edges: ['e1'] } });

    // e1 gone, e2 (neither listed for delete nor in upserts) untouched.
    assert.deepEqual(listEdges('ws1').map((e) => e.id).sort(), ['e2']);
  });

  test('delta deletes.trees removes that tree; an unlisted tree is untouched', () => {
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      trees: [makeTree('ws1', 't1', 'n1'), makeTree('ws1', 't2', 'n2')],
    });

    syncWorkspaceDelta('ws1', { deletes: { trees: ['t1'] } });

    assert.deepEqual(listTrees('ws1').map((t) => t.id).sort(), ['t2']);
  });

  test('delta deletes.contexts removes that context; an unlisted context is untouched', () => {
    seedFull({ contexts: [makeContext('ws1', 'c1'), makeContext('ws1', 'c2')] });

    syncWorkspaceDelta('ws1', { deletes: { contexts: ['c1'] } });

    assert.deepEqual(listContexts('ws1').map((c) => c.id).sort(), ['c2']);
  });

  test('delete is workspace-scoped: a delta cannot delete another workspace\'s row', () => {
    seedFull({ nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')], edges: [makeEdge('ws1', 'e1', 'n1', 'n2')] });
    // A second workspace with its own edge sharing nothing.
    const ws2 = makeWorkspace('ws2');
    syncWorkspaceState('ws2', {
      workspace: ws2, trees: [],
      nodes: [makeNode('ws2', 'x1'), makeNode('ws2', 'x2')],
      edges: [makeEdge('ws2', 'eX', 'x1', 'x2')], messages: [], contexts: [],
    });

    // Try to delete ws2's edge id via a delta against ws1.
    syncWorkspaceDelta('ws1', { deletes: { edges: ['eX'] } });

    // ws2's edge survives (workspace_id guard); ws1 unchanged.
    assert.deepEqual(listEdges('ws2').map((e) => e.id), ['eX']);
    assert.deepEqual(listEdges('ws1').map((e) => e.id), ['e1']);
  });

  test('per-node message reconcile: a node with 3 msgs, delta sends 2 → 3rd dropped; other node untouched', () => {
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      messages: [
        makeMessage('n1', 'm1'), makeMessage('n1', 'm2'), makeMessage('n1', 'm3'),
        makeMessage('n2', 'k1'), makeMessage('n2', 'k2'),
      ],
    });
    assert.deepEqual(listMessages('n1').map((m) => m.id).sort(), ['m1', 'm2', 'm3']);
    assert.deepEqual(listMessages('n2').map((m) => m.id).sort(), ['k1', 'k2']);

    // Delta carries only n1's messages, and only 2 of them.
    syncWorkspaceDelta('ws1', {
      upserts: { messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm2')] },
    });

    // n1's m3 reconciled away; m1/m2 remain.
    assert.deepEqual(listMessages('n1').map((m) => m.id).sort(), ['m1', 'm2']);
    assert.equal(rawCount('messages', "id = 'm3'"), 0);
    // n2 not mentioned in the delta → ALL its messages intact.
    assert.deepEqual(listMessages('n2').map((m) => m.id).sort(), ['k1', 'k2']);
  });

  test('a node not mentioned in the delta keeps all its messages and its row', () => {
    seedFull({
      nodes: [makeNode('ws1', 'a'), makeNode('ws1', 'b')],
      messages: [makeMessage('a', 'a1'), makeMessage('a', 'a2'), makeMessage('b', 'b1')],
    });

    // Delta only touches node 'a' via an unrelated title update — no messages array at all.
    syncWorkspaceDelta('ws1', { upserts: { nodes: [makeNode('ws1', 'a', { title: 'renamed' })] } });

    // 'b' fully intact (row + messages).
    assert.equal(rawCount('nodes', "id = 'b'"), 1);
    assert.deepEqual(listMessages('b').map((m) => m.id), ['b1']);
    // 'a' messages also intact — delta had no messages, so no per-node reconcile ran.
    assert.deepEqual(listMessages('a').map((m) => m.id).sort(), ['a1', 'a2']);
  });

  test('per-node reconcile is scoped to mentioned nodes: n1 trimmed to 1 msg, n2 untouched', () => {
    // Per-node reconcile only runs for nodes that appear in upserts.messages.
    // Here n1 is mentioned (and trimmed from 2 → 1), n2 is absent (untouched).
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm2'), makeMessage('n2', 'q1')],
    });

    syncWorkspaceDelta('ws1', { upserts: { messages: [makeMessage('n1', 'm1')] } });

    assert.deepEqual(listMessages('n1').map((m) => m.id), ['m1']);
    assert.deepEqual(listMessages('n2').map((m) => m.id), ['q1']);
  });

  test('anti-revival: delta upsert of a tombstoned node id no-ops (not revived)', () => {
    seedFull({ nodes: [makeNode('ws1', 'X')] });
    purgeWorkspaceNodes('ws1', ['X']);
    assert.equal(rawCount('nodes', "id = 'X' AND purged_at IS NOT NULL"), 1);

    // Stale client re-sends X (and a message for it) via a delta.
    const ok = syncWorkspaceDelta('ws1', {
      upserts: { nodes: [makeNode('ws1', 'X')], messages: [makeMessage('X', 'mx')] },
    });

    assert.equal(ok.tombstoned, false);
    // Still tombstoned, still hidden, message not written (saveMessage tombstone guard).
    assert.equal(rawCount('nodes', "id = 'X' AND purged_at IS NOT NULL"), 1);
    assert.equal(listNodes('ws1').length, 0);
    assert.equal(rawCount('messages', "id = 'mx'"), 0);
  });

  test('anti-revival: delta against a tombstoned WORKSPACE returns false / no-op', () => {
    seedFull({ nodes: [makeNode('ws1', 'n1')] });
    deleteWorkspace('ws1'); // tombstones workspace + cascades

    const ok = syncWorkspaceDelta('ws1', {
      workspace: makeWorkspace('ws1'),
      upserts: {
        trees: [makeTree('ws1', 't1', 'n1')],
        nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
        edges: [makeEdge('ws1', 'e1', 'n1', 'n2')],
        messages: [makeMessage('n1', 'm1')],
        contexts: [makeContext('ws1', 'c1')],
      },
    });

    assert.equal(ok.tombstoned, true);
    assert.equal(listNodes('ws1').length, 0);
    assert.equal(listEdges('ws1').length, 0);
    assert.equal(listTrees('ws1').length, 0);
    assert.equal(listContexts('ws1').length, 0);
    assert.equal(rawCount('workspaces', "id = 'ws1' AND purged_at IS NOT NULL"), 1);
  });

  test('delta never deletes nodes even when not mentioned (no nodes in deletes shape)', () => {
    seedFull({ nodes: [makeNode('ws1', 'keep'), makeNode('ws1', 'orphan')] });

    // A delta that only updates 'keep' must leave 'orphan' present (delta absence ≠ delete).
    syncWorkspaceDelta('ws1', { upserts: { nodes: [makeNode('ws1', 'keep', { title: 'updated' })] } });

    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['keep', 'orphan']);
  });

  test('messageReconcileNodeIds: node with zero remaining messages is wiped; other nodes untouched', () => {
    // This exercises the gap that a flat upserts.messages array cannot express:
    // node n1's messages have all been removed (trim-to-empty flow), so the
    // delta carries n1 in messageReconcileNodeIds with NO entries in
    // upserts.messages for n1.  n2 is not mentioned → untouched.
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      messages: [
        makeMessage('n1', 'gone1'), makeMessage('n1', 'gone2'),
        makeMessage('n2', 'keep1'), makeMessage('n2', 'keep2'),
      ],
    });

    const ok = syncWorkspaceDelta('ws1', {
      messageReconcileNodeIds: ['n1'],
      // upserts.messages intentionally absent — n1 now has zero messages.
    });

    assert.equal(ok.tombstoned, false);
    // n1's messages wiped by the empty-id-set branch.
    assert.deepEqual(listMessages('n1'), []);
    assert.equal(rawCount('messages', "id = 'gone1'"), 0);
    assert.equal(rawCount('messages', "id = 'gone2'"), 0);
    // n2 not in the reconcile set → fully intact.
    assert.deepEqual(listMessages('n2').map((m) => m.id).sort(), ['keep1', 'keep2']);
    // Nodes themselves untouched.
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);
  });

  test('messageReconcileNodeIds union: upserts.messages nodes + explicit zeros both reconciled', () => {
    // n1 has messages being updated (2 → 1 kept), n2 is going to zero.
    // n3 is not mentioned anywhere → completely untouched.
    seedFull({
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2'), makeNode('ws1', 'n3')],
      messages: [
        makeMessage('n1', 'a1'), makeMessage('n1', 'a2'),
        makeMessage('n2', 'b1'), makeMessage('n2', 'b2'),
        makeMessage('n3', 'c1'),
      ],
    });

    syncWorkspaceDelta('ws1', {
      upserts: { messages: [makeMessage('n1', 'a1')] }, // n1 keeps only a1
      messageReconcileNodeIds: ['n2'],                  // n2 → zero messages
    });

    assert.deepEqual(listMessages('n1').map((m) => m.id), ['a1']); // a2 gone
    assert.deepEqual(listMessages('n2'), []);                       // b1+b2 gone
    assert.deepEqual(listMessages('n3').map((m) => m.id), ['c1']); // untouched
  });

  test('CONVERGENCE with id-less messages: derived ids match between delta and full sync', () => {
    // The real client sends messages WITHOUT explicit ids; the backend derives
    // them as `${nodeId}-msg-${seq}` via normalizeIncomingMessageRow.
    // NOTE: backend fallback = `${nodeId}-msg-${seq}`;
    //       frontend hydration fallback = `${nodeId}-${seq}` (different format).
    //       Both are harmless today (explicit ids dominate) but must not be
    //       "unified" on one side without updating the other.
    //
    // State A: two nodes with id-less messages, seeded via full sync.
    const ws = makeWorkspace('ws1');
    const idlessN1: MessageRow[] = [
      { id: '', node_id: 'n1', role: 'user', content: 'msg-0', blocks: null, tool_calls: null, seq: 0, created_at: 1 },
      { id: '', node_id: 'n1', role: 'assistant', content: 'msg-1', blocks: null, tool_calls: null, seq: 1, created_at: 2 },
    ];
    const idlessN2: MessageRow[] = [
      { id: '', node_id: 'n2', role: 'user', content: 'msg-0', blocks: null, tool_calls: null, seq: 0, created_at: 1 },
    ];
    syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [], nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')], edges: [],
      messages: [...idlessN1, ...idlessN2], contexts: [],
    });
    // Backend derives: n1-msg-0, n1-msg-1, n2-msg-0
    assert.deepEqual(listMessages('n1').map((m) => m.id).sort(), ['n1-msg-0', 'n1-msg-1']);
    assert.deepEqual(listMessages('n2').map((m) => m.id), ['n2-msg-0']);

    // Delta: n1 sends only its first message (drop the second), n2 untouched.
    syncWorkspaceDelta('ws1', {
      upserts: {
        messages: [
          { id: '', node_id: 'n1', role: 'user', content: 'msg-0', blocks: null, tool_calls: null, seq: 0, created_at: 1 } as MessageRow,
        ],
      },
      messageReconcileNodeIds: ['n1'],
    });

    // n1-msg-1 reconciled away; n1-msg-0 still present; n2 untouched.
    assert.deepEqual(listMessages('n1').map((m) => m.id), ['n1-msg-0']);
    assert.equal(rawCount('messages', "id = 'n1-msg-1'"), 0);
    assert.deepEqual(listMessages('n2').map((m) => m.id), ['n2-msg-0']);

    // Convergence: a full sync of the post-change snapshot (ws2, disjoint ids)
    // must produce the same per-node message count.
    const ws2 = makeWorkspace('ws2');
    syncWorkspaceState('ws2', {
      workspace: ws2,
      trees: [], nodes: [makeNode('ws2', 'p1'), makeNode('ws2', 'p2')], edges: [],
      messages: [
        { id: '', node_id: 'p1', role: 'user', content: 'msg-0', blocks: null, tool_calls: null, seq: 0, created_at: 1 } as MessageRow,
        { id: '', node_id: 'p2', role: 'user', content: 'msg-0', blocks: null, tool_calls: null, seq: 0, created_at: 1 } as MessageRow,
      ],
      contexts: [],
    });
    assert.equal(listMessages('n1').length, listMessages('p1').length); // 1 each
    assert.equal(listMessages('n2').length, listMessages('p2').length); // 1 each
    assert.equal(listMessages('p1')[0].id, 'p1-msg-0');
    assert.equal(listMessages('p2')[0].id, 'p2-msg-0');
  });

  test('CONVERGENCE: delta of one change equals a full sync of the post-change snapshot', () => {
    // node/edge/message/context/tree ids are GLOBAL primary keys (see the row
    // interfaces), so ws1 and ws2 must use disjoint ids or saveNode's
    // ON CONFLICT(id) would yank a row across workspaces. We therefore build
    // the two paths with disjoint id namespaces and compare by STRUCTURE
    // (titles, counts, per-node message-set sizes) rather than raw ids.

    // --- State A in ws1 via full sync. ---
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [makeTree('ws1', 't1', 'n1')],
      nodes: [makeNode('ws1', 'n1', { title: 'one' }), makeNode('ws1', 'n2', { title: 'two' })],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2'), makeEdge('ws1', 'e2', 'n2', 'n1')],
      messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm2'), makeMessage('n2', 'k1')],
      contexts: [makeContext('ws1', 'c1'), makeContext('ws1', 'c2')],
    });

    // --- The change, applied as a DELTA on ws1: rename n1, add n3 + edge e3 to
    //     it, add msg m3 to n1 and drop m2, delete edge e2, delete context c2. ---
    syncWorkspaceDelta('ws1', {
      upserts: {
        nodes: [makeNode('ws1', 'n1', { title: 'one-renamed' }), makeNode('ws1', 'n3', { title: 'three' })],
        edges: [makeEdge('ws1', 'e3', 'n1', 'n3')],
        // n1's FULL message set post-change: m1 + new m3 (m2 dropped).
        messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm3')],
      },
      deletes: { edges: ['e2'], contexts: ['c2'] },
    });

    const deltaTitles = listNodes('ws1').map((n) => n.title).sort();
    const deltaEdgeCount = listEdges('ws1').length;
    const deltaTreeCount = listTrees('ws1').length;
    const deltaCtxCount = listContexts('ws1').length;
    const deltaMsgN1 = listMessages('n1').map((m) => m.id).sort();
    const deltaMsgN2 = listMessages('n2').map((m) => m.id).sort();
    const deltaMsgN3 = listMessages('n3').map((m) => m.id).sort();

    // --- Build the SAME post-change state from scratch via a FULL sync in ws2,
    //     using a DISJOINT id namespace (suffix 'b'). ---
    const ws2 = makeWorkspace('ws2');
    syncWorkspaceState('ws2', {
      workspace: ws2,
      trees: [makeTree('ws2', 't1b', 'n1b')],
      nodes: [
        makeNode('ws2', 'n1b', { title: 'one-renamed' }),
        makeNode('ws2', 'n2b', { title: 'two' }),
        makeNode('ws2', 'n3b', { title: 'three' }),
      ],
      edges: [makeEdge('ws2', 'e1b', 'n1b', 'n2b'), makeEdge('ws2', 'e3b', 'n1b', 'n3b')],
      messages: [makeMessage('n1b', 'm1b'), makeMessage('n1b', 'm3b'), makeMessage('n2b', 'k1b')],
      contexts: [makeContext('ws2', 'c1b')],
    });

    const fullTitles = listNodes('ws2').map((n) => n.title).sort();
    const fullEdgeCount = listEdges('ws2').length;
    const fullTreeCount = listTrees('ws2').length;
    const fullCtxCount = listContexts('ws2').length;
    const fullMsgN1 = listMessages('n1b').map((m) => m.id).sort();
    const fullMsgN2 = listMessages('n2b').map((m) => m.id).sort();
    const fullMsgN3 = listMessages('n3b').map((m) => m.id).sort();

    // Delta and full agree on the post-change STRUCTURE.
    assert.deepEqual(deltaTitles, fullTitles);
    assert.equal(deltaEdgeCount, fullEdgeCount);
    assert.equal(deltaTreeCount, fullTreeCount);
    assert.equal(deltaCtxCount, fullCtxCount);
    assert.equal(deltaMsgN1.length, fullMsgN1.length);
    assert.equal(deltaMsgN2.length, fullMsgN2.length);
    assert.equal(deltaMsgN3.length, fullMsgN3.length);

    // Concrete expected post-change values for the delta path.
    assert.deepEqual(deltaTitles, ['one-renamed', 'three', 'two']);
    assert.equal(deltaEdgeCount, 2); // e1 + e3 (e2 deleted)
    assert.equal(deltaCtxCount, 1);  // c1 (c2 deleted)
    assert.deepEqual(deltaMsgN1, ['m1', 'm3']); // m2 reconciled away
    assert.deepEqual(deltaMsgN2, ['k1']);       // n2 untouched
    assert.deepEqual(deltaMsgN3, []);           // n3 has no messages
  });
});
