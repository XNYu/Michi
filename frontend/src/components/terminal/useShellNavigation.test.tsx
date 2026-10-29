import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useShellNavigation, type ShellLocation } from './useShellNavigation';
import { navigateToNode } from '../../state/navigateToNode';

vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
const home: ShellLocation = { page: 'spaces', spaceRoute: { type: 'spaces' }, spacesHome: { kind: 'home' }, scheduledRoute: { kind: 'list' }, chat: null };
const chat = (nodeId: string, projectId = 'w1'): ShellLocation => ({ ...home, page: 'dashboard', chat: { nodeId, projectId, treeId: nodeId } });

function setup(initial: ShellLocation) {
  const restore = vi.fn();
  const dead = new Set<string>();
  const deadJobs = new Set<string>();
  const deps = { projects: [], activeProjectId: null, selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn() };
  const hook = renderHook(({ location }) => useShellNavigation({ location, hydrated: true, deps, restore, isChatLive: entry => !dead.has(entry.nodeId), isScheduledJobLive: jobId => !deadJobs.has(jobId) }), { initialProps: { location: initial } });
  const visit = (location: ShellLocation) => hook.rerender({ location });
  const step = (direction: 'onBack' | 'onForward') => {
    act(() => hook.result.current[direction]());
    const target = restore.mock.lastCall?.[0] as ShellLocation;
    visit(target);
    return target;
  };
  return { ...hook, visit, step, restore, dead, deadJobs, deps };
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

  it('distinguishes the Scheduled list, system detail and each ordinary job', () => {
    const list: ShellLocation = { ...home, page: 'scheduled' };
    const meta: ShellLocation = { ...list, scheduledRoute: { kind: 'meta-agent' } };
    const jobA: ShellLocation = { ...list, scheduledRoute: { kind: 'job', jobId: 'a' } };
    const jobB: ShellLocation = { ...list, scheduledRoute: { kind: 'job', jobId: 'b' } };
    const h = setup(home);
    for (const location of [list, meta, jobA, jobB]) h.visit(location);
    for (const location of [jobA, meta, list, home]) expect(h.step('onBack')).toEqual(location);
    for (const location of [list, meta, jobA, jobB]) expect(h.step('onForward')).toEqual(location);
    h.visit(home);
    h.visit({ ...home, scheduledRoute: { kind: 'list' } });
    expect(h.step('onBack')).toEqual(jobB);
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

  it('skips a managed job notification route once it redirects to the system detail', () => {
    const list: ShellLocation = { ...home, page: 'scheduled' };
    const meta: ShellLocation = { ...list, scheduledRoute: { kind: 'meta-agent' } };
    const h = setup(list);
    h.visit({ ...list, scheduledRoute: { kind: 'job', jobId: 'managed' } });
    h.deadJobs.add('managed');
    h.visit(meta);
    expect(h.step('onBack')).toEqual(list);
    expect(h.step('onForward')).toEqual(meta);
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
