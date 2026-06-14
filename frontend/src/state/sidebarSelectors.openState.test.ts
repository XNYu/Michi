import { describe, it, expect } from 'vitest';
import { nodeOpenState, subtreeOpenState } from './sidebarSelectors';
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

  it('returns streaming when node is open, unfocused, and streaming', () => {
    expect(nodeOpenState('a', ['a', 'b'], 'b', 'streaming')).toBe('streaming');
  });

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

  it('skips dead nodes via isAlive', () => {
    const isAliveExceptC = (id: string) => id !== 'c';
    const perNode = (id: string): OpenState => (id === 'c' ? 'streaming' : 'none');
    // c is dead → its streaming contribution must not bubble.
    expect(subtreeOpenState('root', edges, isAliveExceptC, perNode)).toBe('none');
  });

  it('prunes entire subtree of a dead intermediate node', () => {
    const isAliveExceptA = (id: string) => id !== 'a'; // a is dead, c (child of a) is alive
    const perNode = (id: string): OpenState =>
      (id === 'c' ? 'streaming' : 'none');
    // c is alive but reachable only through dead a → must not bubble
    expect(subtreeOpenState('root', edges, isAliveExceptA, perNode)).toBe('none');
  });

  it('includes the root itself in the rollup', () => {
    const perNode = (id: string): OpenState => (id === 'root' ? 'idle' : 'none');
    expect(subtreeOpenState('root', edges, isAlive, perNode)).toBe('idle');
  });
});
