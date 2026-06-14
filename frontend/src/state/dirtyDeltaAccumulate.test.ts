import { describe, it, expect } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  emptyWorkspaceDirtyDelta,
  serializedEdgeId,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatMessage, ChatNodeState, Project, ProjectEdge, Tree, ContextEntry } from './chatTypes';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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

function makeMsg(id: string): ChatMessage {
  return { id, role: 'user', text: 'hi', toolCalls: [], createdAt: 1 } as unknown as ChatMessage;
}

function makeProject(id: string, nodeIds: string[], extras: Partial<Project> = {}): Project {
  return {
    id,
    name: 'Test',
    chatIds: nodeIds,
    edges: [],
    createdAt: 1_716_800_000_000,
    trees: [{ id: 't1', rootNodeId: nodeIds[0] ?? 'n1', createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: 't1',
    contexts: [],
    ...extras,
  } as Project;
}

function edge(source: string, target: string, kind: ProjectEdge['kind'] = 'branch'): ProjectEdge {
  return { source, target, kind };
}

function tree(id: string): Tree {
  return { id, rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 };
}

function ctx(id: string): ContextEntry {
  return { id, name: id, filePath: `/${id}`, source: 'user', createdAt: 1, updatedAt: 1 };
}

/** Assert the core invariant: no id in both upsert and delete sets. */
function assertNoOverlap(d: WorkspaceDirtyDelta) {
  for (const id of d.edgeUpsertIds) {
    expect(d.edgeDeleteIds.has(id), `edge ${id} in both upsert and delete`).toBe(false);
  }
  for (const id of d.treeUpsertIds) {
    expect(d.treeDeleteIds.has(id), `tree ${id} in both upsert and delete`).toBe(false);
  }
  for (const id of d.contextUpsertIds) {
    expect(d.contextDeleteIds.has(id), `context ${id} in both upsert and delete`).toBe(false);
  }
}

// Convenience: run two accumulate calls in sequence (simulating two ticks).
function accumulate2(
  tick1: { prev: Project | undefined; cur: Project; prevNodes?: Record<string, ChatNodeState>; curNodes?: Record<string, ChatNodeState> },
  tick2: { prev: Project; cur: Project; prevNodes?: Record<string, ChatNodeState>; curNodes?: Record<string, ChatNodeState> },
): WorkspaceDirtyDelta {
  const empty: Record<string, ChatNodeState> = {};
  const d1 = accumulateWorkspaceDirtyDelta(
    tick1.prev, tick1.cur,
    tick1.prevNodes ?? empty, tick1.curNodes ?? empty,
    emptyWorkspaceDirtyDelta(),
  );
  return accumulateWorkspaceDirtyDelta(
    tick2.prev, tick2.cur,
    tick2.prevNodes ?? empty, tick2.curNodes ?? empty,
    d1,
  );
}

// ---------------------------------------------------------------------------
// Invariant: upsert ∩ delete = ∅ after any sequence
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — invariant', () => {
  it('no id ever appears in both upsert and delete sets (single tick)', () => {
    const prev = makeProject('ws1', [], { edges: [edge('a', 'b')], trees: [tree('t1')], contexts: [ctx('c1')] });
    const cur  = makeProject('ws1', [], { edges: [edge('c', 'd')], trees: [tree('t2')], contexts: [ctx('c2')] });
    const d = accumulateWorkspaceDirtyDelta(prev, cur, {}, {}, emptyWorkspaceDirtyDelta());
    assertNoOverlap(d);
  });

  it('invariant holds after delete-then-re-add in two ticks', () => {
    const base  = makeProject('ws1', [], { edges: [edge('a', 'b')] });
    const after = makeProject('ws1', [], { edges: [] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },   // re-add
    );
    assertNoOverlap(d);
  });

  it('invariant holds after add-then-delete in two ticks', () => {
    const base  = makeProject('ws1', [], { edges: [] });
    const after = makeProject('ws1', [], { edges: [edge('a', 'b')] });
    const d = accumulate2(
      { prev: base, cur: after },   // add
      { prev: after, cur: base },   // then delete
    );
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Edges — delete-then-re-add and add-then-delete
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — edges', () => {
  it('add-then-delete: ends in deletes only (regression for the bug)', () => {
    const eId = serializedEdgeId(edge('a', 'b'));
    const base  = makeProject('ws1', [], { edges: [] });
    const after = makeProject('ws1', [], { edges: [edge('a', 'b')] });

    const d = accumulate2(
      { prev: base, cur: after },   // tick 1: add edge
      { prev: after, cur: base },   // tick 2: delete edge
    );

    expect(d.edgeDeleteIds.has(eId)).toBe(true);
    expect(d.edgeUpsertIds.has(eId)).toBe(false);
    assertNoOverlap(d);
  });

  it('delete-then-re-add: ends in upserts only (was the bug — re-add stripped)', () => {
    const eId = serializedEdgeId(edge('a', 'b'));
    const base  = makeProject('ws1', [], { edges: [edge('a', 'b')] });
    const after = makeProject('ws1', [], { edges: [] });

    const d = accumulate2(
      { prev: base, cur: after },   // tick 1: delete edge
      { prev: after, cur: base },   // tick 2: re-add edge
    );

    expect(d.edgeUpsertIds.has(eId)).toBe(true);
    expect(d.edgeDeleteIds.has(eId)).toBe(false);
    assertNoOverlap(d);
  });

  it('simple add: edge in upserts, not deletes', () => {
    const eId = serializedEdgeId(edge('x', 'y'));
    const base  = makeProject('ws1', [], { edges: [] });
    const after = makeProject('ws1', [], { edges: [edge('x', 'y')] });
    const d = accumulateWorkspaceDirtyDelta(base, after, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.edgeUpsertIds.has(eId)).toBe(true);
    expect(d.edgeDeleteIds.has(eId)).toBe(false);
  });

  it('simple remove: edge in deletes, not upserts', () => {
    const eId = serializedEdgeId(edge('x', 'y'));
    const base  = makeProject('ws1', [], { edges: [edge('x', 'y')] });
    const after = makeProject('ws1', [], { edges: [] });
    const d = accumulateWorkspaceDirtyDelta(base, after, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.edgeDeleteIds.has(eId)).toBe(true);
    expect(d.edgeUpsertIds.has(eId)).toBe(false);
  });

  it('unrelated existing edge in pending delete is not touched by a new upsert', () => {
    const eId1 = serializedEdgeId(edge('a', 'b'));
    const eId2 = serializedEdgeId(edge('c', 'd'));
    // Seed: eId1 already in delete set from a prior tick.
    const existing = emptyWorkspaceDirtyDelta();
    existing.edgeDeleteIds.add(eId1);

    const base  = makeProject('ws1', [], { edges: [] });
    const after = makeProject('ws1', [], { edges: [edge('c', 'd')] }); // adds eId2
    const d = accumulateWorkspaceDirtyDelta(base, after, {}, {}, existing);

    expect(d.edgeDeleteIds.has(eId1)).toBe(true);  // untouched
    expect(d.edgeUpsertIds.has(eId2)).toBe(true);  // new add
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Trees — same delete-then-re-add / add-then-delete logic
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — trees', () => {
  it('add-then-delete: ends in deletes only', () => {
    const base  = makeProject('ws1', [], { trees: [] });
    const after = makeProject('ws1', [], { trees: [tree('t2')] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },
    );
    expect(d.treeDeleteIds.has('t2')).toBe(true);
    expect(d.treeUpsertIds.has('t2')).toBe(false);
    assertNoOverlap(d);
  });

  it('delete-then-re-add: ends in upserts only', () => {
    const base  = makeProject('ws1', [], { trees: [tree('t2')] });
    const after = makeProject('ws1', [], { trees: [] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },
    );
    expect(d.treeUpsertIds.has('t2')).toBe(true);
    expect(d.treeDeleteIds.has('t2')).toBe(false);
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Contexts — same delete-then-re-add / add-then-delete logic
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — contexts', () => {
  it('add-then-delete: ends in deletes only', () => {
    const base  = makeProject('ws1', [], { contexts: [] });
    const after = makeProject('ws1', [], { contexts: [ctx('c2')] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },
    );
    expect(d.contextDeleteIds.has('c2')).toBe(true);
    expect(d.contextUpsertIds.has('c2')).toBe(false);
    assertNoOverlap(d);
  });

  it('delete-then-re-add: ends in upserts only', () => {
    const base  = makeProject('ws1', [], { contexts: [ctx('c2')] });
    const after = makeProject('ws1', [], { contexts: [] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },
    );
    expect(d.contextUpsertIds.has('c2')).toBe(true);
    expect(d.contextDeleteIds.has('c2')).toBe(false);
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Node + message tracking
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — nodes and messages', () => {
  it('changed node → nodeIds set; unchanged message ref → NOT in messageNodeIds', () => {
    const msgs = [makeMsg('m1')];
    const n1before = makeNode('n1', 'ws1', { messages: msgs, title: 'before' });
    const n1after  = makeNode('n1', 'ws1', { messages: msgs, title: 'after' });  // same messages ref
    const project = makeProject('ws1', ['n1']);
    const d = accumulateWorkspaceDirtyDelta(
      project, project,
      { n1: n1before }, { n1: n1after },
      emptyWorkspaceDirtyDelta(),
    );
    expect(d.nodeIds.has('n1')).toBe(true);
    expect(d.messageNodeIds.has('n1')).toBe(false);
  });

  it('changed message ref → both nodeIds and messageNodeIds set', () => {
    const n1before = makeNode('n1', 'ws1', { messages: [makeMsg('m1')] });
    const n1after  = makeNode('n1', 'ws1', { messages: [makeMsg('m1'), makeMsg('m2')] }); // new ref
    const project = makeProject('ws1', ['n1']);
    const d = accumulateWorkspaceDirtyDelta(
      project, project,
      { n1: n1before }, { n1: n1after },
      emptyWorkspaceDirtyDelta(),
    );
    expect(d.nodeIds.has('n1')).toBe(true);
    expect(d.messageNodeIds.has('n1')).toBe(true);
  });

  it('node trimmed to zero messages → messageNodeIds set (empty messages array)', () => {
    const n1before = makeNode('n1', 'ws1', { messages: [makeMsg('m1')] });
    const n1after  = makeNode('n1', 'ws1', { messages: [] });
    const project = makeProject('ws1', ['n1']);
    const d = accumulateWorkspaceDirtyDelta(
      project, project,
      { n1: n1before }, { n1: n1after },
      emptyWorkspaceDirtyDelta(),
    );
    expect(d.messageNodeIds.has('n1')).toBe(true);
  });

  it('new node (no prev) → both nodeIds and messageNodeIds set', () => {
    const prevProject = makeProject('ws1', []);
    const curProject  = makeProject('ws1', ['n2']);
    const n2 = makeNode('n2', 'ws1', { messages: [makeMsg('m1')] });
    const d = accumulateWorkspaceDirtyDelta(
      prevProject, curProject,
      {}, { n2 },
      emptyWorkspaceDirtyDelta(),
    );
    expect(d.nodeIds.has('n2')).toBe(true);
    expect(d.messageNodeIds.has('n2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Workspace-level fields
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — workspace fields', () => {
  it('workspaceChanged set when name changes', () => {
    const prev = makeProject('ws1', []);
    const cur  = makeProject('ws1', [], { name: 'Renamed' });
    const d = accumulateWorkspaceDirtyDelta(prev, cur, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.workspaceChanged).toBe(true);
  });

  it('workspaceChanged NOT set when only an untracked field changes', () => {
    const prev = makeProject('ws1', ['n1']);
    // chatIds changed — that's not a workspace-row field.
    const cur  = makeProject('ws1', ['n1', 'n2']);
    const d = accumulateWorkspaceDirtyDelta(prev, cur, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.workspaceChanged).toBe(false);
  });

  it('workspaceChanged set when prev is undefined (new project)', () => {
    const cur = makeProject('ws1', []);
    const d = accumulateWorkspaceDirtyDelta(undefined, cur, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.workspaceChanged).toBe(true);
  });
});
