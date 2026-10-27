import { describe, it, expect } from 'vitest';
import { buildSubtreeContextBlocks, estimateMergePreambleTokens } from './mergePreamble';
import type { ChatNodeState } from './chatTypes';
import type { TreeEdge } from './tree';

function node(id: string, partial: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: id,
    kind: 'chat',
    chatId: null,
    projectId: 'p',
    messages: [
      { id: `${id}-u`, role: 'user', text: 'hello from ' + id, toolCalls: [] },
      { id: `${id}-a`, role: 'assistant', text: 'reply for ' + id, toolCalls: [] },
    ],
    followUps: [],
    status: 'idle',
    title: id,
    ...partial,
  } as ChatNodeState;
}

describe('buildSubtreeContextBlocks', () => {
  it('honors isAlive filter to skip soft-deleted nodes', () => {
    const nodes: Record<string, ChatNodeState> = {
      A: node('A'),
      A1: node('A1'),
      A2: node('A2'),
    };
    const edges: TreeEdge[] = [
      { source: 'A', target: 'A1', kind: 'branch' },
      { source: 'A', target: 'A2', kind: 'branch' },
    ];
    const isAlive = (id: string) => id !== 'A1';
    const blocks = buildSubtreeContextBlocks(['A'], nodes, edges, isAlive);
    const titles = blocks.map((b) => b.match(/=== Thread: (.*?) ===/)?.[1]).sort();
    expect(titles).toEqual(['A', 'A2']);
  });
});

describe('estimateMergePreambleTokens', () => {
  it('returns roughly chars/4 over all blocks', () => {
    const nodes: Record<string, ChatNodeState> = { A: node('A') };
    const blocks = buildSubtreeContextBlocks(['A'], nodes, []);
    const total = blocks.join('').length;
    expect(estimateMergePreambleTokens(['A'], nodes, [])).toBe(Math.ceil(total / 4));
  });
});
