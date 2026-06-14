import { buildTree, descendants, findTreeIdForNode } from './tree';

describe('buildTree', () => {
  it('returns a single-node tree when root has no children', () => {
    const tree = buildTree('root', []);
    expect(tree).toEqual({ nodeId: 'root', depth: 0, children: [] });
  });

  it('builds a linear chain root → a → b', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'b' },
    ];
    const tree = buildTree('root', edges);
    expect(tree).toEqual({
      nodeId: 'root',
      depth: 0,
      children: [
        {
          nodeId: 'a',
          depth: 1,
          children: [{ nodeId: 'b', depth: 2, children: [] }],
        },
      ],
    });
  });

  it('builds a fanout root → {a, b}', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'root', target: 'b' },
    ];
    const tree = buildTree('root', edges);
    expect(tree.children.map((c) => c.nodeId).sort()).toEqual(['a', 'b']);
    expect(tree.children.every((c) => c.depth === 1)).toBe(true);
  });

  it('builds a mixed tree root → a → {b, d}, root → c', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'a', target: 'd' },
      { source: 'root', target: 'c' },
    ];
    const tree = buildTree('root', edges);
    expect(tree.nodeId).toBe('root');
    const childIds = tree.children.map((c) => c.nodeId).sort();
    expect(childIds).toEqual(['a', 'c']);
    const aNode = tree.children.find((c) => c.nodeId === 'a')!;
    const grandchildIds = aNode.children.map((c) => c.nodeId).sort();
    expect(grandchildIds).toEqual(['b', 'd']);
  });

  it('ignores edges whose source is not reachable from the root', () => {
    const edges = [
      { source: 'orphan-parent', target: 'orphan-child' },
      { source: 'root', target: 'a' },
    ];
    const tree = buildTree('root', edges);
    expect(tree.children.map((c) => c.nodeId)).toEqual(['a']);
  });
});

describe('descendants', () => {
  it('returns empty set for a leaf node', () => {
    expect(descendants('a', [])).toEqual(new Set());
  });

  it('excludes the root itself', () => {
    const edges = [
      { source: 'a', target: 'b' },
    ];
    const d = descendants('a', edges);
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
  });

  it('follows a linear chain', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
    ];
    expect(descendants('a', edges)).toEqual(new Set(['b', 'c', 'd']));
  });

  it('collects all branches in a fanout', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'e' },
    ];
    expect(descendants('a', edges)).toEqual(new Set(['b', 'c', 'd', 'e']));
  });

  it('ignores edges not reachable from root', () => {
    const edges = [
      { source: 'other', target: 'x' },
      { source: 'a', target: 'b' },
    ];
    expect(descendants('a', edges)).toEqual(new Set(['b']));
  });

  it('does not loop forever on cyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const d = descendants('a', edges);
    expect(d).toEqual(new Set(['b']));
  });
});

describe('buildTree with merge edges', () => {
  it('does not follow kind=merge edges', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'root', target: 'b' },
      { source: 'a', target: 'merge', kind: 'branch' as const },
      { source: 'b', target: 'merge', kind: 'merge' as const },
    ];
    const tree = buildTree('root', edges);
    const a = tree.children.find((c) => c.nodeId === 'a')!;
    const b = tree.children.find((c) => c.nodeId === 'b')!;
    expect(a.children.map((c) => c.nodeId)).toEqual(['merge']);
    expect(b.children.map((c) => c.nodeId)).toEqual([]);
  });
});

describe('descendants with merge edges', () => {
  it('does not follow kind=merge edges', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'real-child', kind: 'branch' as const },
      { source: 'a', target: 'merged-in-elsewhere', kind: 'merge' as const },
    ];
    expect(descendants('a', edges)).toEqual(new Set(['real-child']));
  });
});

describe('tree walkers with link edges', () => {
  it('buildTree ignores kind=link edges', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'root', target: 'b' },
      { source: 'a', target: 'b', kind: 'link' as const },
    ];
    const tree = buildTree('root', edges);
    const a = tree.children.find((c) => c.nodeId === 'a')!;
    expect(a.children).toEqual([]);
  });

  it('descendants ignores kind=link edges (no cascade across links)', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'b', kind: 'link' as const },
    ];
    expect(descendants('root', edges)).toEqual(new Set(['a']));
  });
});

describe('tree walkers with digest-source edges', () => {
  it('buildTree ignores kind=digest-source edges', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'digest', kind: 'digest-source' as const },
    ];
    const tree = buildTree('root', edges);
    const a = tree.children.find((c) => c.nodeId === 'a')!;
    expect(a.children).toEqual([]);
  });

  it('descendants ignores kind=digest-source edges', () => {
    const edges = [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'digest', kind: 'digest-source' as const },
    ];
    expect(descendants('root', edges)).toEqual(new Set(['a']));
  });
});

describe('findTreeIdForNode', () => {
  const project = {
    chatIds: ['r1', 'r2', 'c1', 'c2', 'orphan'],
    edges: [
      { source: 'r1', target: 'c1' },
      { source: 'r2', target: 'c2' },
    ],
    trees: [
      { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 },
      { id: 't2', rootNodeId: 'r2', createdAt: 0, lastActiveAt: 0 },
    ],
  };

  it('returns the tree id of a root node', () => {
    expect(findTreeIdForNode('r1', project as any)).toBe('t1');
    expect(findTreeIdForNode('r2', project as any)).toBe('t2');
  });

  it('walks parent chain via branch edges to locate the owning tree', () => {
    expect(findTreeIdForNode('c1', project as any)).toBe('t1');
    expect(findTreeIdForNode('c2', project as any)).toBe('t2');
  });

  it('returns null for a node not reachable from any root', () => {
    expect(findTreeIdForNode('orphan', project as any)).toBeNull();
  });

  it('ignores merge/link/digest-source edges while walking up', () => {
    const p = {
      chatIds: ['r1', 'r2', 'm'],
      edges: [
        { source: 'r1', target: 'm', kind: 'branch' as const },
        { source: 'r2', target: 'm', kind: 'merge' as const },
      ],
      trees: [
        { id: 't1', rootNodeId: 'r1', createdAt: 0, lastActiveAt: 0 },
        { id: 't2', rootNodeId: 'r2', createdAt: 0, lastActiveAt: 0 },
      ],
    };
    expect(findTreeIdForNode('m', p as any)).toBe('t1');
  });
});
