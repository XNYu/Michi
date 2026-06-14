/**
 * Tests for syncWorkspaceState — the reconcile-based bulk sync path that
 * replaces the old "blind DELETE everything + reinsert" route logic.
 *
 * Reconcile contract: upsert every payload row, then delete only rows that
 * exist in the DB but are ABSENT from the payload. Happy-path results match
 * the wholesale-replace approach. Anti-revival invariants are preserved:
 * tombstoned (purged_at) nodes are never resurrected and never physically
 * deleted by reconcile, and a tombstoned workspace makes the whole sync a
 * no-op.
 *
 * Uses node:test (Node 22+ built-in) with a fresh MICHI_DATA_DIR per test so
 * each case starts from a freshly-migrated SQLite file. We exercise the
 * repository function directly (no Express) — the route is a thin wrapper.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDb, closeDb, getDb } from '../src/services/db';
import {
  syncWorkspaceState,
  saveWorkspace,
  listNodes, listEdges, listTrees, listContexts, listMessages,
  purgeWorkspaceNodes, deleteWorkspace, getWorkspace,
  WorkspaceRow, TreeRow, NodeRow, EdgeRow, MessageRow, ContextRow,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-sync-test-'));
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

describe('syncWorkspaceState reconcile', () => {
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

  test('happy path: inserts trees/nodes/edges/messages/contexts', () => {
    const ws = makeWorkspace('ws1');
    const trees = [makeTree('ws1', 't1', 'n1')];
    const nodes = [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')];
    const edges = [makeEdge('ws1', 'e1', 'n1', 'n2')];
    const messages = [makeMessage('n1', 'm1'), makeMessage('n2', 'm2')];
    const contexts = [makeContext('ws1', 'c1')];

    const ok = syncWorkspaceState('ws1', { workspace: ws, trees, nodes, edges, messages, contexts });

    assert.equal(ok.tombstoned, false);
    assert.deepEqual(listTrees('ws1').map((t) => t.id).sort(), ['t1']);
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);
    assert.deepEqual(listEdges('ws1').map((e) => e.id).sort(), ['e1']);
    assert.deepEqual(listContexts('ws1').map((c) => c.id).sort(), ['c1']);
    assert.deepEqual(listMessages('n1').map((m) => m.id), ['m1']);
    assert.deepEqual(listMessages('n2').map((m) => m.id), ['m2']);
  });

  test('update: changing a node title updates the row, no duplicate', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'n1', { title: 'before' })];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [], contexts: [] });

    const updated = [makeNode('ws1', 'n1', { title: 'after' })];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes: updated, edges: [], messages: [], contexts: [] });

    const rows = listNodes('ws1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'after');
    assert.equal(rawCount('nodes', "id = 'n1'"), 1);
  });

  test('remove edge: omitting an edge on the next sync deletes it', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')];
    const edges = [makeEdge('ws1', 'e1', 'n1', 'n2'), makeEdge('ws1', 'e2', 'n2', 'n1')];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges, messages: [], contexts: [] });
    assert.deepEqual(listEdges('ws1').map((e) => e.id).sort(), ['e1', 'e2']);

    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes,
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2')], messages: [], contexts: [],
    });

    assert.deepEqual(listEdges('ws1').map((e) => e.id).sort(), ['e1']);
  });

  test('remove tree: omitting a tree on the next sync deletes it', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')];
    const trees = [makeTree('ws1', 't1', 'n1'), makeTree('ws1', 't2', 'n2')];
    syncWorkspaceState('ws1', { workspace: ws, trees, nodes, edges: [], messages: [], contexts: [] });
    assert.deepEqual(listTrees('ws1').map((t) => t.id).sort(), ['t1', 't2']);

    syncWorkspaceState('ws1', {
      workspace: ws, trees: [makeTree('ws1', 't1', 'n1')],
      nodes, edges: [], messages: [], contexts: [],
    });

    assert.deepEqual(listTrees('ws1').map((t) => t.id).sort(), ['t1']);
  });

  test('remove context: omitting a context on the next sync deletes it', () => {
    const ws = makeWorkspace('ws1');
    const contexts = [makeContext('ws1', 'c1'), makeContext('ws1', 'c2')];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes: [], edges: [], messages: [], contexts });
    assert.deepEqual(listContexts('ws1').map((c) => c.id).sort(), ['c1', 'c2']);

    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [], edges: [], messages: [],
      contexts: [makeContext('ws1', 'c1')],
    });

    assert.deepEqual(listContexts('ws1').map((c) => c.id).sort(), ['c1']);
  });

  test('remove node: drops the node and its messages, sibling intact', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'keep'), makeNode('ws1', 'drop')];
    const messages = [
      makeMessage('keep', 'm-keep'),
      makeMessage('drop', 'm-drop'),
    ];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages, contexts: [] });
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['drop', 'keep']);

    // Second sync omits "drop" (and its message).
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'keep')],
      edges: [], messages: [makeMessage('keep', 'm-keep')], contexts: [],
    });

    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['keep']);
    assert.equal(rawCount('nodes', "id = 'drop'"), 0);
    assert.equal(listMessages('drop').length, 0);
    assert.equal(rawCount('messages', "id = 'm-drop'"), 0);
    // Sibling + its message intact.
    assert.deepEqual(listMessages('keep').map((m) => m.id), ['m-keep']);
  });

  test('message removed from a kept node: only that message goes', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'n1')];
    const messages = [
      makeMessage('n1', 'm1'),
      makeMessage('n1', 'm2'),
    ];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages, contexts: [] });
    assert.deepEqual(listMessages('n1').map((m) => m.id).sort(), ['m1', 'm2']);

    // Second sync keeps the node but drops m2.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes, edges: [],
      messages: [makeMessage('n1', 'm1')], contexts: [],
    });

    assert.deepEqual(listMessages('n1').map((m) => m.id), ['m1']);
    assert.equal(rawCount('messages', "id = 'm2'"), 0);
  });

  test('anti-revival: a purged (tombstoned) node is not resurrected nor deleted', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'live'), makeNode('ws1', 'doomed')];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [], contexts: [] });

    // Tombstone "doomed".
    const purged = purgeWorkspaceNodes('ws1', ['doomed']);
    assert.equal(purged, 1);
    assert.equal(rawCount('nodes', "id = 'doomed' AND purged_at IS NOT NULL"), 1);

    // A later sync that does NOT contain "doomed" must not error, must not
    // resurrect it, and must not physically reconcile-delete the tombstone.
    const ok = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'live')],
      edges: [], messages: [], contexts: [],
    });

    assert.equal(ok.tombstoned, false);
    // Still tombstoned, still hidden, still physically present.
    assert.equal(rawCount('nodes', "id = 'doomed' AND purged_at IS NOT NULL"), 1);
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['live']);
  });

  test('anti-revival: a sync payload containing a tombstoned id does not revive it', () => {
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'X')],
      edges: [], messages: [], contexts: [],
    });
    purgeWorkspaceNodes('ws1', ['X']);
    assert.equal(rawCount('nodes', "id = 'X' AND purged_at IS NOT NULL"), 1);

    // Stale tab re-sends X.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'X')],
      edges: [], messages: [], contexts: [],
    });

    assert.equal(rawCount('nodes', "id = 'X' AND purged_at IS NOT NULL"), 1);
    assert.equal(listNodes('ws1').length, 0);
  });

  test('workspace tombstoned: sync is a no-op and resurrects nothing', () => {
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1')],
      edges: [], messages: [], contexts: [],
    });

    deleteWorkspace('ws1'); // tombstones workspace + cascades

    // A late sync carrying a fresh snapshot.
    const ok = syncWorkspaceState('ws1', {
      workspace: ws, trees: [makeTree('ws1', 't1', 'n1')],
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2')],
      messages: [makeMessage('n1', 'm1')],
      contexts: [makeContext('ws1', 'c1')],
    });

    assert.equal(ok.tombstoned, true);
    assert.equal(listNodes('ws1').length, 0);
    assert.equal(listEdges('ws1').length, 0);
    assert.equal(listTrees('ws1').length, 0);
    assert.equal(listContexts('ws1').length, 0);
    assert.equal(rawCount('workspaces', "id = 'ws1' AND purged_at IS NOT NULL"), 1);
  });

  test('trashed node present in payload is kept (not deleted)', () => {
    const ws = makeWorkspace('ws1');
    // A soft-deleted (deleted_at) node that the snapshot still carries.
    const nodes = [
      makeNode('ws1', 'live'),
      makeNode('ws1', 'trashed', { deleted_at: 100, deletion_group_id: 'g1' }),
    ];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [], contexts: [] });

    // Re-sync with both still present.
    const ok = syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [], contexts: [] });

    assert.equal(ok.tombstoned, false);
    // listNodes includes trashed (deleted_at) nodes — only purged_at hides rows.
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['live', 'trashed']);
    assert.equal(rawCount('nodes', "id = 'trashed' AND deleted_at IS NOT NULL AND purged_at IS NULL"), 1);
  });

  test('id-less message: derived id is stable across two syncs, no duplicate or delete', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'n1')];
    // Message with no explicit id — normalizeIncomingMessageRow derives it as
    // `${nodeId}-msg-${seq}`, i.e. "n1-msg-0". Both passes must land on the
    // same derived id so reconcile sees 0 rows to delete on the second pass.
    const msgWithoutId = { node_id: 'n1', role: 'user', content: 'hello' } as unknown as MessageRow;

    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [msgWithoutId], contexts: [] });
    assert.equal(listMessages('n1').length, 1);
    assert.equal(listMessages('n1')[0].id, 'n1-msg-0');

    // Re-sync the exact same id-less payload — should update in place, not duplicate.
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages: [msgWithoutId], contexts: [] });

    assert.equal(listMessages('n1').length, 1);
    assert.equal(listMessages('n1')[0].id, 'n1-msg-0');
  });

  test('stale message in payload for a dropped node is cleaned up by node-reconcile', () => {
    const ws = makeWorkspace('ws1');
    const nodes = [makeNode('ws1', 'keep'), makeNode('ws1', 'drop')];
    const messages = [makeMessage('keep', 'm-keep'), makeMessage('drop', 'm-drop')];
    syncWorkspaceState('ws1', { workspace: ws, trees: [], nodes, edges: [], messages, contexts: [] });

    // Second sync: "drop" is absent from nodes, but its message is still in
    // the messages array (stale client snapshot). The node-reconcile block
    // must delete "drop" + its messages regardless of the upsert that briefly
    // ran for the stale message.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [],
      nodes: [makeNode('ws1', 'keep')],
      edges: [],
      messages: [makeMessage('keep', 'm-keep'), makeMessage('drop', 'm-drop')],
      contexts: [],
    });

    // The dropped node and ALL its messages must be gone.
    assert.equal(rawCount('nodes', "id = 'drop'"), 0);
    assert.equal(rawCount('messages', "id = 'm-drop'"), 0);
    assert.equal(rawCount('messages', "node_id = 'drop'"), 0);
    // Kept node and its message are intact.
    assert.deepEqual(listNodes('ws1').map((n) => n.id), ['keep']);
    assert.deepEqual(listMessages('keep').map((m) => m.id), ['m-keep']);
  });
});

/**
 * H2 — workspace-level freshness gate on reconcile-delete.
 *
 * The full-snapshot path's reconcile-delete removes any live DB row absent from
 * the payload. That is correct ONLY when the client has seen every prior change
 * to the workspace. A stale writer (e.g. a second window/device whose snapshot
 * predates a peer's just-added node) must NOT be allowed to delete-by-absence:
 * doing so physically destroys the peer's live row (unrecoverable — not a
 * tombstone). syncWorkspaceState now accepts `baseSyncRev` (the workspace
 * sync_rev the client last observed). When the stored sync_rev has advanced
 * past it, the client is stale → ALL by-absence reconcile-deletes are
 * suppressed for that sync. Upserts + explicit deletes still apply.
 *
 * Backward-compat: omitting baseSyncRev (or null) = "fresh" → unchanged
 * behavior (every other test in this file omits it and must stay green).
 */
describe('syncWorkspaceState freshness gate (H2)', () => {
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

  test('stale full-sync must NOT delete a peer-added live node by absence', () => {
    const ws = makeWorkspace('ws1');
    // Writer A's first sync establishes node n1 and captures the rev it saw.
    const r1 = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1')],
      edges: [], messages: [], contexts: [],
    });
    assert.equal(r1.tombstoned, false);
    const aBaseRev = (r1 as { newRev: number }).newRev;

    // Writer B adds a live node n2 (a later, independent sync). A never saw it.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [], messages: [], contexts: [],
    });
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);

    // Writer A's periodic full-sync self-heal fires with its STALE snapshot
    // (only n1) and its stale baseSyncRev. n2 must survive — A is not
    // authoritative to delete a row it has never seen.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1')],
      edges: [], messages: [], contexts: [],
      baseSyncRev: aBaseRev,
    });

    assert.deepEqual(
      listNodes('ws1').map((n) => n.id).sort(),
      ['n1', 'n2'],
      'peer-added live node n2 was silently deleted by a stale full-sync',
    );
  });

  test('stale full-sync must NOT delete a peer-added live edge by absence', () => {
    const ws = makeWorkspace('ws1');
    const r1 = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'a'), makeNode('ws1', 'b'), makeNode('ws1', 'c')],
      edges: [makeEdge('ws1', 'e1', 'a', 'b')], messages: [], contexts: [],
    });
    const aBaseRev = (r1 as { newRev: number }).newRev;

    // Peer adds edge e2.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'a'), makeNode('ws1', 'b'), makeNode('ws1', 'c')],
      edges: [makeEdge('ws1', 'e1', 'a', 'b'), makeEdge('ws1', 'e2', 'b', 'c')], messages: [], contexts: [],
    });

    // Stale A full-sync omits e2.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'a'), makeNode('ws1', 'b'), makeNode('ws1', 'c')],
      edges: [makeEdge('ws1', 'e1', 'a', 'b')], messages: [], contexts: [],
      baseSyncRev: aBaseRev,
    });

    assert.deepEqual(
      listEdges('ws1').map((e) => e.id).sort(), ['e1', 'e2'],
      'peer-added live edge e2 was silently deleted by a stale full-sync',
    );
  });

  test('FRESH full-sync still reconciles away a truly-removed row', () => {
    const ws = makeWorkspace('ws1');
    const r1 = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'keep'), makeNode('ws1', 'drop')],
      edges: [], messages: [], contexts: [],
    });
    // A is up to date: it re-reads the current workspace sync_rev as its base.
    const curRev = getWorkspace('ws1')!.sync_rev!;

    // Fresh sync (baseSyncRev == stored rev) legitimately omits 'drop' → it
    // must still be reconcile-deleted. The gate only suppresses STALE writers.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'keep')],
      edges: [], messages: [], contexts: [],
      baseSyncRev: curRev,
    });

    assert.deepEqual(
      listNodes('ws1').map((n) => n.id), ['keep'],
      'a fresh writer must still be able to delete-by-absence',
    );
    void r1;
  });
});
