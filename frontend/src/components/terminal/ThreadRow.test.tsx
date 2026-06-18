import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ThreadRow from './ThreadRow';

const mockToggleTreeSelection = vi.fn();

const mockStoreState = {
  toggleTreeSelection: mockToggleTreeSelection,
  treeSelection: new Set<string>(),
  focusedNodeId: null as string | null,
};

vi.mock('../../state/chatStore', () => ({
  useChatNode: () => ({ title: 'Root title' }),
  useChatStore: () => mockStoreState,
  useChatProjects: () => ({
    projects: [],
    openPanes: [],
    focusedPane: null,
    treeSelection: mockStoreState.treeSelection,
    focusedNodeId: mockStoreState.focusedNodeId,
  }),
  useChatActions: () => ({
    toggleTreeSelection: mockStoreState.toggleTreeSelection,
  }),
  useNodesSelector: (selector: (nodes: Record<string, unknown>) => unknown) =>
    selector({}),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) =>
    selector({}),
}));

function renderThreadRow(overrides: Partial<React.ComponentProps<typeof ThreadRow>> = {}) {
  const actions = {
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    pinTree: vi.fn(),
    unpinTree: vi.fn(),
    renameTree: vi.fn(),
    deleteTree: vi.fn(),
  };
  const props: React.ComponentProps<typeof ThreadRow> = {
    tree: { id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: Date.now() },
    projectId: 'p1',
    isActive: true,
    hasBranches: false,
    expanded: false,
    openState: 'none',
    onActivate: vi.fn(),
    onToggleExpand: vi.fn(),
    actions,
    ...overrides,
  };
  render(<ThreadRow {...props} />);
  return { actions, props };
}

describe('ThreadRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cmd/ctrl+click toggles treeSelection and does not call onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { metaKey: true });

    expect(mockToggleTreeSelection).toHaveBeenCalledWith('t1');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('ctrl+click (non-mac) toggles treeSelection and does not call onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { ctrlKey: true });

    expect(mockToggleTreeSelection).toHaveBeenCalledWith('t1');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('plain click calls onActivate and does not toggle treeSelection', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row);

    expect(onActivate).toHaveBeenCalled();
    expect(mockToggleTreeSelection).not.toHaveBeenCalled();
  });

  it('renames a thread from the context menu inline editor', () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    const input = screen.getByLabelText('Thread name');
    expect((input as HTMLInputElement).value).toBe('Root title');

    fireEvent.change(input, { target: { value: 'Research plan' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(actions.renameTree).toHaveBeenCalledWith('t1', 'Research plan');
  });

  it('cancels inline rename on Escape', () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    const input = screen.getByLabelText('Thread name');
    fireEvent.change(input, { target: { value: 'Should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(actions.renameTree).not.toHaveBeenCalled();
    expect(screen.getByText('Root title')).toBeTruthy();
  });
});
