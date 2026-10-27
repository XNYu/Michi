import { describe, it, expect } from 'vitest';
import { selectUnreadTotal, treeHasUnread } from './sidebarSelectors';
import type { ChatNodeState, Project, Tree, ProjectEdge } from './chatTypes';

function n(over: Partial<ChatNodeState>): ChatNodeState {
  return {
    nodeId: 'x',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...over,
  };
}

describe('selectUnreadTotal', () => {
  it('counts only chat nodes that are unread and not focused', () => {
    const nodes = {
      a: n({ nodeId: 'a', lastAssistantAt: 5, viewedAt: 1 }),
      b: n({ nodeId: 'b', lastAssistantAt: 5, viewedAt: 5 }),
      c: n({ nodeId: 'c', lastAssistantAt: 5, viewedAt: 1 }),
      d: n({ nodeId: 'd', kind: 'digest', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(selectUnreadTotal(nodes, null)).toBe(2);
    expect(selectUnreadTotal(nodes, 'a')).toBe(1);
  });

  it('leaves out nodes of the hidden workspaces (the assistant\'s)', () => {
    const nodes = {
      a: n({ nodeId: 'a', lastAssistantAt: 5, viewedAt: 1 }),
      s: n({ nodeId: 's', projectId: 'sys', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(selectUnreadTotal(nodes, null)).toBe(2);
    expect(selectUnreadTotal(nodes, null, new Set(['sys']))).toBe(1);
  });

  it('leaves out Meta agent maintenance runs, which no conversation list shows', () => {
    const nodes = {
      a: n({ nodeId: 'a', lastAssistantAt: 5, viewedAt: 1 }),
      run: n({ nodeId: 'run', lastAssistantAt: 5, viewedAt: 1, maintenanceJobId: 'job-maint' }),
      run2: n({ nodeId: 'run2', lastAssistantAt: 6, viewedAt: 1, maintenanceJobId: 'job-maint' }),
    };
    expect(selectUnreadTotal(nodes, null)).toBe(1);
    expect(treeHasUnread({ rootNodeId: 'run' }, [{ source: 'run', target: 'run2', kind: 'branch' } as ProjectEdge], nodes, null)).toBe(false);
  });
});

describe('treeHasUnread / workspaceHasUnread', () => {
  // Tree uses rootNodeId + edges (not nodeIds). treeHasUnread accepts edges as 4th param.
  const edges: ProjectEdge[] = [
    { source: 'a', target: 'b' },
  ];
  const tree: Tree = { id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 0 };
  const proj: Project = {
    id: 'p1', name: 'P', chatIds: ['a', 'b', 'x'], edges,
    createdAt: 0, trees: [tree], activeTreeId: 't1',
  };
  it('treeHasUnread true when any node in tree subtree is unread', () => {
    const nodes = {
      a: n({ nodeId: 'a', projectId: 'p1', lastAssistantAt: 5, viewedAt: 5 }),
      b: n({ nodeId: 'b', projectId: 'p1', lastAssistantAt: 5, viewedAt: 1 }),
    };
    expect(treeHasUnread(tree, edges, nodes, null)).toBe(true);
  });
});
