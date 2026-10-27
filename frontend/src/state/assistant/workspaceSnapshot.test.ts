import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from '../chatTypes';
import { backendInstalledEntities, mergeWorkspaceSnapshot } from './workspaceSnapshot';

function raw(nodeIds: string[], settings: unknown = { system: 'assistant' }) {
  return {
    workspace: { id: 'sys', name: 'Assistant', created_at: 1, settings: JSON.stringify(settings) },
    trees: nodeIds.map((id, i) => ({ id: `t${i}`, root_node_id: id, last_active_at: i })),
    nodes: nodeIds.map((id, i) => ({ id, created_at: i })),
    edges: [],
    messages: nodeIds.map((id, i) => ({ id: `m${i}`, node_id: id, role: 'user', content: `hello ${id}`, seq: 0, created_at: i })),
  };
}

const user: Project = { id: 'a', name: 'A', chatIds: [], edges: [], createdAt: 1, trees: [], activeTreeId: null };

describe('mergeWorkspaceSnapshot', () => {
  it('adds a workspace the store has never seen, with its messages', () => {
    const merged = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    expect(merged.projects.map((p) => p.id)).toEqual(['a', 'sys']);
    expect(merged.projects[1].system).toBe('assistant');
    expect(merged.nodes.n1.messages.map((m) => m.text)).toEqual(['hello n1']);
    expect(merged.nodes.n1.messagesLoaded).not.toBe(false);
  });

  it('adds only the missing node after a reset and keeps live nodes untouched', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    const live = { ...first.nodes.n1, status: 'streaming' } as ChatNodeState;
    const merged = mergeWorkspaceSnapshot(first.projects, { n1: live }, raw(['n1', 'n2']))!;
    expect(merged.nodes.n1).toBe(live);
    expect(merged.nodes.n2.nodeId).toBe('n2');
    expect(merged.projects.find((p) => p.id === 'sys')!.chatIds).toEqual(['n1', 'n2']);
    expect(merged.projects.find((p) => p.id === 'sys')!.trees.map((t) => t.id)).toEqual(['t0', 't1']);
  });

  it('reconciles promoted helper page metadata on an existing live node without replacing local state', () => {
    const bound = raw(['helper']);
    (bound.nodes[0] as Record<string, unknown>).page_id = 'page-1';
    const first = mergeWorkspaceSnapshot([user], {}, bound)!;
    const held = {
      ...first.nodes.helper,
      status: 'streaming' as const,
      composerDraft: { value: 'keep typing', mentions: [] },
      deletedAt: 123,
      messages: [{ id: 'local-message', role: 'user' as const, text: 'local', toolCalls: [] }],
      pageId: 'page-1',
    };
    const promoted = raw(['helper']);
    (promoted.nodes[0] as Record<string, unknown>).page_id = null;
    const merged = mergeWorkspaceSnapshot(first.projects, { helper: held }, promoted)!;

    expect(merged.nodes.helper).not.toBe(held);
    expect(merged.nodes.helper.pageId).toBeNull();
    expect(merged.nodes.helper.status).toBe('streaming');
    expect(merged.nodes.helper.composerDraft).toEqual({ value: 'keep typing', mentions: [] });
    expect(merged.nodes.helper.messages).toBe(held.messages);
    expect(merged.nodes.helper.deletedAt).toBe(123);
  });

  it('retires a tree the backend archived and a node it deleted (a reset)', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    const reset = raw(['n1', 'n2']);
    reset.trees[0] = { ...reset.trees[0], archived_at: 50 } as typeof reset.trees[0];
    reset.nodes[0] = { ...reset.nodes[0], deleted_at: 60 } as typeof reset.nodes[0];
    const merged = mergeWorkspaceSnapshot(first.projects, first.nodes, reset)!;
    const sys = merged.projects.find((p) => p.id === 'sys')!;
    expect(sys.trees.find((t) => t.id === 't0')!.archivedAt).toBe(50);
    expect(merged.nodes.n1.deletedAt).toBe(60);
    expect(merged.nodes.n1.messages).toBe(first.nodes.n1.messages);
    expect(merged.nodes.n2.nodeId).toBe('n2');
  });

  it('follows the backend to the new tree when it archived the active one', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    const local = first.projects.map((p) => (p.id === 'sys' ? { ...p, activeTreeId: 't0' } : p));
    const reset = raw(['n1', 'n2']);
    reset.workspace = { ...reset.workspace, active_tree_id: 't1' } as typeof reset.workspace;
    reset.trees[0] = { ...reset.trees[0], archived_at: 50 } as typeof reset.trees[0];
    const merged = mergeWorkspaceSnapshot(local, first.nodes, reset)!;
    expect(merged.projects.find((p) => p.id === 'sys')!.activeTreeId).toBe('t1');
    // A live local choice stands.
    const kept = mergeWorkspaceSnapshot(local, first.nodes, { ...raw(['n1', 'n2']), workspace: { ...reset.workspace } })!;
    expect(kept.projects.find((p) => p.id === 'sys')!.activeTreeId).toBe('t0');
  });

  it('notices a newly archived tree even when nothing was added', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    const archived = raw(['n1']);
    archived.trees[0] = { ...archived.trees[0], archived_at: 50 } as typeof archived.trees[0];
    const merged = mergeWorkspaceSnapshot(first.projects, first.nodes, archived)!;
    expect(merged.projects).not.toBe(first.projects);
    expect(merged.projects.find((p) => p.id === 'sys')!.trees[0].archivedAt).toBe(50);
  });

  it('returns the inputs when nothing is new, and null for a non-workspace', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    const again = mergeWorkspaceSnapshot(first.projects, first.nodes, raw(['n1']))!;
    expect(again.projects).toBe(first.projects);
    expect(again.nodes).toBe(first.nodes);
    expect(mergeWorkspaceSnapshot([user], {}, { nope: true })).toBeNull();
  });
});

describe('mergeWorkspaceSnapshot with removals still on their way to the backend', () => {
  it('does not bring back a removed tree, its nodes, a removed edge or a node moved elsewhere', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    // Read before this window's removals reached the backend.
    const stale = raw(['n1', 'n2', 'n3', 'n4']);
    (stale.nodes as Array<Record<string, unknown>>).forEach((row, i) => { row.tree_id = `t${i}`; });
    (stale.nodes as Array<Record<string, unknown>>).push({ id: 'n2b', created_at: 9, tree_id: 't1' });
    stale.edges.push(
      { id: 'e1', workspace_id: 'sys', source_node_id: 'n2', target_node_id: 'n2b', kind: 'branch' } as never,
      { id: 'e2', workspace_id: 'sys', source_node_id: 'n1', target_node_id: 'n3', kind: 'merge' } as never,
    );
    const moved = { nodeId: 'n4', projectId: 'a', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle' } as ChatNodeState;
    const asked: Array<number | undefined> = [];
    const merged = mergeWorkspaceSnapshot(first.projects, { ...first.nodes, n4: moved }, stale, {
      pendingDeletes: (_local, readStartedAt) => {
        asked.push(readStartedAt);
        return { treeIds: new Set(['t1']), edgeIds: new Set(['merge-n1-n3']) };
      },
      readStartedAt: 1234,
    })!;
    // Asked about removals as of when the snapshot's read began.
    expect(asked).toEqual([1234]);
    const sys = merged.projects.find((p) => p.id === 'sys')!;
    expect(sys.trees.map((t) => t.id)).toEqual(['t0', 't2']);
    expect(sys.chatIds).toEqual(['n1', 'n3']);
    expect(merged.nodes.n2).toBeUndefined();
    expect(merged.nodes.n2b).toBeUndefined();
    expect(merged.nodes.n4).toBe(moved);
    expect(sys.edges).toEqual([]);
  });
});

describe('mergeWorkspaceSnapshot for a workspace new to the store', () => {
  it('leaves out nodes another workspace holds, and trees rooted on them', () => {
    const snapshot = raw(['n1', 'n2', 'n3']);
    (snapshot.nodes as Array<Record<string, unknown>>).forEach((row, i) => { row.tree_id = `t${i}`; });
    (snapshot.nodes as Array<Record<string, unknown>>).push({ id: 'n2b', created_at: 9, tree_id: 't1' });
    (snapshot.workspace as Record<string, unknown>).active_tree_id = 't1';
    snapshot.edges.push(
      { id: 'e1', workspace_id: 'sys', source_node_id: 'n1', target_node_id: 'n3', kind: 'merge' } as never,
      { id: 'e2', workspace_id: 'sys', source_node_id: 'n1', target_node_id: 'n2', kind: 'merge' } as never,
    );
    // n2's tree was moved to workspace a (the snapshot predates it); n3 alone too.
    const held = (nodeId: string) => ({ nodeId, projectId: 'a', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle' } as ChatNodeState);
    const local: Project = { ...user, chatIds: ['n2', 'n2b', 'n3'], trees: [{ id: 't1', rootNodeId: 'n2', createdAt: 1, lastActiveAt: 1 }] };
    const nodes = { n2: held('n2'), n2b: held('n2b'), n3: { ...held('n3'), title: 'Mine' } };
    const merged = mergeWorkspaceSnapshot([local], nodes, snapshot)!;
    const sys = merged.projects.find((p) => p.id === 'sys')!;
    expect(sys.chatIds).toEqual(['n1']);
    expect(sys.trees.map((t) => t.id)).toEqual(['t0']);
    expect(sys.edges).toEqual([]);
    // Its active tree went with the move: the one left takes over.
    expect(sys.activeTreeId).toBe('t0');
    // What another workspace holds is that workspace's.
    expect(merged.nodes.n2).toBe(nodes.n2);
    expect(merged.nodes.n2b).toBe(nodes.n2b);
    expect(merged.nodes.n3).toBe(nodes.n3);
    expect(merged.nodes.n1?.projectId).toBe('sys');
    for (const nodeId of ['n2', 'n2b', 'n3']) {
      expect(merged.projects.filter((p) => p.chatIds.includes(nodeId)).map((p) => p.id)).toEqual(['a']);
    }
  });
});

describe('backendInstalledEntities', () => {
  it('names a new workspace whole, and only what is new in a known one', () => {
    const first = mergeWorkspaceSnapshot([user], {}, raw(['n1']))!;
    expect(backendInstalledEntities([user], {}, first)).toEqual({
      projectId: 'sys', newProject: true, nodeIds: ['n1'], treeIds: ['t0'], edgeIds: [],
    });
    const second = mergeWorkspaceSnapshot(first.projects, first.nodes, raw(['n1', 'n2']))!;
    expect(backendInstalledEntities(first.projects, first.nodes, second)).toEqual({
      projectId: 'sys', newProject: false, nodeIds: ['n2'], treeIds: ['t1'], edgeIds: [],
    });
    const again = mergeWorkspaceSnapshot(second.projects, second.nodes, raw(['n1', 'n2']))!;
    expect(backendInstalledEntities(second.projects, second.nodes, again)).toBeNull();
  });
});
