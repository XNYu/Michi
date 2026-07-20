import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import TreeSelectionBar from './TreeSelectionBar';

// Mock the chatStore module so we can control hook return values.
vi.mock('../../state/chatStore', () => ({
  useChatStore: vi.fn(),
  useChatNodesSnapshot: vi.fn(),
  useChatProjects: vi.fn(),
  useChatActions: vi.fn(),
  useStructuralSelector: vi.fn(),
}));

import * as chatStoreModule from '../../state/chatStore';

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    treeSelection: new Set<string>(),
    clearTreeSelection: vi.fn(),
    selectAllTrees: vi.fn(),
    bulkArchiveTrees: vi.fn(),
    bulkDeleteTrees: vi.fn(),
    createMergedChat: vi.fn(),
    activeProject: {
      id: 'proj-1',
      name: 'Test',
      chatIds: ['n-1', 'n-2'],
      edges: [],
      createdAt: 0,
      trees: [
        { id: 't-1', rootNodeId: 'n-1', name: 'Thread 1', lastActiveAt: 0 },
        { id: 't-2', rootNodeId: 'n-2', name: 'Thread 2', lastActiveAt: 0 },
      ],
      activeTreeId: 't-1',
      artifacts: [],
    },
    ...overrides,
  };
}

function makeNodes(overrides: Record<string, unknown> = {}) {
  return {
    'n-1': { status: 'idle', messages: [], projectId: 'proj-1' },
    'n-2': { status: 'idle', messages: [], projectId: 'proj-1' },
    ...overrides,
  };
}

function mockHooks(store: ReturnType<typeof makeStore>, nodes = makeNodes()) {
  vi.mocked(chatStoreModule.useChatStore).mockReturnValue(store as never);
  vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(nodes as never);
  vi.mocked(chatStoreModule.useChatProjects).mockReturnValue({
    treeSelection: store.treeSelection,
    activeProject: store.activeProject,
  } as never);
  vi.mocked(chatStoreModule.useChatActions).mockReturnValue({
    clearTreeSelection: store.clearTreeSelection,
    selectAllTrees: store.selectAllTrees,
    bulkArchiveTrees: store.bulkArchiveTrees,
    bulkDeleteTrees: store.bulkDeleteTrees,
    createMergedChat: store.createMergedChat,
  } as never);
  vi.mocked(chatStoreModule.useStructuralSelector).mockImplementation(
    ((selector: (nodesMap: Record<string, unknown>) => unknown) => selector(nodes)) as never,
  );
}

describe('TreeSelectionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress window.confirm calls in jsdom
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('does not render Merge when only 1 tree is selected', () => {
    mockHooks(makeStore({ treeSelection: new Set(['t-1']) }));

    render(<TreeSelectionBar />);

    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
    // The bar itself should render (1 selected)
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('renders Merge button when 2 trees are selected', () => {
    mockHooks(makeStore({ treeSelection: new Set(['t-1', 't-2']) }));

    render(<TreeSelectionBar />);

    expect(screen.getByRole('button', { name: /merge/i })).toBeTruthy();
  });

  it('renders Merge as disabled when any selected tree root node is streaming', () => {
    const createMergedChat = vi.fn();
    mockHooks(
      makeStore({ treeSelection: new Set(['t-1', 't-2']), createMergedChat }),
      makeNodes({ 'n-1': { status: 'streaming', messages: [], projectId: 'proj-1' } }),
    );

    render(<TreeSelectionBar />);

    const mergeBtn = screen.getByRole('button', { name: /merge/i });
    expect(mergeBtn.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(mergeBtn);
    expect(createMergedChat).not.toHaveBeenCalled();
  });

  it('calls createMergedChat with root node ids and clearTreeSelection on click', async () => {
    const createMergedChat = vi.fn().mockResolvedValue('n-merged');
    const clearTreeSelection = vi.fn();

    mockHooks(
      makeStore({
        treeSelection: new Set(['t-1', 't-2']),
        createMergedChat,
        clearTreeSelection,
      }),
    );

    render(<TreeSelectionBar />);

    fireEvent.click(screen.getByRole('button', { name: /merge/i }));

    expect(createMergedChat).toHaveBeenCalledOnce();
    // Should be called with the root node ids for the selected trees
    const callArg: string[] = createMergedChat.mock.calls[0][0];
    expect(callArg).toHaveLength(2);
    expect(callArg).toContain('n-1');
    expect(callArg).toContain('n-2');
    await waitFor(() => expect(clearTreeSelection).toHaveBeenCalledOnce());
  });
});
