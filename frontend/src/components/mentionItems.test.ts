import { buildAtMentionItems } from './mentionItems';
import type { CrossTreeGroup } from './mentionItems';
import type { ArtifactEntry, ChatNodeState } from '../state/chatTypes';

const mkCtx = (id: string, name: string): ArtifactEntry => ({
  id, name, filePath: `docs/${name}.md`, source: 'user', createdAt: 1000, updatedAt: 1000,
});

const mkNode = (nodeId: string, title: string, msgCount: number): ChatNodeState => ({
  nodeId,
  kind: 'chat',
  chatId: `chat-${nodeId}`,
  projectId: 'p1',
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

describe('buildAtMentionItems', () => {
  const contexts = [mkCtx('c1', 'api-spec'), mkCtx('c2', 'conventions')];
  const nodes = [mkNode('n1', 'Research thread', 3), mkNode('n2', 'Design doc', 1)];

  it('returns both contexts and nodes with empty query', () => {
    const items = buildAtMentionItems('', contexts, nodes, 'other');
    expect(items.length).toBe(4);
    expect(items.filter(i => i.kind === 'context')).toHaveLength(2);
    expect(items.filter(i => i.kind === 'node')).toHaveLength(2);
  });

  it('filters by query', () => {
    const items = buildAtMentionItems('api', contexts, nodes, 'other');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('api-spec');
  });

  it('excludes the current node', () => {
    const items = buildAtMentionItems('', contexts, nodes, 'n1');
    const nodeItems = items.filter(i => i.kind === 'node');
    expect(nodeItems).toHaveLength(1);
    expect(nodeItems[0].id).toBe('node-n2');
  });

  it('excludes nodes with no messages', () => {
    const emptyNode = mkNode('n3', 'Empty', 0);
    const items = buildAtMentionItems('', [], [emptyNode], 'other');
    expect(items.filter(i => i.kind === 'node')).toHaveLength(0);
  });

  it('node token uses node:nodeId format', () => {
    const items = buildAtMentionItems('Research', [], nodes, 'other');
    expect(items[0].token).toBe('node:n1');
  });
});

describe('buildAtMentionItems — cross-tree nodes', () => {
  const crossTreeNodes: CrossTreeGroup[] = [
    {
      treeTitle: 'API Research',
      nodes: [mkNode('x1', 'Auth flow', 4), mkNode('x2', 'Rate limiting', 2)],
    },
    {
      treeTitle: 'Deployment',
      nodes: [mkNode('x3', 'CDK setup', 5)],
    },
  ];

  it('includes cross-tree nodes after same-tree nodes', () => {
    const sameTree = [mkNode('n1', 'Local node', 1)];
    const items = buildAtMentionItems('', [], sameTree, 'other', crossTreeNodes);
    // 1 same-tree + 3 cross-tree
    expect(items.filter(i => i.kind === 'node')).toHaveLength(4);
    // Same-tree first
    expect(items[0].label).toBe('Local node');
    expect(items[0].description).toBe('node · 1 msg');
    // Cross-tree shows thread title
    expect(items[1].label).toBe('Auth flow');
    expect(items[1].description).toBe('API Research · 4 msgs');
  });

  it('filters cross-tree nodes by query on node title', () => {
    const items = buildAtMentionItems('auth', [], [], 'other', crossTreeNodes);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Auth flow');
  });

  it('filters cross-tree nodes by query on thread title', () => {
    const items = buildAtMentionItems('deploy', [], [], 'other', crossTreeNodes);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('CDK setup');
    expect(items[0].description).toBe('Deployment · 5 msgs');
  });

  it('excludes current node from cross-tree results', () => {
    const items = buildAtMentionItems('', [], [], 'x1', crossTreeNodes);
    const nodeItems = items.filter(i => i.kind === 'node');
    expect(nodeItems.map(i => i.id)).not.toContain('node-x1');
    expect(nodeItems).toHaveLength(2);
  });

  it('excludes cross-tree nodes with no messages', () => {
    const groups: CrossTreeGroup[] = [
      { treeTitle: 'Empty thread', nodes: [mkNode('e1', 'Ghost', 0)] },
    ];
    const items = buildAtMentionItems('', [], [], 'other', groups);
    expect(items.filter(i => i.kind === 'node')).toHaveLength(0);
  });

  it('cross-tree node token uses node:nodeId format', () => {
    const items = buildAtMentionItems('CDK', [], [], 'other', crossTreeNodes);
    expect(items[0].token).toBe('node:x3');
  });

  it('returns empty when crossTreeNodes is undefined', () => {
    const items = buildAtMentionItems('', [], [], 'other', undefined);
    expect(items).toHaveLength(0);
  });
});
