import { describe, it, expect } from 'vitest';
import {
  isNodeUnread,
  selectUnreadTotal,
  treeHasUnread,
  workspaceHasUnread,
} from './sidebarSelectors';
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

describe('isNodeUnread', () => {
  it('false when neither timestamp set', () => {
    expect(isNodeUnread(n({}), null)).toBe(false);
  });
  it('true when lastAssistantAt > viewedAt', () => {
    expect(isNodeUnread(n({ lastAssistantAt: 200, viewedAt: 100 }), null)).toBe(true);
  });
  it('false when viewedAt >= lastAssistantAt', () => {
    expect(isNodeUnread(n({ lastAssistantAt: 200, viewedAt: 200 }), null)).toBe(false);
  });
  it('false when node is the focused node (suppresses self-flash)', () => {
    expect(
      isNodeUnread(n({ nodeId: 'a', lastAssistantAt: 200, viewedAt: 100 }), 'a'),
    ).toBe(false);
  });
  it('false for digest nodes (excluded from thread unread)', () => {
    expect(
      isNodeUnread(n({ kind: 'digest', lastAssistantAt: 200, viewedAt: 100 }), null),
    ).toBe(false);
  });
});

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
  it('workspaceHasUnread iterates chatIds', () => {
    const nodes = {
      a: n({ nodeId: 'a', projectId: 'p1' }),
      b: n({ nodeId: 'b', projectId: 'p1' }),
      x: n({ nodeId: 'x', projectId: 'p1', lastAssistantAt: 5, viewedAt: 0 }),
    };
    expect(workspaceHasUnread(proj, nodes, null)).toBe(true);
  });
});
