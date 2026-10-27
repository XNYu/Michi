import { describe, expect, it } from 'vitest';
import type { ChatNodeState, Project } from './chatTypes';
import { installBackendWorkspaceNode } from './backgroundGapReconcile';
import { visibleMessageText } from './assistantBlocks';

const localProject: Project = {
  id: 'ws-1',
  name: 'Workspace',
  chatIds: ['existing'],
  edges: [],
  trees: [{ id: 'tree-existing', rootNodeId: 'existing', createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: 'tree-existing',
  artifacts: [],
  createdAt: 1,
};

const existingNode: ChatNodeState = {
  nodeId: 'existing',
  projectId: 'ws-1',
  kind: 'chat',
  chatId: 'existing',
  messages: [],
  followUps: [],
  status: 'idle',
  composerDraft: { value: 'unsent text', mentions: [] },
};

function workspace(scheduledStatus: 'idle' | 'streaming', assistantText: string) {
  return {
    workspace: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-existing', created_at: 1 },
    trees: [
      { id: 'tree-existing', workspace_id: 'ws-1', root_node_id: 'existing', created_at: 1, last_active_at: 1 },
      { id: 'tree-sched', workspace_id: 'ws-1', root_node_id: 'sched', created_at: 5, last_active_at: 5 },
    ],
    nodes: [
      { id: 'existing', workspace_id: 'ws-1', tree_id: 'tree-existing', acp_session_id: 'existing', status: 'idle', created_at: 1 },
      {
        id: 'sched', workspace_id: 'ws-1', tree_id: 'tree-sched', acp_session_id: 'native-1',
        title: 'Digest · Oct 16, 09:00', status: scheduledStatus, created_at: 5,
        last_applied_turn_id: 'turn-1', last_applied_seq: 7,
      },
    ],
    edges: [],
    messages: [
      { id: 'u-1', node_id: 'sched', role: 'user', content: 'Summarize', seq: 0, created_at: 5 },
      { id: 'self-sched-turn-1', node_id: 'sched', role: 'assistant', content: assistantText, seq: 1, created_at: 6 },
    ],
    artifacts: [],
  };
}

describe('installBackendWorkspaceNode', () => {
  it('adds a backend-created thread without moving the active thread', () => {
    const result = installBackendWorkspaceNode({
      currentProjects: [localProject],
      currentNodes: { existing: existingNode },
      rawWorkspace: workspace('streaming', 'partial'),
      nodeId: 'sched',
    });
    expect(result).not.toBeNull();
    const project = result!.projects[0];
    expect(project.activeTreeId).toBe('tree-existing');
    expect(project.trees.map((tree) => tree.id).sort()).toEqual(['tree-existing', 'tree-sched']);
    expect(project.chatIds).toContain('sched');
    const node = result!.nodes.sched;
    expect(node.status).toBe('streaming');
    expect(node.chatId).toBe('sched');
    expect(node.messagesLoaded).toBe(true);
    expect(node.lastAppliedBackgroundTurnId).toBe('turn-1');
    expect(node.lastAppliedBackgroundSeq).toBe(7);
    expect(node.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Untouched local node keeps its unsent draft.
    expect(result!.nodes.existing.composerDraft).toEqual({ value: 'unsent text', mentions: [] });
  });

  it('refreshes a known thread with the final transcript and keeps local drafts', () => {
    const first = installBackendWorkspaceNode({
      currentProjects: [localProject],
      currentNodes: { existing: existingNode },
      rawWorkspace: workspace('streaming', 'partial'),
      nodeId: 'sched',
    })!;
    const withDraft = { ...first.nodes, sched: { ...first.nodes.sched, composerDraft: { value: 'follow-up', mentions: [] } } };
    const refreshed = installBackendWorkspaceNode({
      currentProjects: first.projects,
      currentNodes: withDraft,
      rawWorkspace: workspace('idle', 'final answer'),
      nodeId: 'sched',
    })!;
    const node = refreshed.nodes.sched;
    expect(node.status).toBe('idle');
    expect(visibleMessageText(node.messages.at(-1)!)).toContain('final answer');
    expect(node.composerDraft).toEqual({ value: 'follow-up', mentions: [] });
  });

  it('returns null when the workspace or node is not known locally', () => {
    expect(installBackendWorkspaceNode({
      currentProjects: [], currentNodes: {}, rawWorkspace: workspace('idle', 'x'), nodeId: 'sched',
    })).toBeNull();
    expect(installBackendWorkspaceNode({
      currentProjects: [localProject], currentNodes: {}, rawWorkspace: workspace('idle', 'x'), nodeId: 'missing',
    })).toBeNull();
  });
});
