import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ThreadRow from './ThreadRow';
import { reduceNodes } from '../../state/chatReducers';
import type { ChatNodeState, ProjectEdge } from '../../state/chatTypes';

function makeNode(): ChatNodeState {
  return {
    nodeId: 'n1', kind: 'chat', chatId: 'c1', projectId: 'p1',
    title: 'Root title', messages: [], followUps: [], status: 'idle', runtimeId: 'claude',
  };
}

const mockStoreState = {
  treeSelection: new Set<string>(),
  focusedNodeId: null as string | null,
  node: makeNode(),
  /** What useStructuralSelector reads: the tree's nodes, branches included. */
  nodes: {} as Record<string, ChatNodeState>,
  projects: [] as Array<{ id: string; edges: ProjectEdge[] }>,
};
const structuralSelectors: Array<(nodes: Record<string, unknown>) => unknown> = [];

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { showSidebarTimestamps: false } }),
}));

// ThreadRow no longer owns selection: every click is forwarded to onActivate,
// and the parent (WorkspaceRow) inspects the modifier keys to decide between
// select vs. activate. These mocks only need to cover what ThreadRow reads for
// display (treeSelection / focusedNodeId / projects).
vi.mock('../../state/chatStore', () => ({
  useChatNode: () => mockStoreState.node,
  useChatActions: () => ({
    clearTreeSelection: vi.fn(),
  }),
  useChatProjects: () => ({
    projects: mockStoreState.projects,
    openPanes: [],
    focusedPane: null,
    treeSelection: mockStoreState.treeSelection,
    focusedNodeId: mockStoreState.focusedNodeId,
  }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => {
    structuralSelectors.push(selector);
    return selector(mockStoreState.nodes);
  },
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
  const view = render(<ThreadRow {...props} />);
  return {
    actions,
    props,
    rerender: (next: Partial<React.ComponentProps<typeof ThreadRow>>) =>
      view.rerender(<ThreadRow {...props} {...next} />),
  };
}

describe('ThreadRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    structuralSelectors.length = 0;
    mockStoreState.node = makeNode();
    mockStoreState.nodes = {};
    mockStoreState.projects = [];
    localStorage.clear();
  });

  describe('unread dot', () => {
    const dot = () => document.querySelector('[data-sidebar-row="n1"] .sb-unread-dot') as HTMLElement;
    const title = () => screen.getByText('Root title').closest('[data-sidebar-row]') as HTMLElement;
    const unreadBranch = (): ChatNodeState => ({
      ...makeNode(), nodeId: 'b1', title: 'Branch', lastAssistantAt: 5, viewedAt: 1,
    });

    it('is solid on an unread root and brightens its title, without the old 900 weight', () => {
      mockStoreState.node = { ...makeNode(), lastAssistantAt: 5, viewedAt: 1 };
      mockStoreState.nodes = { n1: mockStoreState.node };
      renderThreadRow({ isActive: false });
      expect(dot().dataset.unread).toBe('self');
      expect(title().style.fontWeight).toBe('520');
      expect(title().style.color).toBe('var(--term-fg)');
    });

    it('rings a collapsed thread whose unread reply is in a branch, and clears once expanded', () => {
      mockStoreState.nodes = { n1: mockStoreState.node, b1: unreadBranch() };
      mockStoreState.projects = [{ id: 'p1', edges: [{ source: 'n1', target: 'b1', kind: 'branch' } as ProjectEdge] }];
      const { rerender } = renderThreadRow({ isActive: false, hasBranches: true, expanded: false });
      expect(dot().dataset.unread).toBe('within');
      // The root itself is read: its title keeps the read weight and colour.
      expect(title().style.fontWeight).toBe('450');
      expect(title().style.color).toBe('var(--term-mid)');

      rerender({ isActive: false, hasBranches: true, expanded: true });
      expect(dot().dataset.unread).toBe('none');
    });

    it('stays mounted at "none" on a read row, so a reply arriving later animates in', () => {
      renderThreadRow();
      expect(dot().dataset.unread).toBe('none');
    });
  });

  it('shows the first message while waiting, then accepts the main response title', () => {
    const initial = { n1: { ...makeNode(), title: undefined } };
    const streaming = reduceNodes(initial, {
      type: 'user-send', nodeId: 'n1', userText: '/btw Claude 标题应该如何生成？', assistantId: 'a1',
    });
    mockStoreState.node = streaming.n1;
    const { rerender } = renderThreadRow();

    expect(screen.getByText('Claude 标题应该如何生成？')).toBeTruthy();
    expect(mockStoreState.node.title).toBeUndefined();
    expect(mockStoreState.node.titleNeedsPersistence).toBeUndefined();

    const titled = reduceNodes(streaming, { type: 'set-title', nodeId: 'n1', title: 'Claude 主对话标题生成' });
    mockStoreState.node = titled.n1;
    rerender({});

    expect(screen.getByText('Claude 主对话标题生成')).toBeTruthy();
    expect(screen.queryByText('Claude 标题应该如何生成？')).toBeNull();
  });

  it('ctrl+click (non-mac) forwards the modifier to onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { ctrlKey: true });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toMatchObject({ ctrlKey: true });
  });

  it('renames a thread from the context menu inline editor', async () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    // ContextMenu fires the item action after a short confirm-blink timeout,
    // so the inline editor appears asynchronously.
    const input = await screen.findByLabelText('Thread name');
    expect((input as HTMLInputElement).value).toBe('Root title');

    fireEvent.change(input, { target: { value: 'Research plan' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(actions.renameTree).toHaveBeenCalledWith('t1', 'Research plan');
  });

  it('cancels inline rename on Escape', async () => {
    const { actions } = renderThreadRow();

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);
    fireEvent.click(screen.getByText(/Rename/));

    const input = await screen.findByLabelText('Thread name');
    fireEvent.change(input, { target: { value: 'Should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(actions.renameTree).not.toHaveBeenCalled();
    expect(screen.getByText('Root title')).toBeTruthy();
  });
});
