import { describe, it, expect } from 'vitest';
import {
  serializeWorkspaceForSync,
  serializeWorkspaceDelta,
  emptyWorkspaceDirtyDelta,
  collectBaseRevs,
  collectSentRowIds,
  advanceAcceptedRevs,
  advanceWorkspaceSyncRev,
  adoptConflictsIntoState,
  populateRevsFromBackend,
  recordConflictRevs,
  shouldAdoptSyncConflicts,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatMessage, ChatNodeState, Project } from './chatTypes';

// ---------------------------------------------------------------------------
// Minimal fixture builders (mirrors persistenceDelta.test.ts)
// ---------------------------------------------------------------------------

function makeMessage(id: string, extras: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'user',
    text: 'hi',
    toolCalls: [],
    createdAt: 1_716_800_000_000,
    ...extras,
  } as unknown as ChatMessage;
}

function makeNode(nodeId: string, projectId: string, extras: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId,
    messages: [],
    followUps: [],
    status: 'idle',
    ...extras,
  } as unknown as ChatNodeState;
}

function makeProject(id: string, nodeIds: string[], extras: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Test',
    chatIds: nodeIds,
    edges: [],
    createdAt: 1_716_800_000_000,
    trees: [{ id: 't1', rootNodeId: nodeIds[0] ?? 'n1', createdAt: 1_716_800_000_000, lastActiveAt: 1_716_800_000_000 }],
    activeTreeId: 't1',
    contexts: [],
    ...extras,
  } as Project;
}

/** Build a dirty delta from a partial spec (sets default to empty). */
function makeDirty(spec: Partial<{
  nodeIds: string[];
  messageNodeIds: string[];
  edgeUpsertIds: string[];
  edgeDeleteIds: string[];
  treeUpsertIds: string[];
  treeDeleteIds: string[];
  contextUpsertIds: string[];
  contextDeleteIds: string[];
  workspaceChanged: boolean;
}> = {}): WorkspaceDirtyDelta {
  const d = emptyWorkspaceDirtyDelta();
  for (const id of spec.nodeIds ?? []) d.nodeIds.add(id);
  for (const id of spec.messageNodeIds ?? []) d.messageNodeIds.add(id);
  for (const id of spec.edgeUpsertIds ?? []) d.edgeUpsertIds.add(id);
  for (const id of spec.edgeDeleteIds ?? []) d.edgeDeleteIds.add(id);
  for (const id of spec.treeUpsertIds ?? []) d.treeUpsertIds.add(id);
  for (const id of spec.treeDeleteIds ?? []) d.treeDeleteIds.add(id);
  for (const id of spec.contextUpsertIds ?? []) d.contextUpsertIds.add(id);
  for (const id of spec.contextDeleteIds ?? []) d.contextDeleteIds.add(id);
  if (spec.workspaceChanged) d.workspaceChanged = true;
  return d;
}

/**
 * The backend's accept rule, mirrored from the L2 design (§ Conflict guard):
 *   storedRev == null → accept; baseRev == null → accept; else storedRev <= baseRev.
 * Used by the self-conflict zero-test to prove that an advanced base rev never
 * trips a conflict against the row the same client just wrote.
 */
function accepts(storedRev: number | null, baseRev: number | null): boolean {
  if (storedRev == null) return true;
  if (baseRev == null) return true;
  return storedRev <= baseRev;
}

// ---------------------------------------------------------------------------
// collectBaseRevs
// ---------------------------------------------------------------------------

describe('collectBaseRevs', () => {
  it('returns the ref rev per id, null for unknown ids', () => {
    const ref = new Map<string, number>([['n1', 3], ['n2', 7]]);
    expect(collectBaseRevs(['n1', 'n2', 'n3'], ref)).toEqual({ n1: 3, n2: 7, n3: null });
  });

  it('returns an empty object for an empty id set', () => {
    expect(collectBaseRevs([], new Map())).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// collectSentRowIds — both full + delta shapes
// ---------------------------------------------------------------------------

describe('collectSentRowIds', () => {
  it('collects ids from a full snapshot (trees/nodes/edges/messages/contexts)', () => {
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
      contexts: [{ id: 'c1', name: 'c', filePath: '/c', source: 'user', createdAt: 1, updatedAt: 1 }],
    });
    const nodes = {
      n1: makeNode('n1', 'ws1', { messages: [makeMessage('m1')] }),
      n2: makeNode('n2', 'ws1'),
    };
    const full = serializeWorkspaceForSync(project, nodes);
    const ids = collectSentRowIds(full);
    // The workspace row is keyed separately (by project id), so it is excluded.
    expect(ids).toEqual(new Set(['t1', 'n1', 'n2', 'branch-n1-n2', 'm1', 'c1']));
  });

  it('collects ids from a delta (upserts only, deletes excluded)', () => {
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1', { messages: [makeMessage('m1')] }) };
    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({
        nodeIds: ['n1'],
        messageNodeIds: ['n1'],
        edgeUpsertIds: ['branch-n1-n2'],
        edgeDeleteIds: ['branch-n9-n9'], // delete ids are NOT version-guarded
      }),
    );
    const ids = collectSentRowIds(delta);
    expect(ids).toEqual(new Set(['n1', 'm1', 'branch-n1-n2']));
    expect(ids.has('branch-n9-n9')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// baseRevs attachment + serializer-unchanged (convergence)
// ---------------------------------------------------------------------------

describe('baseRevs attachment (sibling field, serializers untouched)', () => {
  it('full payload: baseRevs covers exactly every serialized row id', () => {
    const ref = new Map<string, number>([['n1', 5], ['branch-n1-n2', 2], ['c1', 9]]);
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
      contexts: [{ id: 'c1', name: 'c', filePath: '/c', source: 'user', createdAt: 1, updatedAt: 1 }],
    });
    const nodes = {
      n1: makeNode('n1', 'ws1', { messages: [makeMessage('m1')] }),
      n2: makeNode('n2', 'ws1'),
    };
    const full = serializeWorkspaceForSync(project, nodes);
    const payload = { ...full, baseRevs: collectBaseRevs(collectSentRowIds(full), ref) };

    expect(payload.baseRevs).toEqual({
      t1: null,
      n1: 5,
      n2: null,
      'branch-n1-n2': 2,
      m1: null,
      c1: 9,
    });
  });

  it('delta payload: baseRevs covers exactly the upserted row ids', () => {
    const ref = new Map<string, number>([['n1', 4]]);
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1', { messages: [makeMessage('m1')] }) };
    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({ nodeIds: ['n1'], messageNodeIds: ['n1'], edgeUpsertIds: ['branch-n1-n2'] }),
    );
    const payload = { ...delta, baseRevs: collectBaseRevs(collectSentRowIds(delta), ref) };
    expect(payload.baseRevs).toEqual({ n1: 4, m1: null, 'branch-n1-n2': null });
  });

  it('the serialized ROW output is byte-for-byte unchanged by rev tracking (convergence)', () => {
    // Pre-rev expected shapes — assert the serializers still produce these
    // exactly, i.e. attaching baseRevs as a sibling did not leak `rev` into rows.
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm-a', createdAt: 7 }],
      contexts: [{ id: 'c1', name: 'ctx', filePath: '/c1', size: 9, autoInject: true, source: 'user', createdAt: 1, updatedAt: 2 }],
    });
    const nodes = {
      n1: makeNode('n1', 'ws1', { messages: [makeMessage('m1')], title: 'Node One' }),
      n2: makeNode('n2', 'ws1'),
    };

    const full = serializeWorkspaceForSync(project, nodes);
    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({
        nodeIds: ['n1'],
        messageNodeIds: ['n1'],
        edgeUpsertIds: ['branch-n1-n2'],
        treeUpsertIds: ['t1'],
        contextUpsertIds: ['c1'],
      }),
    );

    // No `rev` key on any row in either path.
    for (const row of [...full.nodes, ...full.edges, ...full.trees, ...full.messages, ...full.contexts]) {
      expect(row).not.toHaveProperty('rev');
    }
    expect(full.workspace).not.toHaveProperty('rev');
    expect(full.workspace).not.toHaveProperty('sync_rev');

    // Delta rows equal their full-serializer counterparts for the same entity
    // (the convergence guarantee, unchanged by L2).
    // full.nodes is (row|null)[] post-filter (TS can't narrow .filter(Boolean));
    // n1 is the first row, so index it directly like persistenceDelta.test.ts.
    expect(delta.upserts.nodes![0]).toEqual(full.nodes[0]!);
    expect(delta.upserts.edges![0]).toEqual(full.edges[0]);
    expect(delta.upserts.trees![0]).toEqual(full.trees[0]);
    expect(delta.upserts.contexts![0]).toEqual(full.contexts[0]);
    expect(delta.upserts.messages).toEqual(full.messages.filter((m) => m.node_id === 'n1'));
  });
});

// ---------------------------------------------------------------------------
// SELF-CONFLICT ZERO TEST — the critical one
// ---------------------------------------------------------------------------

describe('advanceAcceptedRevs — self-conflict elimination', () => {
  it('after one ack, collectBaseRevs returns the new rev for an accepted row', () => {
    const ref = new Map<string, number>();
    advanceAcceptedRevs(ref, ['n1'], [], 7);
    expect(collectBaseRevs(['n1'], ref)).toEqual({ n1: 7 });
    // Re-sync sends baseRev=7; backend stored is also 7 → accepts(7,7) → no conflict.
    expect(accepts(7, 7)).toBe(true);
  });

  it('does NOT advance a conflicted row (it adopts the server rev instead)', () => {
    const ref = new Map<string, number>([['n1', 1], ['n2', 1]]);
    // n2 came back as a conflict; n1 was accepted.
    advanceAcceptedRevs(ref, ['n1', 'n2'], ['n2'], 9);
    expect(ref.get('n1')).toBe(9); // accepted → advanced
    expect(ref.get('n2')).toBe(1); // conflicted → left for the adopt path
  });

  it('never regresses an entity rev when an older response arrives late', () => {
    const ref = new Map<string, number>([['n1', 12]]);
    advanceAcceptedRevs(ref, ['n1'], [], 9);
    expect(ref.get('n1')).toBe(12);
  });

  it('N sequential edits to the SAME row produce ZERO conflicts (no oscillation)', () => {
    const ref = new Map<string, number>();
    let serverStored: number | null = null; // backend has never seen the row yet
    const N = 25;

    for (let i = 1; i <= N; i++) {
      // 1. Client flushes: baseRev = whatever we currently hold for n1.
      const baseRevs = collectBaseRevs(['n1'], ref);
      const baseRev = baseRevs.n1;

      // 2. Backend evaluates accepts(stored, base). A single client editing its
      //    own row must NEVER be rejected.
      const accepted = accepts(serverStored, baseRev);
      expect(accepted).toBe(true);

      // 3. Backend bumps sync_rev and stamps the row, then returns newRev.
      const newRev = i; // monotonic per sync txn
      serverStored = newRev;

      // 4. Client advances the accepted row's local rev → newRev.
      advanceAcceptedRevs(ref, ['n1'], [], newRev);

      // 5. The base rev the client now holds equals the last newRev.
      expect(collectBaseRevs(['n1'], ref).n1).toBe(newRev);
    }

    // After N edits: local base rev == server stored == N, zero conflicts.
    expect(ref.get('n1')).toBe(N);
    expect(serverStored).toBe(N);
    expect(accepts(serverStored, ref.get('n1')!)).toBe(true);
  });
});

describe('workspace sync response ordering', () => {
  it('never regresses the accepted workspace sync revision', () => {
    const ref = new Map<string, number>([['ws1', 12]]);
    advanceWorkspaceSyncRev(ref, 'ws1', 9);
    expect(ref.get('ws1')).toBe(12);
    advanceWorkspaceSyncRev(ref, 'ws1', 15);
    expect(ref.get('ws1')).toBe(15);
  });

  it('does not adopt conflicts from a stale response', () => {
    expect(shouldAdoptSyncConflicts({
      currentSyncRev: 12,
      incomingSyncRev: 9,
      hasNewerLocalWork: false,
    })).toBe(false);
  });

  it('does not adopt conflicts while newer local work is queued', () => {
    expect(shouldAdoptSyncConflicts({
      currentSyncRev: 8,
      incomingSyncRev: 9,
      hasNewerLocalWork: true,
    })).toBe(false);
  });

  it('adopts a current conflict when there is no newer local work', () => {
    expect(shouldAdoptSyncConflicts({
      currentSyncRev: 8,
      incomingSyncRev: 9,
      hasNewerLocalWork: false,
    })).toBe(true);
  });

  it('records conflict revs without adopting stale server row contents', () => {
    const ref = new Map<string, number>([['n1', 4]]);
    recordConflictRevs([
      { id: 'n1', table: 'nodes', serverRow: { id: 'n1', rev: 11, title: 'STALE' } },
    ], ref);
    expect(ref.get('n1')).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Conflict adoption — per-row converge-to-server
// ---------------------------------------------------------------------------

describe('adoptConflictsIntoState', () => {
  it('replaces the conflicted node title with the server value and sets its rev; leaves others untouched', () => {
    const project = makeProject('ws1', ['n1', 'n2']);
    const nodes = {
      n1: makeNode('n1', 'ws1', { title: 'LOCAL', messages: [makeMessage('m1')] }),
      n2: makeNode('n2', 'ws1', { title: 'UNTOUCHED' }),
    };
    const ref = new Map<string, number>();

    const serverRow = {
      id: 'n1',
      workspace_id: 'ws1',
      title: 'SERVER',
      kind: 'chat',
      acp_session_id: null,
      rev: 9,
    };
    const { projects, nodes: nextNodes } = adoptConflictsIntoState(
      [project],
      nodes,
      [{ id: 'n1', table: 'nodes', serverRow }],
      'ws1',
      ref,
    );

    // n1 adopted the server title; its local messages are preserved.
    expect(nextNodes.n1.title).toBe('SERVER');
    expect(nextNodes.n1.messages).toBe(nodes.n1.messages);
    expect(ref.get('n1')).toBe(9);

    // n2 reference is unchanged (no needless re-render).
    expect(nextNodes.n2).toBe(nodes.n2);
    expect(nextNodes.n2.title).toBe('UNTOUCHED');

    // No project-row change for a node-only conflict → same project reference.
    expect(projects[0]).toBe(project);
  });

  it('does not regress an entity rev while adopting a conflict row', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { title: 'LOCAL' }) };
    const ref = new Map<string, number>([['n1', 12]]);

    adoptConflictsIntoState(
      [project],
      nodes,
      [{
        id: 'n1',
        table: 'nodes',
        serverRow: { id: 'n1', workspace_id: 'ws1', title: 'SERVER', kind: 'chat', rev: 9 },
      }],
      'ws1',
      ref,
    );

    expect(ref.get('n1')).toBe(12);
  });

  it('adopts a conflicted edge into the project edge list and sets its rev', () => {
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'LOCAL' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1'), n2: makeNode('n2', 'ws1') };
    const ref = new Map<string, number>();

    const serverRow = {
      id: 'branch-n1-n2',
      source_node_id: 'n1',
      target_node_id: 'n2',
      kind: 'branch',
      anchor_message_id: 'SERVER',
      created_at: 42,
      rev: 4,
    };
    const { projects } = adoptConflictsIntoState(
      [project],
      nodes,
      [{ id: 'branch-n1-n2', table: 'edges', serverRow }],
      'ws1',
      ref,
    );

    expect(projects[0].edges[0].anchorMessageId).toBe('SERVER');
    expect(projects[0].edges[0].createdAt).toBe(42);
    expect(ref.get('branch-n1-n2')).toBe(4);
    // Original project object is not mutated in place.
    expect(project.edges[0].anchorMessageId).toBe('LOCAL');
  });

  it('returns the same references and makes no changes when there are no conflicts', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };
    const projects = [project];
    const ref = new Map<string, number>();
    const out = adoptConflictsIntoState(projects, nodes, [], 'ws1', ref);
    // Same array + map references passed straight through (no needless renders).
    expect(out.projects).toBe(projects);
    expect(out.nodes).toBe(nodes);
    expect(ref.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// populateRevsFromBackend — hydration seeding
// ---------------------------------------------------------------------------

describe('populateRevsFromBackend', () => {
  it('seeds per-row rev (by serializer id) and per-workspace sync_rev', () => {
    const raw = [{
      workspace: { id: 'ws1', sync_rev: 12 },
      trees: [{ id: 't1', root_node_id: 'n1', rev: 3 }],
      nodes: [{ id: 'n1', rev: 5 }, { id: 'n2', rev: null }],
      edges: [{ id: 'branch-n1-n2', source_node_id: 'n1', target_node_id: 'n2', rev: 2 }],
      messages: [{ id: 'm1', node_id: 'n1', rev: 8 }],
      contexts: [{ id: 'c1', rev: 1 }],
    }];
    const revRef = new Map<string, number>();
    const syncRef = new Map<string, number>();
    populateRevsFromBackend(raw, revRef, syncRef);

    expect(revRef.get('t1')).toBe(3);
    expect(revRef.get('n1')).toBe(5);
    expect(revRef.has('n2')).toBe(false); // null rev → not seeded → baseRev null → accept
    expect(revRef.get('branch-n1-n2')).toBe(2);
    expect(revRef.get('m1')).toBe(8);
    expect(revRef.get('c1')).toBe(1);
    expect(syncRef.get('ws1')).toBe(12);
  });
});
