import { activeTreeRootNodeId, descendants } from './tree';

describe('descendants', () => {
  it('does not loop forever on cyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const d = descendants('a', edges);
    expect(d).toEqual(new Set(['b']));
  });
});

describe('activeTreeRootNodeId', () => {
  const trees = [{ id: 't1', rootNodeId: 'r1' }, { id: 't2', rootNodeId: 'r2' }];

  it('returns the root of the active tree, not the first tree', () => {
    expect(activeTreeRootNodeId({ activeTreeId: 't2', trees })).toBe('r2');
  });

  it('returns null without a project, an active tree, or a matching tree', () => {
    expect(activeTreeRootNodeId(null)).toBeNull();
    expect(activeTreeRootNodeId(undefined)).toBeNull();
    expect(activeTreeRootNodeId({ activeTreeId: null, trees })).toBeNull();
    expect(activeTreeRootNodeId({ activeTreeId: 'archived', trees })).toBeNull();
  });
});
