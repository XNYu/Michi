import { collectCrossTreeGroups, EMPTY_CROSS_TREE_GROUPS, CROSS_TREE_MENTION_CAP } from './crossTreeMentions';
import type { ChatNodeState, Project, Tree } from '../state/chatTypes';

const mkNode = (nodeId: string, title: string, msgCount: number, parentNodeId?: string): ChatNodeState => ({
  nodeId,
  kind: 'chat',
  chatId: `chat-${nodeId}`,
  projectId: 'p1',
  parentNodeId,
  messages: Array.from({ length: msgCount }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `msg ${i}`,
    toolCalls: [],
  })),
  followUps: [],
  title,
  status: 'idle',
});

const mkTree = (id: string, rootNodeId: string, lastActiveAt: number, extra: Partial<Tree> = {}): Tree => ({
  id, rootNodeId, createdAt: 1, lastActiveAt, ...extra,
});

/** Two threads: A (root a1, child a2) more recent than B (root b1). */
function fixture() {
  const nodes: Record<string, ChatNodeState> = {
    a1: mkNode('a1', 'A root', 2),
    a2: mkNode('a2', 'A child', 1, 'a1'),
    b1: mkNode('b1', 'B root', 3),
  };
  const project: Project = {
    id: 'p1',
    name: 'P',
    chatIds: ['a1', 'a2', 'b1'],
    edges: [{ source: 'a1', target: 'a2' }],
    createdAt: 1,
    trees: [mkTree('tA', 'a1', 200), mkTree('tB', 'b1', 100)],
    activeTreeId: 'tA',
  };
  return { nodes, project };
}

describe('collectCrossTreeGroups', () => {
  it('excludes the given tree and orders the rest by lastActiveAt desc', () => {
    const { nodes, project } = fixture();
    const groups = collectCrossTreeGroups(nodes, project, 'tB');
    expect(groups.map((g) => g.treeTitle)).toEqual(['A root']);
    expect(groups[0].nodes.map((n) => n.nodeId)).toEqual(['a1', 'a2']);
  });

  it('includes every thread when excludeTreeId is null (Home composer)', () => {
    const { nodes, project } = fixture();
    const groups = collectCrossTreeGroups(nodes, project, null);
    expect(groups.map((g) => g.treeTitle)).toEqual(['A root', 'B root']);
  });

  it('skips archived trees, deleted nodes and empty nodes', () => {
    const { nodes, project } = fixture();
    const archived = { ...project, trees: [project.trees[0], mkTree('tB', 'b1', 100, { archivedAt: 5 })] };
    const withDeleted = { ...nodes, a2: { ...nodes.a2, deletedAt: 9 } };
    const groups = collectCrossTreeGroups(withDeleted, archived, null);
    expect(groups.map((g) => g.treeTitle)).toEqual(['A root']);
    expect(groups[0].nodes.map((n) => n.nodeId)).toEqual(['a1']);
  });

  it('returns the shared empty reference when nothing qualifies', () => {
    const { nodes, project } = fixture();
    expect(collectCrossTreeGroups(nodes, { ...project, trees: [] }, null)).toBe(EMPTY_CROSS_TREE_GROUPS);
  });

  it('caps total candidates at CROSS_TREE_MENTION_CAP', () => {
    const nodes: Record<string, ChatNodeState> = {};
    const chatIds: string[] = [];
    const trees: Tree[] = [];
    for (let i = 0; i < CROSS_TREE_MENTION_CAP + 10; i += 1) {
      const id = `r${i}`;
      nodes[id] = mkNode(id, `Root ${i}`, 1);
      chatIds.push(id);
      trees.push(mkTree(`t${i}`, id, i));
    }
    const project: Project = { id: 'p1', name: 'P', chatIds, edges: [], createdAt: 1, trees, activeTreeId: null };
    const groups = collectCrossTreeGroups(nodes, project, null);
    const total = groups.reduce((n, g) => n + g.nodes.length, 0);
    expect(total).toBe(CROSS_TREE_MENTION_CAP);
    // Most recently active thread comes first.
    expect(groups[0].treeTitle).toBe(`Root ${CROSS_TREE_MENTION_CAP + 9}`);
  });
});
