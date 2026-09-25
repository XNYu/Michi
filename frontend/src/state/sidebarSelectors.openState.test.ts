import { describe, it, expect } from 'vitest';
import { nodeOpenState, subtreeOpenState, buildBranchChildrenOf } from './sidebarSelectors';
import type { OpenState } from './sidebarSelectors';
import type { ProjectEdge } from './chatTypes';

describe('nodeOpenState', () => {
  it('returns none when node is not in openPanes', () => {
    expect(nodeOpenState('a', [], null, 'idle')).toBe('none');
    expect(nodeOpenState('a', ['b'], 'b', 'idle')).toBe('none');
  });

  it('returns none on the focused pane when not streaming (focused row covers it)', () => {
    expect(nodeOpenState('a', ['a', 'b'], 'a', 'idle')).toBe('none');
    expect(nodeOpenState('a', ['a', 'b'], 'a', 'error')).toBe('none');
  });

  it('returns streaming on the focused pane (a running turn stays visible)', () => {
    expect(nodeOpenState('a', ['a', 'b'], 'a', 'streaming')).toBe('streaming');
  });

  it('returns idle when node is open and unfocused (any non-streaming status)', () => {
    expect(nodeOpenState('a', ['a', 'b'], 'b', 'idle')).toBe('idle');
    expect(nodeOpenState('a', ['a', 'b'], 'b', 'error')).toBe('idle');
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

  it('returns none when no descendant is open', () => {
    const result = subtreeOpenState('root', edges, isAlive, () => 'none');
    expect(result).toBe('none');
  });

  it('returns idle when at least one descendant is idle and none stream', () => {
    const perNode = (id: string): OpenState => (id === 'c' ? 'idle' : 'none');
    expect(subtreeOpenState('root', edges, isAlive, perNode)).toBe('idle');
  });

  it('returns streaming when any descendant streams (priority > idle)', () => {
    const perNode = (id: string) => {
      if (id === 'a') return 'idle';
      if (id === 'b') return 'streaming';
      return 'none';
    };
    expect(subtreeOpenState('root', edges, isAlive, perNode)).toBe('streaming');
  });

  it('prunes entire subtree of a dead intermediate node', () => {
    const isAliveExceptA = (id: string) => id !== 'a'; // a is dead, c (child of a) is alive
    const perNode = (id: string): OpenState =>
      (id === 'c' ? 'streaming' : 'none');
    // c is alive but reachable only through dead a → must not bubble
    expect(subtreeOpenState('root', edges, isAliveExceptA, perNode)).toBe('none');
  });
});

describe('buildBranchChildrenOf', () => {
  it('builds adjacency from branch (and undefined-kind) edges only', () => {
    const edges: ProjectEdge[] = [
      { source: 'a', target: 'b', kind: 'branch' },
      { source: 'a', target: 'c' },                       // undefined kind → branch
      { source: 'b', target: 'd', kind: 'merge' },        // skipped
      { source: 'b', target: 'e', kind: 'digest-source' },// skipped
      { source: 'c', target: 'f', kind: 'branch' },
    ];
    const map = buildBranchChildrenOf(edges);
    expect([...map.get('a')!]).toEqual(['b', 'c']);
    expect([...map.get('c')!]).toEqual(['f']);
    expect(map.has('b')).toBe(false); // merge/digest edges not included
  });

  it('returns an empty map for no branch edges', () => {
    const edges: ProjectEdge[] = [
      { source: 'a', target: 'b', kind: 'merge' },
    ];
    expect(buildBranchChildrenOf(edges).size).toBe(0);
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