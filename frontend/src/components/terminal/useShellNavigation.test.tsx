import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useShellNavigation, type ShellLocation } from './useShellNavigation';
import { navigateToNode } from '../../state/navigateToNode';

vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
const home: ShellLocation = { page: 'spaces', spaceRoute: { type: 'spaces' }, spacesHome: { kind: 'home' }, chat: null };
const chat = (nodeId: string, projectId = 'w1'): ShellLocation => ({ ...home, page: 'dashboard', chat: { nodeId, projectId, treeId: nodeId } });

function setup(initial: ShellLocation) {
  const restore = vi.fn();
  const dead = new Set<string>();
  const deps = { projects: [], activeProjectId: null, selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn() };
  const hook = renderHook(({ location }) => useShellNavigation({ location, hydrated: true, deps, restore, isChatLive: entry => !dead.has(entry.nodeId) }), { initialProps: { location: initial } });
  const visit = (location: ShellLocation) => hook.rerender({ location });
  const step = (direction: 'onBack' | 'onForward') => {
    act(() => hook.result.current[direction]());
    const target = restore.mock.lastCall?.[0] as ShellLocation;
    visit(target);
    return target;
  };
  return { ...hook, visit, step, restore, dead, deps };
}

describe('visible shell navigation', () => {
  it('interleaves Pages and chats across workspaces, then clears forward on a new visit', () => {
    const h = setup(chat('a'));
    h.visit(home);
    h.visit(chat('b', 'w2'));
    expect(h.step('onBack')).toEqual(home);
    expect(h.step('onBack')).toEqual(chat('a'));
    expect(navigateToNode).toHaveBeenLastCalledWith(h.deps, 'a', 'w1');
    expect(h.step('onForward')).toEqual(home);
    expect(h.step('onForward')).toEqual(chat('b', 'w2'));
    expect(navigateToNode).toHaveBeenLastCalledWith(h.deps, 'b', 'w2');
    h.step('onBack');
    h.visit(chat('c'));
    expect(h.result.current.canForward).toBe(false);
  });

  it('does not record background chat changes on Pages and skips deleted chats', () => {
    const h = setup(home);
    h.visit({ ...home });
    expect(h.result.current.canBack).toBe(false);
    h.visit(chat('a'));
    h.visit(chat('b'));
    h.dead.add('a');
    expect(h.step('onBack')).toEqual(home);
  });

  it('accepts the current tree when a chat moved since its last visit', () => {
    const h = setup(chat('a'));
    h.visit(home);
    act(() => h.result.current.onBack());
    h.visit({ ...chat('a'), chat: { ...chat('a').chat!, treeId: 'new-tree' } });
    h.visit(chat('b'));
    expect(h.step('onBack').chat?.nodeId).toBe('a');
  });

  it('suppresses intermediate chat focus while returning across workspaces', () => {
    const h = setup(chat('a', 'w1'));
    h.visit(home);
    act(() => h.result.current.onBack());
    h.visit(chat('old-focus', 'w1'));
    h.visit(chat('a', 'w1'));
    expect(h.result.current.canBack).toBe(false);
    expect(h.step('onForward')).toEqual(home);
  });
});
