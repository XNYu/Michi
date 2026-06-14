import { stripBranchPrefix, parseFanoutCommand, shouldBranchOnSubmit } from './chatNodeUtils';

describe('stripBranchPrefix', () => {
  it('detects /btw prefix', () => {
    expect(stripBranchPrefix('/btw what about X')).toEqual({
      branched: true,
      text: 'what about X',
    });
  });

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

  it('does not detect partial matches like /branches', () => {
    expect(stripBranchPrefix('/branches of math')).toEqual({
      branched: false,
      text: '/branches of math',
    });
  });
});

describe('parseFanoutCommand', () => {
  it('returns null for non-fanout text', () => {
    expect(parseFanoutCommand('just asking')).toBeNull();
    expect(parseFanoutCommand('/branch fanout stuff')).toBeNull();
  });

  it('parses bullet-list style', () => {
    const text = '/fanout\n- study option A\n- investigate option B\n* research C';
    expect(parseFanoutCommand(text)).toEqual({
      topics: ['study option A', 'investigate option B', 'research C'],
    });
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

  it('is case-insensitive and accepts /fan-out + /explore', () => {
    expect(parseFanoutCommand('/FANOUT a;b')).toEqual({ topics: ['a', 'b'] });
    expect(parseFanoutCommand('/fan-out a;b')).toEqual({ topics: ['a', 'b'] });
    expect(parseFanoutCommand('/Explore a;b')).toEqual({ topics: ['a', 'b'] });
  });

  it('returns empty topics when only the command is typed', () => {
    expect(parseFanoutCommand('/fanout')).toEqual({ topics: [] });
    expect(parseFanoutCommand('/fanout   ')).toEqual({ topics: [] });
  });

  it('ignores bare commas so normal prose on single line is preserved', () => {
    expect(parseFanoutCommand('/fanout study A, B, and C')).toEqual({
      topics: ['study A, B, and C'],
    });
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

  it('returns false for a node in a live tree', () => {
    expect(isNodeInArchivedTree('c1', project as any)).toBe(false);
  });

  it('returns true for a node in an archived tree', () => {
    expect(isNodeInArchivedTree('c2', project as any)).toBe(true);
  });

  it('returns false when project is null', () => {
    expect(isNodeInArchivedTree('c1', null)).toBe(false);
  });
});

describe('shouldBranchOnSubmit', () => {
  it('returns true when forceBranch is set', () => {
    expect(shouldBranchOnSubmit({ forceBranch: true, slashBranched: false, streaming: false })).toBe(true);
  });

  it('returns true when slashBranched is set', () => {
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: true, streaming: false })).toBe(true);
  });

  it('returns false when only streaming is set (queue path now)', () => {
    // Updated 2026-05-07: streaming no longer auto-branches; the Send/Queue
    // button queues onto N instead. See composer-queue-design.md.
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: false, streaming: true })).toBe(false);
  });

  it('returns false in plain idle case', () => {
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: false, streaming: false })).toBe(false);
  });

  it('still branches when force/slash are set even while streaming', () => {
    expect(shouldBranchOnSubmit({ forceBranch: true, slashBranched: false, streaming: true })).toBe(true);
    expect(shouldBranchOnSubmit({ forceBranch: false, slashBranched: true, streaming: true })).toBe(true);
  });
});
