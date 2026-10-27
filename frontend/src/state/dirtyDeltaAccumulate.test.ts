import { describe, it, expect } from 'vitest';
import {
  accumulateWorkspaceDirtyDelta,
  emptyWorkspaceDirtyDelta,
  serializedEdgeId,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatNodeState, Project, ProjectEdge, Tree, ArtifactEntry } from './chatTypes';

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
});
