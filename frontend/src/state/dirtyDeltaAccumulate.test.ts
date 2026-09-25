import { describe, it, expect } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  emptyWorkspaceDirtyDelta,
  serializedEdgeId,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatMessage, ChatNodeState, Project, ProjectEdge, Tree, ArtifactEntry } from './chatTypes';

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
    artifacts: [],
    ...extras,
  } as Project;
}

function edge(source: string, target: string, kind: ProjectEdge['kind'] = 'branch'): ProjectEdge {
  return { source, target, kind };
}

function tree(id: string): Tree {
  return { id, rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 };
}

function ctx(id: string): ArtifactEntry {
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
    const prev = makeProject('ws1', [], { edges: [edge('a', 'b')], trees: [tree('t1')], artifacts: [ctx('c1')] });
    const cur  = makeProject('ws1', [], { edges: [edge('c', 'd')], trees: [tree('t2')], artifacts: [ctx('c2')] });
    const d = accumulateWorkspaceDirtyDelta(prev, cur, {}, {}, emptyWorkspaceDirtyDelta());
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
});

// ---------------------------------------------------------------------------
// Trees — same delete-then-re-add / add-then-delete logic
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — trees', () => {
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

describe('accumulateWorkspaceDirtyDelta — artifacts', () => {
  it('add-then-delete: ends in deletes only', () => {
    const base  = makeProject('ws1', [], { artifacts: [] });
    const after = makeProject('ws1', [], { artifacts: [ctx('c2')] });
    const d = accumulate2(
      { prev: base, cur: after },
      { prev: after, cur: base },
    );
    expect(d.contextDeleteIds.has('c2')).toBe(true);
    expect(d.contextUpsertIds.has('c2')).toBe(false);
    assertNoOverlap(d);
  });
});

// ---------------------------------------------------------------------------
// Node tracking (messages persist through the authoritative turn path)
// ---------------------------------------------------------------------------

describe('accumulateWorkspaceDirtyDelta — nodes', () => {
  it('tracks a changed node without a redundant message delta', () => {
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
    expect('messageNodeIds' in d).toBe(false);
  });

  it('tracks a new node without a redundant message delta', () => {
    const prevProject = makeProject('ws1', []);
    const curProject  = makeProject('ws1', ['n2']);
    const n2 = makeNode('n2', 'ws1', { messages: [makeMsg('m1')] });
    const d = accumulateWorkspaceDirtyDelta(
      prevProject, curProject,
      {}, { n2 },
      emptyWorkspaceDirtyDelta(),
    );
    expect(d.nodeIds.has('n2')).toBe(true);
    expect('messageNodeIds' in d).toBe(false);
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

  it('workspaceChanged set when prev is undefined (new project)', () => {
    const cur = makeProject('ws1', []);
    const d = accumulateWorkspaceDirtyDelta(undefined, cur, {}, {}, emptyWorkspaceDirtyDelta());
    expect(d.workspaceChanged).toBe(true);
  });
});
