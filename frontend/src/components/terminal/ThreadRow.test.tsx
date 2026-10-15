import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ThreadRow from './ThreadRow';
import { reduceNodes } from '../../state/chatReducers';
import type { ChatNodeState } from '../../state/chatTypes';

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
    projects: [],
    openPanes: [],
    focusedPane: null,
    treeSelection: mockStoreState.treeSelection,
    focusedNodeId: mockStoreState.focusedNodeId,
  }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => {
    structuralSelectors.push(selector);
    return selector({});
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

  it('keeps an explicitly renamed thread ahead of a temporary message label', () => {
    mockStoreState.node = reduceNodes({ n1: { ...makeNode(), title: undefined } }, {
      type: 'user-send', nodeId: 'n1', userText: 'Hello', assistantId: 'a1',
    }).n1;
    renderThreadRow({ tree: { id: 't1', rootNodeId: 'n1', name: 'My research', createdAt: 0, lastActiveAt: 0 } });

    expect(screen.getByText('My research')).toBeTruthy();
    expect(screen.queryByText('Hello')).toBeNull();
  });

  it('keeps its unread selector stable across local-state renders', () => {
    renderThreadRow();
    const first = structuralSelectors.at(-1);

    fireEvent.contextMenu(screen.getByText('Root title').closest('[data-sidebar-row]')!);

    expect(structuralSelectors.at(-1)).toBe(first);
  });

  it('keeps its unread selector stable when only tree activity metadata changes', () => {
    const { props, rerender } = renderThreadRow();
    const first = structuralSelectors.at(-1);

    rerender({ tree: { ...props.tree, lastActiveAt: props.tree.lastActiveAt + 1 } });

    expect(structuralSelectors.at(-1)).toBe(first);
  });

  // Selection ownership moved out of ThreadRow: it forwards every click to
  // onActivate with the raw event, and the parent decides select vs. activate
  // by inspecting the modifier keys. So the row's job is just "always call
  // onActivate, carrying the modifier state".
  it('cmd+click forwards the modifier to onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { metaKey: true });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toMatchObject({ metaKey: true });
  });

  it('ctrl+click (non-mac) forwards the modifier to onActivate', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row, { ctrlKey: true });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toMatchObject({ ctrlKey: true });
  });

  it('plain click calls onActivate with no modifiers', () => {
    const onActivate = vi.fn();
    renderThreadRow({ onActivate });

    const row = screen.getByText('Root title').closest('[data-sidebar-row]')!;
    fireEvent.click(row);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toMatchObject({ metaKey: false, ctrlKey: false });
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
