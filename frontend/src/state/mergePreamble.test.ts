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
  it('expands one source to itself + branch descendants', () => {
    const nodes: Record<string, ChatNodeState> = {
      A: node('A'),
      A1: node('A1'),
      A2: node('A2'),
      A1a: node('A1a'),
      B: node('B'),
    };
    const edges: TreeEdge[] = [
      { source: 'A', target: 'A1', kind: 'branch' },
      { source: 'A', target: 'A2', kind: 'branch' },
      { source: 'A1', target: 'A1a', kind: 'branch' },
    ];
    const blocks = buildSubtreeContextBlocks(['A'], nodes, edges);
    const titles = blocks.map((b) => b.match(/=== Thread: (.*?) ===/)?.[1]).sort();
    expect(titles).toEqual(['A', 'A1', 'A1a', 'A2']);
  });

  it('renders the full transcript (user + assistant turns) of each node', () => {
    const nodes: Record<string, ChatNodeState> = { A: node('A') };
    const blocks = buildSubtreeContextBlocks(['A'], nodes, []);
    expect(blocks[0]).toContain('User: hello from A');
    expect(blocks[0]).toContain('Assistant: reply for A');
  });

  it('does not cross merge edges when expanding', () => {
    const nodes: Record<string, ChatNodeState> = {
      A: node('A'),
      C: node('C'),
      C1: node('C1'),
    };
    const edges: TreeEdge[] = [
      { source: 'A', target: 'C', kind: 'merge' },
      { source: 'C', target: 'C1', kind: 'branch' },
    ];
    const blocks = buildSubtreeContextBlocks(['C'], nodes, edges);
    const titles = blocks.map((b) => b.match(/=== Thread: (.*?) ===/)?.[1]);
    expect(titles).toContain('C');
    expect(titles).toContain('C1');
    expect(titles).not.toContain('A');
  });

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

  it("deduplicates when one source is in another source's subtree", () => {
    const nodes: Record<string, ChatNodeState> = { A: node('A'), A1: node('A1') };
    const edges: TreeEdge[] = [{ source: 'A', target: 'A1', kind: 'branch' }];
    const blocks = buildSubtreeContextBlocks(['A', 'A1'], nodes, edges);
    const titles = blocks.map((b) => b.match(/=== Thread: (.*?) ===/)?.[1]);
    expect(titles.filter((t) => t === 'A1')).toHaveLength(1);
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
