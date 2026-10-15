import { describe, it, expect } from 'vitest';
import { buildContinueItems, continueItemsEqual } from './homeContinue';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId, chatId: null, projectId: 'p1', kind: 'chat',
    title: nodeId, messages: [], followUps: [], status: 'idle',
    ...extra,
  } as ChatNodeState;
}

function fixture() {
  const nodes: Record<string, ChatNodeState> = {
    a: node('a', { title: 'Alpha' }),
    a1: node('a1'),
    a2: node('a2'),
    a2x: node('a2x'),
    b: node('b', { title: 'Beta' }),
    c: node('c', { title: 'Gamma', projectId: 'p2' }),
    d: node('d', { title: 'Digest of a' }),
  };
  const projects: Project[] = [
    {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 'tA',
      chatIds: ['a', 'a1', 'a2', 'a2x', 'b', 'd'],
      edges: [
        { source: 'a', target: 'a1', kind: 'branch' },
        { source: 'a', target: 'a2' },
        { source: 'a2', target: 'a2x', kind: 'branch' },
        // Not a branch: must not count toward the thread's branches.
        { source: 'a', target: 'd', kind: 'digest' },
      ],
      trees: [
        { id: 'tA', rootNodeId: 'a', createdAt: 0, lastActiveAt: 100 },
        { id: 'tB', rootNodeId: 'b', createdAt: 0, lastActiveAt: 300, name: 'Named beta' },
      ],
    },
    {
      id: 'p2', name: 'Two', createdAt: 0, activeTreeId: 'tC',
      chatIds: ['c'], edges: [],
      trees: [{ id: 'tC', rootNodeId: 'c', createdAt: 0, lastActiveAt: 200 }],
    },
  ] as Project[];
  return { nodes, projects };
}

describe('buildContinueItems', () => {
  it('lists the newest threads across every workspace, newest first', () => {
    const { nodes, projects } = fixture();
    const items = buildContinueItems(projects, nodes, null, 6);
    expect(items.map((i) => i.id)).toEqual(['tB', 'tC', 'tA']);
    expect(items.map((i) => i.projectName)).toEqual(['One', 'Two', 'One']);
  });

  it('prefers the tree name, then the root title', () => {
    const { nodes, projects } = fixture();
    const items = buildContinueItems(projects, nodes, null, 6);
    expect(items[0].label).toBe('Named beta');
    expect(items[1].label).toBe('Gamma');
  });

  it('counts live branch descendants and ignores non-branch edges', () => {
    const { nodes, projects } = fixture();
    const alpha = buildContinueItems(projects, nodes, null, 6).find((i) => i.id === 'tA')!;
    expect(alpha.branches).toBe(3);

    nodes.a2 = node('a2', { deletedAt: 1 });
    const pruned = buildContinueItems(projects, nodes, null, 6).find((i) => i.id === 'tA')!;
    // a2 is in Trash, and a2x is only reachable through it.
    expect(pruned.branches).toBe(1);
  });

  it('reports streaming over unread, and treats the focused node as read', () => {
    const { nodes, projects } = fixture();
    nodes.a1 = node('a1', { lastAssistantAt: 10, viewedAt: 0 });
    expect(buildContinueItems(projects, nodes, null, 6).find((i) => i.id === 'tA')!.status).toBe('unread');
    expect(buildContinueItems(projects, nodes, 'a1', 6).find((i) => i.id === 'tA')!.status).toBe('idle');

    nodes.a2x = node('a2x', { status: 'streaming' });
    expect(buildContinueItems(projects, nodes, null, 6).find((i) => i.id === 'tA')!.status).toBe('streaming');
  });

  it('skips archived threads, trashed roots, and archived or deleted workspaces', () => {
    const { nodes, projects } = fixture();
    projects[0].trees[1].archivedAt = 1;
    nodes.a = node('a', { deletedAt: 1 });
    expect(buildContinueItems(projects, nodes, null, 6).map((i) => i.id)).toEqual(['tC']);

    projects[1].archivedAt = 1;
    expect(buildContinueItems(projects, nodes, null, 6)).toEqual([]);
  });

  it('honours the limit', () => {
    const { nodes, projects } = fixture();
    expect(buildContinueItems(projects, nodes, null, 2).map((i) => i.id)).toEqual(['tB', 'tC']);
  });
});

describe('continueItemsEqual', () => {
  it('is true for the same rows rebuilt and false once a visible field changes', () => {
    const { nodes, projects } = fixture();
    const a = buildContinueItems(projects, nodes, null, 6);
    const b = buildContinueItems(projects, nodes, null, 6);
    expect(a).not.toBe(b);
    expect(continueItemsEqual(a, b)).toBe(true);

    nodes.b = node('b', { status: 'streaming' });
    expect(continueItemsEqual(a, buildContinueItems(projects, nodes, null, 6))).toBe(false);
    expect(continueItemsEqual(a, a.slice(0, 2))).toBe(false);
  });
});
