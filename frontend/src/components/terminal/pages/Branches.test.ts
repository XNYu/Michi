import { describe, expect, it } from 'vitest';
import type { ChatNodeState } from '../../../state/chatTypes';
import { buildBranchDirectoryRows, buildBranchDocumentRows, fallbackBranchOverview } from './Branches';

function node(nodeId: string, extras: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...extras,
  };
}

describe('buildBranchDocumentRows', () => {
  it('renders one active thread in depth-first Markdown heading order', () => {
    const nodes = {
      root: node('root', { title: 'Root', branchOverview: 'Root overview' }),
      a: node('a', { title: 'Branch A', branchOverview: 'A overview' }),
      aa: node('aa', { title: 'Branch AA', branchOverview: 'AA overview' }),
      b: node('b', { title: 'Branch B', branchOverview: 'B overview' }),
      other: node('other', { title: 'Other thread' }),
    };
    const rows = buildBranchDocumentRows('root', [
      { source: 'root', target: 'a', kind: 'branch' },
      { source: 'a', target: 'aa', kind: 'branch' },
      { source: 'root', target: 'b', kind: 'branch' },
      { source: 'other', target: 'root', kind: 'link' },
    ], nodes);

    expect(rows.map((row) => [row.nodeId, row.depth])).toEqual([
      ['root', 0],
      ['a', 1],
      ['aa', 2],
      ['b', 1],
    ]);
  });

  it('skips deleted and digest nodes', () => {
    const nodes = {
      root: node('root'),
      deleted: node('deleted', { deletedAt: 123 }),
      digest: node('digest', { kind: 'digest' }),
    };
    const rows = buildBranchDocumentRows('root', [
      { source: 'root', target: 'deleted', kind: 'branch' },
      { source: 'root', target: 'digest', kind: 'branch' },
    ], nodes);
    expect(rows.map((row) => row.nodeId)).toEqual(['root']);
  });

  it('derives the directory parentage from the same Markdown document order', () => {
    const documentRows = [
      { nodeId: 'root', depth: 0, title: 'Root', overview: null, generated: false, streaming: false },
      { nodeId: 'a', depth: 1, title: 'A', overview: null, generated: false, streaming: false },
      { nodeId: 'aa', depth: 2, title: 'AA', overview: null, generated: false, streaming: true },
      { nodeId: 'b', depth: 1, title: 'B', overview: null, generated: false, streaming: false },
    ];

    expect(buildBranchDirectoryRows(documentRows)).toMatchObject([
      { nodeId: 'root', hasChildren: true },
      { nodeId: 'a', parentNodeId: 'root', hasChildren: true },
      { nodeId: 'aa', parentNodeId: 'a', hasChildren: false, streaming: true },
      { nodeId: 'b', parentNodeId: 'root', hasChildren: false },
    ]);
  });
});

describe('fallbackBranchOverview', () => {
  it('uses the first useful paragraph of the latest assistant answer', () => {
    const overview = fallbackBranchOverview(node('n1', {
      messages: [{
        id: 'a1',
        role: 'assistant',
        text: '[TITLE: T]\n\n#### Result\n\nRotating tokens are the current favorite.\n\nMore detail.',
        toolCalls: [],
      }],
    }));
    expect(overview).toBe('Rotating tokens are the current favorite.');
  });

  it('falls back to the opening user prompt for an unanswered branch', () => {
    const overview = fallbackBranchOverview(node('n1', {
      messages: [{ id: 'u1', role: 'user', text: '/branch Compare the storage models', toolCalls: [] }],
    }));
    expect(overview).toBe('Compare the storage models');
  });
});
