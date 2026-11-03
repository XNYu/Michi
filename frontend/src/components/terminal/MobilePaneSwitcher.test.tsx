import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../state/chatTypes';
import type { PaneItem } from '../../state/paneItems';
import { MobilePaneSwitcher } from './MobilePaneSwitcher';

const state = vi.hoisted(() => ({
  project: null as Project | null, nodes: {} as Record<string, ChatNodeState>,
  panes: [] as string[], items: {} as Record<string, PaneItem>, focused: 'root', open: vi.fn(), focus: vi.fn(), close: vi.fn(),
}));
vi.mock('../../state/chatStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../state/chatStore')>();
  return { ...actual, useChatProjects: () => ({ activeProject: state.project }),
    useChatPanes: () => ({ openPanes: state.panes, focusedPane: state.focused, paneItems: state.items }),
    useChatActions: () => ({ openPane: state.open, focusPane: state.focus, closePane: state.close }),
    useStructuralSelector: (selector: (nodes: typeof state.nodes) => unknown) => selector(state.nodes),
  };
});
beforeEach(() => {
  state.open.mockReset(); state.focus.mockReset(); state.close.mockReset(); state.focused = 'root'; state.items = {};
  state.panes = ['root', 'child'];
  state.nodes = Object.fromEntries(['root', 'child', 'closed', 'other', 'deleted'].map(id => [id, {
    nodeId: id, title: id, projectId: 'p', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle',
    ...(id === 'deleted' ? { deletedAt: 1 } : {}),
  }])) as typeof state.nodes;
  state.project = { id: 'p', name: 'Test', chatIds: Object.keys(state.nodes), createdAt: 1, activeTreeId: 't',
    trees: [{ id: 't', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }, { id: 'other-tree', rootNodeId: 'other', createdAt: 1, lastActiveAt: 1 }],
    edges: [{ source: 'root', target: 'child' }, { source: 'child', target: 'closed' }, { source: 'root', target: 'deleted' }, { source: 'root', target: 'other', kind: 'link' }],
  };
});

it('lists indented titles from the active tree, ignores links and deleted branches, and reopens a closed pane', () => {
  render(<MobilePaneSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch pane' }));
  const list = screen.getByRole('navigation', { name: 'Branches and panes' });
  expect(Array.from(list.querySelectorAll('.mobile-pane-row')).map(row => row.textContent)).toEqual(['root', 'child', 'closed']);
  expect(within(list).getByRole('button', { name: 'closed' }).style.getPropertyValue('--pane-depth')).toBe('2');
  expect(within(list).getByRole('button', { name: 'root' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(within(list).getByRole('button', { name: 'closed' }));
  expect(state.open).toHaveBeenCalledWith('closed');
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Switch pane' }));
});

it('focuses existing panes, supports keyboard navigation and dismisses outside', () => {
  render(<MobilePaneSwitcher />);
  const trigger = screen.getByRole('button', { name: 'Switch pane' });
  fireEvent.click(trigger);
  expect(document.activeElement?.textContent).toBe('root');
  fireEvent.keyDown(document, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toBe('child');
  fireEvent.click(document.activeElement!);
  expect(state.focus).toHaveBeenCalledWith('child');
  fireEvent.click(trigger); fireEvent.keyDown(document, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('navigation')).toBeNull();
  fireEvent.click(trigger); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('navigation')).toBeNull();
});

it('fades the closed list out as an inert ghost and returns focus at once', async () => {
  render(<MobilePaneSwitcher />);
  const trigger = screen.getByRole('button', { name: 'Switch pane' });
  fireEvent.click(trigger);
  const list = screen.getByRole('navigation', { name: 'Branches and panes' });
  fireEvent.keyDown(document, { key: 'Escape' });
  // Not a layer any more (no role for escapeLayers, no taps, no focus), but
  // still on screen for its 110ms exit.
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(list.isConnected).toBe(true);
  expect(list.getAttribute('role')).toBeNull();
  expect(list.getAttribute('aria-hidden')).toBe('true');
  expect(list.hasAttribute('inert')).toBe(true);
  await waitFor(() => expect(list.isConnected).toBe(false));
});

it('keeps non-chat panes reachable and closes the list when the active tree changes', () => {
  state.panes.push('terminal');
  state.items.terminal = { id: 'terminal', kind: 'terminal', title: 'Build shell' } as PaneItem;
  const { rerender } = render(<MobilePaneSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch pane' }));
  fireEvent.click(screen.getByRole('button', { name: 'Build shell' }));
  expect(state.focus).toHaveBeenCalledWith('terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Switch pane' }));
  state.project = { ...state.project!, activeTreeId: 'other-tree' }; state.panes = ['other'];
  rerender(<MobilePaneSwitcher />);
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Switch pane' })).toBeNull();
});

describe('new branch motion', () => {
  const animate = vi.fn();
  const flights = () => document.body.querySelectorAll('.mobile-branch-flight');
  const addBranch = (id: string, createdAt?: number) => {
    state.nodes = { ...state.nodes, [id]: { ...state.nodes.child, nodeId: id, title: id } };
    state.project = { ...state.project!, chatIds: [...state.project!.chatIds, id], edges: [...state.project!.edges, { source: 'root', target: id, createdAt }] };
  };
  beforeEach(() => {
    animate.mockReset();
    animate.mockImplementation(() => ({ cancel: vi.fn(), onfinish: null }));
    Element.prototype.animate = animate;
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
    delete document.documentElement.dataset.reduceMotion;
  });

  it('flies a background branch from the last tap to the switcher, which then pulses', () => {
    const { rerender } = render(<MobilePaneSwitcher />);
    const trigger = screen.getByRole('button', { name: 'Switch pane' });
    // jsdom has no PointerEvent, so fireEvent.pointerDown would drop the coordinates.
    fireEvent(document.body, new MouseEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 700 }));
    addBranch('tangent', Date.now());
    rerender(<MobilePaneSwitcher />);
    expect(flights()).toHaveLength(1);
    const flight = animate.mock.results[0].value as { onfinish: (() => void) | null };
    expect(animate.mock.contexts[0]).toBe(flights()[0]);
    expect((animate.mock.calls[0][0] as Keyframe[])[0].transform).toContain('translate(120px, 700px)');
    act(() => flight.onfinish?.());
    expect(flights()).toHaveLength(0);
    expect(animate.mock.contexts[1]).toBe(trigger);
  });

  it('leaves foreground branches and reopened panes to the dashboard', () => {
    const { rerender } = render(<MobilePaneSwitcher />);
    addBranch('opened', Date.now());
    state.focused = 'opened';
    rerender(<MobilePaneSwitcher />);
    addBranch('restored');
    rerender(<MobilePaneSwitcher />);
    expect(flights()).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
  });

  it('only tints the switcher under reduced motion', () => {
    document.documentElement.dataset.reduceMotion = 'on';
    const { rerender } = render(<MobilePaneSwitcher />);
    addBranch('tangent', Date.now());
    rerender(<MobilePaneSwitcher />);
    expect(flights()).toHaveLength(0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(screen.getByRole('button', { name: 'Switch pane' }));
    expect(JSON.stringify(animate.mock.calls[0][0])).not.toContain('transform');
  });
});

it('closes open panes from the list and keeps it open, with no close button on a closed branch', () => {
  render(<MobilePaneSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch pane' }));
  const list = screen.getByRole('navigation', { name: 'Branches and panes' });
  expect(within(list).getByRole('button', { name: 'Close root' })).toBeTruthy();
  expect(within(list).queryByRole('button', { name: 'Close closed' })).toBeNull();
  fireEvent.click(within(list).getByRole('button', { name: 'Close child' }));
  expect(state.close).toHaveBeenCalledWith('child');
  expect(state.focus).not.toHaveBeenCalled();
  expect(screen.getByRole('navigation', { name: 'Branches and panes' })).toBeTruthy();
  expect(document.activeElement).toBe(within(list).getByRole('button', { name: 'child' }));
});
