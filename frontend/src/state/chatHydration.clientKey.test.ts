import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatNodeState, Project } from './chatTypes';
import { applyTreeMessages, carryClientKeys } from './chatHydration';
import { reconcileBackgroundWorkspaceSnapshot } from './backgroundGapReconcile';

// A realigned turn: its rows carry the ids they were first rendered under.
const realigned: ChatMessage[] = [
  { id: 'u-earlier', role: 'user', text: 'earlier', toolCalls: [] },
  { id: 'u-a-server', clientKey: 'u-a-local', role: 'user', text: 'hi', toolCalls: [] },
  { id: 'a-server', clientKey: 'a-local', role: 'assistant', text: 'local', toolCalls: [] },
];

const fromServer = (): ChatMessage[] => [
  { id: 'u-earlier', role: 'user', text: 'earlier', toolCalls: [] },
  { id: 'u-a-server', role: 'user', text: 'hi', toolCalls: [] },
  { id: 'a-server', role: 'assistant', text: 'durable answer', toolCalls: [] },
];

function node(messages: ChatMessage[]): ChatNodeState {
  return { nodeId: 'parent', projectId: 'ws-1', kind: 'chat', chatId: 'chat-parent', messages, followUps: [], status: 'idle' };
}

describe('clientKey across server replacements', () => {
  it('carries each realigned row its first render key by id', () => {
    const next = carryClientKeys(realigned, fromServer());
    expect(next.map((m) => m.clientKey)).toEqual([undefined, 'u-a-local', 'a-local']);
    expect(next[2].text).toBe('durable answer');
  });

  it('returns the server list itself when there is nothing to carry', () => {
    const server = fromServer();
    expect(carryClientKeys(server, server)).toBe(server);
    expect(carryClientKeys(undefined, server)).toBe(server);
  });

  it('keeps the keys when fetched bodies are installed', () => {
    const nodes = applyTreeMessages({ parent: node(realigned) }, { parent: fromServer() });
    expect(nodes.parent.messages.map((m) => m.clientKey)).toEqual([undefined, 'u-a-local', 'a-local']);
  });

  it('keeps the keys when a background replay gap installs the workspace snapshot', () => {
    const project: Project = {
      id: 'ws-1', name: 'Workspace', chatIds: ['parent'], edges: [], artifacts: [], createdAt: 1,
      trees: [{ id: 'tree-1', rootNodeId: 'parent', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree-1',
    };
    const rawWorkspace = {
      workspace: { id: 'ws-1', name: 'Workspace', active_tree_id: 'tree-1', created_at: 1 },
      trees: [{ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'parent', created_at: 1, last_active_at: 2 }],
      nodes: [{ id: 'parent', workspace_id: 'ws-1', tree_id: 'tree-1', acp_session_id: 'chat-parent', status: 'idle', created_at: 1 }],
      edges: [],
      messages: [
        { id: 'u-a-server', node_id: 'parent', role: 'user', content: 'hi', seq: 0, created_at: 2 },
        { id: 'a-server', node_id: 'parent', role: 'assistant', content: 'durable answer', seq: 1, created_at: 3 },
      ],
      artifacts: [],
    };
    const result = reconcileBackgroundWorkspaceSnapshot({
      currentProjects: [project],
      currentNodes: { parent: node(realigned) },
      rawWorkspace,
      gap: { chatId: 'chat-parent', nodeId: 'parent', turnId: 'turn-1', seq: 4 },
    });
    expect(result!.nodes.parent.messages.map((m) => [m.id, m.clientKey])).toEqual([
      ['u-a-server', 'u-a-local'],
      ['a-server', 'a-local'],
    ]);
  });
});
