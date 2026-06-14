import { describe, it, expect } from 'vitest';
import {
  serializeWorkspaceForSync,
  serializeWorkspaceDelta,
  emptyWorkspaceDirtyDelta,
  type WorkspaceDirtyDelta,
} from './workspacePersistence';
import type { ChatMessage, ChatNodeState, Project } from './chatTypes';

// ---------------------------------------------------------------------------
// Minimal fixture builders (mirrors persistence.branchAnchor.test.ts)
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

// ---------------------------------------------------------------------------
// serializeWorkspaceDelta — only-dirty-entities emission
// ---------------------------------------------------------------------------

describe('serializeWorkspaceDelta — scoping', () => {
  it('emits mode:delta and only the dirty node, nothing else', () => {
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch' }],
      contexts: [{ id: 'c1', name: 'c', filePath: '/c', source: 'user', createdAt: 1, updatedAt: 1 }],
    });
    const nodes = { n1: makeNode('n1', 'ws1', { title: 'changed' }), n2: makeNode('n2', 'ws1') };

    const delta = serializeWorkspaceDelta(project, nodes, makeDirty({ nodeIds: ['n1'] }));

    expect(delta.mode).toBe('delta');
    expect(delta.upserts.nodes).toHaveLength(1);
    expect(delta.upserts.nodes![0].id).toBe('n1');
    // No edges/trees/contexts/messages, no deletes, no reconcile set.
    expect(delta.upserts.edges).toBeUndefined();
    expect(delta.upserts.trees).toBeUndefined();
    expect(delta.upserts.contexts).toBeUndefined();
    expect(delta.upserts.messages).toBeUndefined();
    expect(delta.deletes.edges).toBeUndefined();
    expect(delta.messageReconcileNodeIds).toBeUndefined();
    expect(delta.workspace).toBeUndefined();
  });

  it('omits the workspace row unless workspaceChanged', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };

    const without = serializeWorkspaceDelta(project, nodes, makeDirty({ nodeIds: ['n1'] }));
    expect(without.workspace).toBeUndefined();

    const withWs = serializeWorkspaceDelta(project, nodes, makeDirty({ workspaceChanged: true }));
    expect(withWs.workspace).toBeDefined();
    expect(withWs.workspace!.id).toBe('ws1');
    expect(withWs.workspace!.name).toBe('Test');
  });

  it('drops a dirty node id that no longer exists in chatIds', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };

    // n2 was removed from the project; the delta must not carry its row.
    const delta = serializeWorkspaceDelta(project, nodes, makeDirty({ nodeIds: ['n1', 'n2'] }));
    expect(delta.upserts.nodes!.map((n) => n.id)).toEqual(['n1']);
  });
});

// ---------------------------------------------------------------------------
// Message-set changes
// ---------------------------------------------------------------------------

describe('serializeWorkspaceDelta — messages', () => {
  it('message-set change puts FULL messages in upserts + node in reconcile set; node row present', () => {
    const messages = [makeMessage('m1'), makeMessage('m2')];
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { messages }) };

    const delta = serializeWorkspaceDelta(project, nodes, makeDirty({ messageNodeIds: ['n1'] }));

    // All messages for n1 present.
    expect(delta.upserts.messages!.map((m) => m.id)).toEqual(['m1', 'm2']);
    // Node listed in reconcile set.
    expect(delta.messageReconcileNodeIds).toEqual(['n1']);
    // The node row is present even though only messages changed (upsert+reconcile together).
    expect(delta.upserts.nodes!.map((n) => n.id)).toEqual(['n1']);
  });

  it('node row shape matches serializeWorkspaceForSync for the same node', () => {
    const messages = [makeMessage('m1')];
    const project = makeProject('ws1', ['n1'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm-a', createdAt: 5 }],
    });
    const nodes = {
      n1: makeNode('n1', 'ws1', {
        messages,
        title: 'Node One',
        parentNodeId: 'p0',
        followUpsSourceMessageId: 'm-src',
      }),
    };

    const full = serializeWorkspaceForSync(project, nodes);
    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({ nodeIds: ['n1'], messageNodeIds: ['n1'] }),
    );

    const fullNode = full.nodes[0]!;
    const deltaNode = delta.upserts.nodes![0];

    // Assert key fields are identical across the two paths.
    for (const key of [
      'id', 'workspace_id', 'tree_id', 'parent_node_id', 'kind', 'title',
      'status', 'follow_ups_source_message_id', 'acp_session_id', 'created_at',
    ] as const) {
      expect((deltaNode as Record<string, unknown>)[key]).toEqual(
        (fullNode as Record<string, unknown>)[key],
      );
    }

    // And the message rows match too.
    expect(delta.upserts.messages).toEqual(
      full.messages.filter((m) => m.node_id === 'n1'),
    );
  });

  it('node trimmed to zero messages: id in reconcile set, no messages emitted for it', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { messages: [] }) };

    const delta = serializeWorkspaceDelta(project, nodes, makeDirty({ messageNodeIds: ['n1'] }));

    expect(delta.messageReconcileNodeIds).toEqual(['n1']);
    // No messages for n1 (upserts.messages omitted entirely when nothing to send).
    expect(delta.upserts.messages).toBeUndefined();
    // Node row still present so its upsert lands alongside the wipe-reconcile.
    expect(delta.upserts.nodes!.map((n) => n.id)).toEqual(['n1']);
  });

  it('skips a streaming assistant message exactly like the full serializer', () => {
    const messages = [
      makeMessage('m1'),
      makeMessage('m-stream', { role: 'assistant', streaming: true, blocks: [], thought: undefined }),
      makeMessage('m2'),
    ];
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1', { messages }) };

    const full = serializeWorkspaceForSync(project, nodes);
    const delta = serializeWorkspaceDelta(project, nodes, makeDirty({ messageNodeIds: ['n1'] }));

    // Streaming message dropped in both; non-streaming kept.
    expect(full.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(delta.upserts.messages!.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

// ---------------------------------------------------------------------------
// Upserts / deletes for edges, trees, contexts
// ---------------------------------------------------------------------------

describe('serializeWorkspaceDelta — edges/trees/contexts', () => {
  it('added/changed edge → upserts.edges; removed edge → deletes.edges', () => {
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm-a' }],
    });
    const nodes = { n1: makeNode('n1', 'ws1'), n2: makeNode('n2', 'ws1') };

    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({
        edgeUpsertIds: ['branch-n1-n2'],
        edgeDeleteIds: ['branch-n2-n1'], // a removed edge no longer in project.edges
      }),
    );

    expect(delta.upserts.edges).toHaveLength(1);
    expect(delta.upserts.edges![0].id).toBe('branch-n1-n2');
    expect(delta.upserts.edges![0].anchor_message_id).toBe('m-a');
    expect(delta.deletes.edges).toEqual(['branch-n2-n1']);
  });

  it('added/changed tree → upserts.trees; removed tree → deletes.trees', () => {
    const project = makeProject('ws1', ['n1'], {
      trees: [
        { id: 't1', rootNodeId: 'n1', createdAt: 1, lastActiveAt: 1 },
        { id: 't2', rootNodeId: 'n1', name: 'second', createdAt: 1, lastActiveAt: 1 },
      ],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({ treeUpsertIds: ['t2'], treeDeleteIds: ['t-old'] }),
    );

    expect(delta.upserts.trees!.map((t) => t.id)).toEqual(['t2']);
    expect(delta.upserts.trees![0].name).toBe('second');
    expect(delta.deletes.trees).toEqual(['t-old']);
  });

  it('added/changed context → upserts.contexts; removed context → deletes.contexts', () => {
    const project = makeProject('ws1', ['n1'], {
      contexts: [{ id: 'c1', name: 'ctx', filePath: '/c1', source: 'user', createdAt: 1, updatedAt: 2 }],
    });
    const nodes = { n1: makeNode('n1', 'ws1') };

    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({ contextUpsertIds: ['c1'], contextDeleteIds: ['c-old'] }),
    );

    expect(delta.upserts.contexts!.map((c) => c.id)).toEqual(['c1']);
    expect(delta.upserts.contexts![0].file_path).toBe('/c1');
    expect(delta.deletes.contexts).toEqual(['c-old']);
  });

  it('edge/tree/context rows are identical to the full serializer for the same entity', () => {
    const project = makeProject('ws1', ['n1', 'n2'], {
      edges: [{ source: 'n1', target: 'n2', kind: 'branch', anchorMessageId: 'm-a', createdAt: 7 }],
      contexts: [{ id: 'c1', name: 'ctx', filePath: '/c1', size: 9, autoInject: true, source: 'user', createdAt: 1, updatedAt: 2 }],
    });
    const nodes = { n1: makeNode('n1', 'ws1'), n2: makeNode('n2', 'ws1') };

    const full = serializeWorkspaceForSync(project, nodes);
    const delta = serializeWorkspaceDelta(
      project,
      nodes,
      makeDirty({
        edgeUpsertIds: ['branch-n1-n2'],
        treeUpsertIds: ['t1'],
        contextUpsertIds: ['c1'],
      }),
    );

    expect(delta.upserts.edges![0]).toEqual(full.edges[0]);
    expect(delta.upserts.trees![0]).toEqual(full.trees[0]);
    expect(delta.upserts.contexts![0]).toEqual(full.contexts[0]);
  });
});

// ---------------------------------------------------------------------------
// Empty delta — clean omission
// ---------------------------------------------------------------------------

describe('serializeWorkspaceDelta — empty', () => {
  it('an empty dirty set produces an empty (but well-formed) delta', () => {
    const project = makeProject('ws1', ['n1']);
    const nodes = { n1: makeNode('n1', 'ws1') };

    const delta = serializeWorkspaceDelta(project, nodes, emptyWorkspaceDirtyDelta());

    expect(delta.mode).toBe('delta');
    expect(delta.upserts).toEqual({});
    expect(delta.deletes).toEqual({});
    expect(delta.workspace).toBeUndefined();
    expect(delta.messageReconcileNodeIds).toBeUndefined();
  });
});
