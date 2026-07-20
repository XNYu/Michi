import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
import { reconcileBackgroundWorkspaceSnapshot } from './backgroundGapReconcile';

function node(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'parent',
    projectId: 'ws-1',
    kind: 'chat',
    chatId: 'chat-parent',
    messages: [{ id: 'stale', role: 'assistant', text: 'stale local', toolCalls: [] }],
    followUps: [],
    status: 'streaming',
    ...overrides,
  };
}

const project: Project = {
  id: 'ws-1',
  name: 'Workspace',
  chatIds: ['parent'],
  edges: [],
  trees: [{ id: 'tree-1', rootNodeId: 'parent', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 'tree-1',
  artifacts: [],
  createdAt: 1,
};

function fullWorkspace(status: 'idle' | 'streaming' = 'idle') {
  return {
    workspace: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1', created_at: 1 },
    trees: [{
      id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'parent',
      created_at: 1, last_active_at: 2,
    }],
    nodes: [
      {
        id: 'parent', workspace_id: 'ws-1', tree_id: 'tree-1',
        acp_session_id: 'chat-parent', title: 'Canonical title', status, created_at: 1,
      },
      {
        id: 'child', workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: 'parent',
        acp_session_id: 'chat-child', title: 'Recovered branch', status: 'idle',
        spawned_by_agent: 1, created_at: 2,
      },
    ],
    edges: [{
      id: 'edge-1', workspace_id: 'ws-1', source_node_id: 'parent',
      target_node_id: 'child', kind: 'branch', created_at: 2,
    }],
    messages: [{
      id: 'assistant-durable', node_id: 'parent', role: 'assistant',
      content: 'durable answer', seq: 0, created_at: 3,
    }],
    artifacts: [{
      id: 'ctx-1', workspace_id: 'ws-1', name: 'recovered',
      file_path: '.artifacts/recovered.md', source: 'agent', type: 'doc',
      created_at: 2, updated_at: 3,
    }],
  };
}

describe('background durable-gap workspace reconciliation', () => {
  it('atomically restores canonical messages, graph and artifacts while keeping local compose state', () => {
    const local = node({
      composerDraft: { value: 'do not lose this draft', mentions: [] },
      pendingQueued: [{
        id: 'queued-1', value: 'queued', mentions: [], attachments: [], queuedAt: 4,
      }],
      lastAppliedTurnId: 'evicted-turn',
      lastAppliedSeq: 4,
      lastAppliedBackgroundTurnId: 'old-background-turn',
      lastAppliedBackgroundSeq: 3,
    });
    const unrelatedProject: Project = {
      ...project, id: 'ws-2', name: 'Other', chatIds: ['other'],
      trees: [{ id: 'tree-2', rootNodeId: 'other', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 'tree-2',
    };
    const result = reconcileBackgroundWorkspaceSnapshot({
      currentProjects: [project, unrelatedProject],
      currentNodes: { parent: local, other: node({ nodeId: 'other', projectId: 'ws-2', chatId: null }) },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: 'parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
    });

    expect(result).not.toBeNull();
    expect(result!.projects.find((candidate) => candidate.id === 'ws-2')).toBe(unrelatedProject);
    const recoveredProject = result!.projects.find((candidate) => candidate.id === 'ws-1')!;
    expect(recoveredProject.chatIds).toEqual(['parent', 'child']);
    expect(recoveredProject.edges).toEqual([
      expect.objectContaining({ source: 'parent', target: 'child', kind: 'branch' }),
    ]);
    expect(recoveredProject.artifacts).toEqual([
      expect.objectContaining({ id: 'ctx-1', name: 'recovered', source: 'agent' }),
    ]);
    expect(result!.nodes.child).toEqual(expect.objectContaining({
      chatId: 'child', spawnedByAgent: true, title: 'Recovered branch',
    }));
    expect(result!.nodes.parent.messages[0].blocks).toEqual([
      expect.objectContaining({ kind: 'answer', rawText: 'durable answer' }),
    ]);
    expect(result!.nodes.parent).toEqual(expect.objectContaining({
      status: 'idle',
      title: 'Canonical title',
      // A foreground turn may complete while the background feed is down.
      // Its durable replay cursor must survive a later background reconcile.
      lastAppliedTurnId: 'evicted-turn',
      lastAppliedSeq: 4,
      lastAppliedBackgroundTurnId: 'durable-turn',
      lastAppliedBackgroundSeq: 12,
      composerDraft: local.composerDraft,
      pendingQueued: local.pendingQueued,
    }));
    expect(result!.nodes.other).toBeDefined();
  });

  it('restores an active durable turn as streaming instead of leaving stale local status', () => {
    const result = reconcileBackgroundWorkspaceSnapshot({
      currentProjects: [project],
      currentNodes: { parent: node({ status: 'idle' }) },
      rawWorkspace: fullWorkspace('streaming'),
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'active-turn', seq: 7 },
    });

    expect(result!.nodes.parent.status).toBe('streaming');
    expect(result!.nodes.parent.messages.at(-1)?.streaming).toBe(true);
  });

  it('preserves unsynced local rename and newer context edits during reconciliation', () => {
    const localProject: Project = {
      ...project,
      artifacts: [{
        id: 'ctx-1', name: 'recovered', filePath: '.artifacts/local.md',
        source: 'user', createdAt: 2, updatedAt: 99,
      }],
    };
    const result = reconcileBackgroundWorkspaceSnapshot({
      currentProjects: [localProject],
      currentNodes: {
        parent: node({ title: 'Local rename', titleNeedsPersistence: true }),
      },
      rawWorkspace: fullWorkspace(),
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'durable-turn', seq: 12 },
    });

    expect(result!.nodes.parent).toEqual(expect.objectContaining({
      title: 'Local rename', titleNeedsPersistence: true,
    }));
    expect(result!.projects[0]!.artifacts?.[0]).toEqual(expect.objectContaining({
      id: 'ctx-1', filePath: '.artifacts/local.md', source: 'user', updatedAt: 99,
    }));
  });
});
