/**
 * Tests for the sync L2.2 conflict guard: server-authoritative `sync_rev`
 * bump + per-row `accepts` guard wired into syncWorkspaceState (full) and
 * syncWorkspaceDelta (delta).
 *
 * Guard contract:
 *   - Each sync txn bumps the workspace's `sync_rev` exactly once → newRev.
 *   - Each accepted upsert row is stamped `rev = newRev`.
 *   - A row is ACCEPTED iff `accepts(storedRev, baseRev)`:
 *       storedRev == null → accept (legacy / never-synced)
 *       baseRev   == null → accept (client has no claim — new row)
 *       else accept iff storedRev <= baseRev (stale client → conflict).
 *   - A rejected (stale) row's write is dropped (server value preserved) and
 *     it is reported in `result.conflicts` with the server's current row.
 *   - Reconcile-delete / message-reconcile blocks are NOT guarded; a
 *     conflicted row's id is still in the payload id-set so reconcile-delete
 *     leaves it in place.
 *
 * Same harness as syncReconcileRepository.test.ts: node:test with a fresh
 * MICHI_DATA_DIR per test, exercising the repository fns directly (no Express).
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
  accepts,
  saveWorkspace,
  saveNode,
  listNodes, listEdges, listTrees, listContexts, listMessages,
  type SyncResult,
  WorkspaceRow, TreeRow, NodeRow, EdgeRow, MessageRow, ContextRow,
} from '../src/services/dbRepository';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'michi-syncrev-test-'));
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

/** Read the raw stored rev of a node (null if NULL/absent). */
function nodeRev(id: string): number | null {
  const row = getDb().prepare('SELECT rev FROM nodes WHERE id = ?').get(id) as { rev: number | null } | undefined;
  return row?.rev ?? null;
}

/** Read the workspace's current sync_rev. */
function wsRev(id: string): number {
  const row = getDb().prepare('SELECT sync_rev FROM workspaces WHERE id = ?').get(id) as { sync_rev: number } | undefined;
  return row?.sync_rev ?? -1;
}

describe('accepts (unit)', () => {
  test('null stored → accept (legacy / never-synced)', () => {
    assert.equal(accepts(null, 0), true);
    assert.equal(accepts(null, 5), true);
    assert.equal(accepts(null, null), true);
    assert.equal(accepts(null, undefined), true);
  });

  test('null base → accept (client has no claim)', () => {
    assert.equal(accepts(0, null), true);
    assert.equal(accepts(7, null), true);
    assert.equal(accepts(7, undefined), true);
  });

  test('stored <= base → accept', () => {
    assert.equal(accepts(0, 0), true);
    assert.equal(accepts(3, 3), true);
    assert.equal(accepts(2, 5), true);
  });

  test('stored > base → reject (stale client)', () => {
    assert.equal(accepts(1, 0), false);
    assert.equal(accepts(5, 2), false);
  });
});

describe('sync rev guard', () => {
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

  test('full sync stamps every accepted row rev=newRev; newRev advances by 1 per sync', () => {
    const ws = makeWorkspace('ws1');
    const r1 = syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [makeTree('ws1', 't1', 'n1')],
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2')],
      messages: [makeMessage('n1', 'm1')],
      contexts: [makeContext('ws1', 'c1')],
    });
    assert.equal(r1.tombstoned, false);
    if (r1.tombstoned) return;
    assert.equal(r1.newRev, 1);
    assert.equal(r1.conflicts.length, 0);
    assert.equal(wsRev('ws1'), 1);

    // Every accepted row stamped rev = 1.
    const revOf = (table: string, id: string) =>
      (getDb().prepare(`SELECT rev FROM ${table} WHERE id = ?`).get(id) as { rev: number | null }).rev;
    assert.equal(revOf('trees', 't1'), 1);
    assert.equal(revOf('nodes', 'n1'), 1);
    assert.equal(revOf('nodes', 'n2'), 1);
    assert.equal(revOf('edges', 'e1'), 1);
    assert.equal(revOf('messages', 'm1'), 1);
    assert.equal(revOf('contexts', 'c1'), 1);

    // A second sync advances newRev by exactly 1.
    const r2 = syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [makeTree('ws1', 't1', 'n1')],
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2')],
      messages: [makeMessage('n1', 'm1')],
      contexts: [makeContext('ws1', 'c1')],
      // client now knows rev 1 for every row — no conflicts.
      baseRevs: { t1: 1, n1: 1, n2: 1, e1: 1, m1: 1, c1: 1 },
    });
    assert.equal(r2.tombstoned, false);
    if (r2.tombstoned) return;
    assert.equal(r2.newRev, 2);
    assert.equal(r2.conflicts.length, 0);
    assert.equal(nodeRev('n1'), 2);
  });

  test('stale write → conflict; DB row unchanged (server value wins), B write dropped', () => {
    const ws = makeWorkspace('ws1');
    // Client A syncs node n1 (title A) → newRev 1, node.rev 1.
    const rA = syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })], edges: [], messages: [], contexts: [],
    });
    assert.equal(rA.tombstoned, false);
    if (rA.tombstoned) return;
    assert.equal(rA.newRev, 1);
    assert.equal(nodeRev('n1'), 1);
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');

    // Client B syncs the SAME node id with a stale baseRev (0) and a different
    // title → conflict; the DB title/rev stay as A's (server wins), B dropped.
    const rB = syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [], nodes: [makeNode('ws1', 'n1', { title: 'B' })], edges: [], messages: [], contexts: [],
      baseRevs: { n1: 0 },
    });
    assert.equal(rB.tombstoned, false);
    if (rB.tombstoned) return;
    // The sync still ran (rev bumped to 2) but n1 was rejected.
    assert.equal(rB.newRev, 2);
    assert.equal(rB.conflicts.length, 1);
    assert.equal(rB.conflicts[0].id, 'n1');
    assert.equal(rB.conflicts[0].table, 'nodes');
    // serverRow carries the current (A) row.
    assert.equal((rB.conflicts[0].serverRow as NodeRow).title, 'A');
    assert.equal((rB.conflicts[0].serverRow as NodeRow).rev, 1);

    // DB unchanged: title still A, rev still 1 (NOT bumped to 2 — write dropped).
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');
    assert.equal(nodeRev('n1'), 1);
  });

  test('fresh/legacy accept: a row seeded with NULL rev is accepted (no conflict)', () => {
    const ws = makeWorkspace('ws1');
    saveWorkspace(ws);
    // Seed n1 directly via saveNode → rev stays NULL (legacy / never-synced).
    saveNode(makeNode('ws1', 'n1', { title: 'legacy' }));
    assert.equal(nodeRev('n1'), null);

    // Sync the same id with a baseRev present (or even stale-looking) → because
    // stored rev is NULL, accepts() returns true → accepted, no conflict.
    const r = syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [], nodes: [makeNode('ws1', 'n1', { title: 'updated' })], edges: [], messages: [], contexts: [],
      baseRevs: { n1: 0 },
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.conflicts.length, 0);
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'updated');
    assert.equal(nodeRev('n1'), r.newRev); // now stamped
  });

  test('new row (base=null) → accepted', () => {
    const ws = makeWorkspace('ws1');
    // First sync establishes n1 @ rev 1.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1')], edges: [], messages: [], contexts: [],
    });
    // Second sync adds a brand-new n2 with NO baseRev entry → accepted.
    const r = syncWorkspaceState('ws1', {
      workspace: ws, trees: [],
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [], messages: [], contexts: [],
      baseRevs: { n1: 1 }, // n2 absent → no claim → accept
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);
    assert.equal(nodeRev('n2'), r.newRev);
  });

  test('delete-only delta still bumps; returns { tombstoned:false, ... }', () => {
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [],
      nodes: [makeNode('ws1', 'n1'), makeNode('ws1', 'n2')],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2'), makeEdge('ws1', 'e2', 'n2', 'n1')],
      messages: [], contexts: [],
    });
    const before = wsRev('ws1');

    // A delta carrying ONLY deletes.edges must still bump sync_rev.
    const r = syncWorkspaceDelta('ws1', { deletes: { edges: ['e1'] } });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.newRev, before + 1);
    assert.equal(wsRev('ws1'), before + 1);
    assert.equal(r.conflicts.length, 0);
    assert.deepEqual(listEdges('ws1').map((e) => e.id), ['e2']);
  });

  test('delete-only delta on a delta-created workspace bumps from 0', () => {
    // The delta path creates the workspace if its first delta carries one.
    const r = syncWorkspaceDelta('ws1', {
      workspace: makeWorkspace('ws1'),
      deletes: { edges: ['nope'] }, // nothing to delete, but rev still bumps
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.newRev, 1);
    assert.equal(wsRev('ws1'), 1);
  });

  test('conflicted row is NOT reconcile-deleted (full path): survives with server value', () => {
    const ws = makeWorkspace('ws1');
    // Seed two nodes @ rev 1.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [],
      nodes: [makeNode('ws1', 'n1', { title: 'A' }), makeNode('ws1', 'n2', { title: 'keep' })],
      edges: [], messages: [], contexts: [],
    });
    assert.equal(nodeRev('n1'), 1);

    // Client B sends a FULL payload that still LISTS n1 (stale, title B) and n2.
    // n1 conflicts (stale baseRev), but because its id is in the payload set,
    // reconcile-delete must NOT remove it; it survives with the server value A.
    const r = syncWorkspaceState('ws1', {
      workspace: ws, trees: [],
      nodes: [makeNode('ws1', 'n1', { title: 'B' }), makeNode('ws1', 'n2', { title: 'keep' })],
      edges: [], messages: [], contexts: [],
      baseRevs: { n1: 0, n2: 1 },
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'n1');
    // n1 still present, server value preserved, rev unchanged.
    assert.deepEqual(listNodes('ws1').map((n) => n.id).sort(), ['n1', 'n2']);
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');
    assert.equal(nodeRev('n1'), 1);
    // n2 accepted (fresh baseRev) and re-stamped.
    assert.equal(nodeRev('n2'), r.newRev);
  });

  test('delta path: stale upsert → conflict, server value preserved', () => {
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })],
      edges: [], messages: [], contexts: [],
    });
    assert.equal(nodeRev('n1'), 1);

    const r = syncWorkspaceDelta('ws1', {
      upserts: { nodes: [makeNode('ws1', 'n1', { title: 'B' })] },
      baseRevs: { n1: 0 },
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'n1');
    assert.equal(r.conflicts[0].table, 'nodes');
    // server value (A) preserved, rev unchanged.
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');
    assert.equal(nodeRev('n1'), 1);
  });

  test('tombstone short-circuit: returns { tombstoned: true } (full + delta)', () => {
    const ws = makeWorkspace('ws1');
    saveWorkspace(ws);
    // Tombstone the workspace.
    getDb().prepare('UPDATE workspaces SET purged_at = ? WHERE id = ?').run(Date.now(), 'ws1');

    const rFull = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1')], edges: [], messages: [], contexts: [],
    });
    assert.deepEqual(rFull, { tombstoned: true });

    const rDelta = syncWorkspaceDelta('ws1', {
      upserts: { nodes: [makeNode('ws1', 'n1')] },
    });
    assert.deepEqual(rDelta, { tombstoned: true });

    // No write happened.
    assert.equal(listNodes('ws1').length, 0);
  });

  test('CONVERGENCE: delta of one change vs full snapshot → same DB structure', () => {
    // Structural convergence still holds with the guard in place (rev values
    // differ by construction; we assert structure as the existing convergence
    // test does). Disjoint id namespaces because ids are global PKs.
    const ws = makeWorkspace('ws1');
    syncWorkspaceState('ws1', {
      workspace: ws,
      trees: [makeTree('ws1', 't1', 'n1')],
      nodes: [makeNode('ws1', 'n1', { title: 'one' }), makeNode('ws1', 'n2', { title: 'two' })],
      edges: [makeEdge('ws1', 'e1', 'n1', 'n2'), makeEdge('ws1', 'e2', 'n2', 'n1')],
      messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm2'), makeMessage('n2', 'k1')],
      contexts: [makeContext('ws1', 'c1'), makeContext('ws1', 'c2')],
    });

    // Apply the change as a DELTA on ws1. baseRevs advanced to 1 (everything
    // synced @ rev 1) so the renames/upserts are accepted, not conflicts.
    syncWorkspaceDelta('ws1', {
      upserts: {
        nodes: [makeNode('ws1', 'n1', { title: 'one-renamed' }), makeNode('ws1', 'n3', { title: 'three' })],
        edges: [makeEdge('ws1', 'e3', 'n1', 'n3')],
        messages: [makeMessage('n1', 'm1'), makeMessage('n1', 'm3')],
      },
      deletes: { edges: ['e2'], contexts: ['c2'] },
      baseRevs: { n1: 1, e3: null, m1: 1, m3: null, n3: null },
    });

    const deltaTitles = listNodes('ws1').map((n) => n.title).sort();
    const deltaEdgeCount = listEdges('ws1').length;
    const deltaTreeCount = listTrees('ws1').length;
    const deltaCtxCount = listContexts('ws1').length;
    const deltaMsgN1 = listMessages('n1').map((m) => m.id).sort();
    const deltaMsgN2 = listMessages('n2').map((m) => m.id).sort();
    const deltaMsgN3 = listMessages('n3').map((m) => m.id).sort();

    // Build the SAME post-change state from scratch via a FULL sync in ws2,
    // disjoint id namespace (suffix 'b').
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

  test('cloud-mode: foreign row id does NOT appear in conflicts / serverRow (cross-tenant leak prevention)', () => {
    // Simulates MICHI_CLOUD=1 tenancy: workspace B (userB) has a node nB with
    // rev ≥ 1. UserA POSTs to workspace A with the foreign id nB listed in
    // nodes + baseRevs[nB]=0 (stale-looking). Without the workspace scope fix,
    // readRowRev would return B's real rev, accepts(≥1, 0)=false, and
    // loadRowById would return B's full row in conflicts — a cross-tenant leak.
    // With the fix, nB is invisible to workspace A's guard reads → readRowRev
    // returns null → accepts(null,0)=true → the write is attempted and
    // harmlessly dropped by saveNode's owner guard → loadRowById never reached
    // → conflicts is empty → no serverRow leaked.
    const prevCloud = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    try {
      // Seed workspace B (owned by userB) with node nB carrying a secret title.
      saveWorkspace({ ...makeWorkspace('wsB'), owner_user_id: 'userB' } as WorkspaceRow & { owner_user_id: string });
      // Sync nB so it gets rev=1 and a recognisable title.
      const rB = syncWorkspaceState('wsB', {
        workspace: { ...makeWorkspace('wsB'), owner_user_id: 'userB' } as WorkspaceRow & { owner_user_id: string },
        trees: [], nodes: [makeNode('wsB', 'nB', { title: 'SECRET_B' })],
        edges: [], messages: [], contexts: [],
      }, 'userB');
      assert.equal(rB.tombstoned, false);
      if (rB.tombstoned) return;
      assert.equal(rB.newRev, 1);

      // UserA syncs workspace A and lists the foreign id nB in the payload.
      saveWorkspace({ ...makeWorkspace('wsA'), owner_user_id: 'userA' } as WorkspaceRow & { owner_user_id: string });
      const rA = syncWorkspaceState('wsA', {
        workspace: { ...makeWorkspace('wsA'), owner_user_id: 'userA' } as WorkspaceRow & { owner_user_id: string },
        trees: [],
        nodes: [makeNode('wsA', 'nA', { title: 'mine' }), makeNode('wsA', 'nB', { title: 'foreign_attempt' })],
        edges: [], messages: [], contexts: [],
        // nB has a stale-looking baseRev; without the fix this would trigger a
        // conflict returning B's row as serverRow.
        baseRevs: { nA: null, nB: 0 },
      }, 'userA');

      assert.equal(rA.tombstoned, false);
      if (rA.tombstoned) return;

      // The conflict array must NOT contain nB (no cross-tenant serverRow).
      // With the workspace-scoped readRowRev, the foreign id is invisible to
      // wsA's guard → readRowRev returns null → accepts(null,0)=true → write
      // attempted → loadRowById is NEVER reached → no serverRow for nB.
      const conflictIds = rA.conflicts.map((c) => c.id);
      assert.ok(
        !conflictIds.includes('nB'),
        `foreign node nB must not appear in conflicts — got: ${JSON.stringify(conflictIds)}`,
      );
      // Belt-and-suspenders: even if nB somehow appeared, its serverRow must
      // not carry B's secret title.
      for (const c of rA.conflicts) {
        const row = c.serverRow as { title?: string } | null;
        assert.notEqual(row?.title, 'SECRET_B', 'B\'s secret title must not leak via serverRow');
      }
    } finally {
      if (prevCloud === undefined) delete process.env.MICHI_CLOUD;
      else process.env.MICHI_CLOUD = prevCloud;
    }
  });

  test('desktop-mode: same-workspace conflict still returns serverRow correctly', () => {
    // Regression guard: the workspace-scoping fix must not break normal
    // same-workspace conflict reporting in desktop mode (no MICHI_CLOUD).
    const ws = makeWorkspace('ws1');
    // Client A syncs n1 → rev 1.
    syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })],
      edges: [], messages: [], contexts: [],
    });

    // Client B syncs the same node with a stale baseRev → conflict.
    const r = syncWorkspaceState('ws1', {
      workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'B' })],
      edges: [], messages: [], contexts: [],
      baseRevs: { n1: 0 },
    });
    assert.equal(r.tombstoned, false);
    if (r.tombstoned) return;

    // Conflict is reported and serverRow carries A's value.
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].id, 'n1');
    assert.equal(r.conflicts[0].table, 'nodes');
    const serverRow = r.conflicts[0].serverRow as NodeRow;
    assert.equal(serverRow.title, 'A');
    assert.equal(serverRow.rev, 1);
    // DB unchanged.
    assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');
  });
});

describe('MICHI_SYNC_CONFLICTS flag', () => {
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

  test('default (env unset) = enforcement ON: stale write produces a conflict', () => {
    // Belt: confirm the flag is treated as enabled when MICHI_SYNC_CONFLICTS
    // is not set at all (the default-ON contract).
    const prev = process.env.MICHI_SYNC_CONFLICTS;
    delete process.env.MICHI_SYNC_CONFLICTS;
    try {
      const ws = makeWorkspace('ws1');
      // First sync @ rev 1.
      syncWorkspaceState('ws1', {
        workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })],
        edges: [], messages: [], contexts: [],
      });

      // Stale write (baseRev 0 behind stored rev 1) → must conflict.
      const r = syncWorkspaceState('ws1', {
        workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'B' })],
        edges: [], messages: [], contexts: [],
        baseRevs: { n1: 0 },
      });
      assert.equal(r.tombstoned, false);
      if (r.tombstoned) return;
      assert.equal(r.conflicts.length, 1, 'enforcement must be ON by default');
      assert.equal(r.conflicts[0].id, 'n1');
      // Server value preserved.
      assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'A');
    } finally {
      if (prev === undefined) delete process.env.MICHI_SYNC_CONFLICTS;
      else process.env.MICHI_SYNC_CONFLICTS = prev;
    }
  });

  test('MICHI_SYNC_CONFLICTS=0: stale write is ACCEPTED (accept-all), conflicts empty', () => {
    const prev = process.env.MICHI_SYNC_CONFLICTS;
    process.env.MICHI_SYNC_CONFLICTS = '0';
    try {
      const ws = makeWorkspace('ws1');
      // First sync @ rev 1 (enforcement is off but bump still runs).
      const r1 = syncWorkspaceState('ws1', {
        workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })],
        edges: [], messages: [], contexts: [],
      });
      assert.equal(r1.tombstoned, false);
      if (r1.tombstoned) return;
      assert.equal(r1.newRev, 1);
      assert.equal(r1.conflicts.length, 0);

      // Stale write that WOULD conflict when enforcement is on: baseRev 0 vs stored 1.
      const r2 = syncWorkspaceState('ws1', {
        workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'B' })],
        edges: [], messages: [], contexts: [],
        baseRevs: { n1: 0 },
      });
      assert.equal(r2.tombstoned, false);
      if (r2.tombstoned) return;
      // With kill switch: accepted, no conflicts, B wins.
      assert.equal(r2.conflicts.length, 0, 'kill switch: stale write must be accepted');
      assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'B',
        'kill switch: client value must overwrite server value');
      // Rev is still bumped.
      assert.equal(r2.newRev, 2, 'bump still runs with kill switch active');
    } finally {
      if (prev === undefined) delete process.env.MICHI_SYNC_CONFLICTS;
      else process.env.MICHI_SYNC_CONFLICTS = prev;
    }
  });

  test('MICHI_SYNC_CONFLICTS=0: delta path also accepts stale write, bump still advances', () => {
    const prev = process.env.MICHI_SYNC_CONFLICTS;
    process.env.MICHI_SYNC_CONFLICTS = '0';
    try {
      const ws = makeWorkspace('ws1');
      syncWorkspaceState('ws1', {
        workspace: ws, trees: [], nodes: [makeNode('ws1', 'n1', { title: 'A' })],
        edges: [], messages: [], contexts: [],
      });

      const r = syncWorkspaceDelta('ws1', {
        upserts: { nodes: [makeNode('ws1', 'n1', { title: 'B' })] },
        baseRevs: { n1: 0 }, // stale
      });
      assert.equal(r.tombstoned, false);
      if (r.tombstoned) return;
      assert.equal(r.conflicts.length, 0, 'delta kill switch: no conflicts');
      assert.equal(listNodes('ws1').find((n) => n.id === 'n1')?.title, 'B',
        'delta kill switch: client value written');
      assert.equal(r.newRev, 2, 'delta kill switch: bump still runs');
    } finally {
      if (prev === undefined) delete process.env.MICHI_SYNC_CONFLICTS;
      else process.env.MICHI_SYNC_CONFLICTS = prev;
    }
  });
});
