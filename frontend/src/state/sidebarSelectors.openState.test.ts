import { describe, it, expect } from 'vitest';
import { nodeOpenState, subtreeOpenState, buildBranchChildrenOf } from './sidebarSelectors';
import type { OpenState } from './sidebarSelectors';
import type { ProjectEdge } from './chatTypes';

describe('nodeOpenState', () => {
  it('returns streaming even when the node is not an open pane (navigation away)', () => {
    // Switched to a different thread/workspace: 'a' is no longer in the active
    // slot's panes, but a running turn must still surface in the sidebar.
    expect(nodeOpenState('a', [], null, 'streaming')).toBe('streaming');
    expect(nodeOpenState('a', ['b'], 'b', 'streaming')).toBe('streaming');
  });
});

describe('subtreeOpenState', () => {
  // Tree:
  //     root
  //    /    \
  //   a      b
  //   |
  //   c
  const edges: ProjectEdge[] = [
    { source: 'root', target: 'a', kind: 'branch' },
    { source: 'root', target: 'b', kind: 'branch' },
    { source: 'a', target: 'c', kind: 'branch' },
  ];
  const isAlive = () => true;

  it('prunes entire subtree of a dead intermediate node', () => {
    const isAliveExceptA = (id: string) => id !== 'a'; // a is dead, c (child of a) is alive
    const perNode = (id: string): OpenState =>
      (id === 'c' ? 'streaming' : 'none');
    // c is alive but reachable only through dead a → must not bubble
    expect(subtreeOpenState('root', edges, isAliveExceptA, perNode)).toBe('none');
  });
});

describe('subtreeOpenState with pre-built childrenOf', () => {
  const edges: ProjectEdge[] = [
    { source: 'root', target: 'a', kind: 'branch' },
    { source: 'root', target: 'b', kind: 'branch' },
    { source: 'a', target: 'c', kind: 'branch' },
  ];
  const isAlive = () => true;
  const cached = buildBranchChildrenOf(edges);

  it('produces identical results when passing the cached map', () => {
    const perNode = (id: string): OpenState =>
      id === 'b' ? 'streaming' : 'none';
    // Without cache
    const r1 = subtreeOpenState('root', edges, isAlive, perNode);
    // With cache
    const r2 = subtreeOpenState('root', edges, isAlive, perNode, cached);
    expect(r1).toBe(r2);
    expect(r2).toBe('streaming');
  });
});