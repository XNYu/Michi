import { buildAtMentionItems } from './mentionItems';
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
