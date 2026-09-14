import { describe, it, expect } from 'vitest';
import { orderPinnedFirst } from './sidebarSelectors';
import { buildTree } from './tree';
import type { TreeNode } from './tree';

// Tree:
//   root
//   ├── a
//   │   ├── a1
//   │   └── a2
//   ├── b
//   └── c
const EDGES = [
  { source: 'root', target: 'a' },
  { source: 'a', target: 'a1' },
  { source: 'a', target: 'a2' },
  { source: 'root', target: 'b' },
  { source: 'root', target: 'c' },
];

const ids = (n: TreeNode) => n.children.map((c) => c.nodeId);
const lookup = (m: Record<string, number>) => (id: string) => m[id];

describe('orderPinnedFirst', () => {
  it('returns the same instance when nothing is pinned', () => {
    const root = buildTree('root', EDGES);
    expect(orderPinnedFirst(root, () => undefined)).toBe(root);
  });

  it('floats a pinned sibling to the front and keeps the rest in order', () => {
    const root = buildTree('root', EDGES);
    const out = orderPinnedFirst(root, lookup({ c: 10 }));
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });

  it('orders multiple pinned siblings by pinnedAt DESC (most recent first)', () => {
    const root = buildTree('root', EDGES);
    const out = orderPinnedFirst(root, lookup({ b: 5, c: 10 }));
    expect(ids(out)).toEqual(['c', 'b', 'a']);
  });

  it('reorders nested sibling groups independently', () => {
    const root = buildTree('root', EDGES);
    const out = orderPinnedFirst(root, lookup({ a2: 1 }));
    // Top level unchanged; a's children reordered.
    expect(ids(out)).toEqual(['a', 'b', 'c']);
    const a = out.children.find((c) => c.nodeId === 'a')!;
    expect(ids(a)).toEqual(['a2', 'a1']);
  });

  it('treats 0 as unpinned', () => {
    const root = buildTree('root', EDGES);
    expect(orderPinnedFirst(root, lookup({ b: 0 }))).toBe(root);
  });

  it('does not mutate the input tree', () => {
    const root = buildTree('root', EDGES);
    const snapshot = JSON.stringify(root);
    orderPinnedFirst(root, lookup({ c: 1, a2: 2 }));
    expect(JSON.stringify(root)).toBe(snapshot);
  });
});
