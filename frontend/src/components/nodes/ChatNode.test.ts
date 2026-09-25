import { stripBranchPrefix, parseFanoutCommand, shouldBranchOnSubmit } from './chatNodeUtils';

describe('stripBranchPrefix', () => {
  it('detects /branch prefix (case-insensitive)', () => {
    expect(stripBranchPrefix('/Branch tell me more')).toEqual({
      branched: true,
      text: 'tell me more',
    });
  });

  it('returns unchanged text when no prefix is present', () => {
    expect(stripBranchPrefix('just asking a question')).toEqual({
      branched: false,
      text: 'just asking a question',
    });
  });
});

describe('parseFanoutCommand', () => {
  it('returns null for non-fanout text', () => {
    expect(parseFanoutCommand('just asking')).toBeNull();
    expect(parseFanoutCommand('/branch fanout stuff')).toBeNull();
  });

  it('parses numbered list style', () => {
    const text = '/fanout\n1. first angle\n2) second angle\n3. third angle';
    expect(parseFanoutCommand(text)).toEqual({
      topics: ['first angle', 'second angle', 'third angle'],
    });
  });

  it('parses semicolon-separated single-line style', () => {
    expect(parseFanoutCommand('/fanout study A; investigate B; research C')).toEqual({
      topics: ['study A', 'investigate B', 'research C'],
    });
  });

  it('returns empty topics when only the command is typed', () => {
    expect(parseFanoutCommand('/fanout')).toEqual({ topics: [] });
    expect(parseFanoutCommand('/fanout   ')).toEqual({ topics: [] });
  });
});

import { isNodeInArchivedTree } from './chatNodeUtils';

describe('isNodeInArchivedTree', () => {
  const project = {
    trees: [
      { id: 't1', rootNodeId: 'r1', archivedAt: undefined },
      { id: 't2', rootNodeId: 'r2', archivedAt: 100 },
    ],
    edges: [
      { source: 'r1', target: 'c1' },
      { source: 'r2', target: 'c2' },
    ],
  };

  it('returns true for a node in an archived tree', () => {
    expect(isNodeInArchivedTree('c2', project as any)).toBe(true);
  });

  it('returns false when project is null', () => {
    expect(isNodeInArchivedTree('c1', null)).toBe(false);
  });
});

describe('shouldBranchOnSubmit', () => {
  it('returns true when slashBranched is set', () => {
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: true, streaming: false })).toBe(true);
  });
});
