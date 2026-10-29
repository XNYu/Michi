import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../state/chatTypes';
import type { PaneItem } from '../../state/paneItems';
import { MobilePaneSwitcher } from './MobilePaneSwitcher';

const state = vi.hoisted(() => ({
  project: null as Project | null, nodes: {} as Record<string, ChatNodeState>,
  panes: [] as string[], items: {} as Record<string, PaneItem>, focused: 'root', open: vi.fn(), focus: vi.fn(),
}));
vi.mock('../../state/chatStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../state/chatStore')>();
  return { ...actual, useChatProjects: () => ({ activeProject: state.project }),
    useChatPanes: () => ({ openPanes: state.panes, focusedPane: state.focused, paneItems: state.items }),
    useChatActions: () => ({ openPane: state.open, focusPane: state.focus }),
    useStructuralSelector: (selector: (nodes: typeof state.nodes) => unknown) => selector(state.nodes),
  };
});
beforeEach(() => {
  state.open.mockReset(); state.focus.mockReset(); state.focused = 'root'; state.items = {};
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
  expect(within(list).getAllByRole('button').map(row => row.textContent)).toEqual(['root', 'child', 'closed']);
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
