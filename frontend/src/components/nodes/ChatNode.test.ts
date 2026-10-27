import { stripBranchPrefix, parseFanoutCommand } from './chatNodeUtils';

describe('stripBranchPrefix', () => {
  it('detects /branch prefix (case-insensitive)', () => {
    expect(stripBranchPrefix('/Branch tell me more')).toEqual({
      branched: true,
      text: 'tell me more',
    });
  });
});

describe('parseFanoutCommand', () => {
  it('parses bullet-list style', () => {
    const text = '/fanout\n- study option A\n- investigate option B\n* research C';
    expect(parseFanoutCommand(text)).toEqual({
      topics: ['study option A', 'investigate option B', 'research C'],
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
});
