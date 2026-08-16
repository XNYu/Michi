import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette, { openWorkspaceFromPalette } from './CommandPalette';

const selectProject = vi.hoisted(() => vi.fn());
const navigateToNode = vi.hoisted(() => vi.fn());

vi.mock('../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: {
      id: 'workspace-1',
      name: 'Workspace A',
      trees: [],
      activeTreeId: null,
    },
    projects: [
      { id: 'workspace-1', name: 'Workspace A', trees: [] },
      { id: 'workspace-2', name: 'Workspace B', trees: [] },
    ],
    selection: new Set<string>(),
    clearSelection: vi.fn(),
    openPane: vi.fn(),
    openPaneInTree: vi.fn(),
    createDigest: vi.fn(),
    createMergedChat: vi.fn(),
    createThread: vi.fn(),
    activateTree: vi.fn(),
    archiveTree: vi.fn(),
    unarchiveTree: vi.fn(),
    selectProject,
    setFocusedNodeId: vi.fn(),
    setSearchHighlightTerm: vi.fn(),
  }),
  useChatNodesSnapshot: () => ({}),
  selectAllChats: () => [
    {
      id: 'chat-2',
      title: 'Pricing',
      projectId: 'workspace-2',
      projectName: 'Workspace B',
    },
  ],
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({
    prefs: { bypassPermissions: false },
    setPref: vi.fn(),
  }),
}));

vi.mock('../../state/useServerSearch', () => ({
  useServerSearch: () => ({ matches: [], truncated: false, totalUnbounded: 0 }),
}));

vi.mock('../../state/navigateToNode', () => ({ navigateToNode }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  selectProject.mockReset();
  navigateToNode.mockReset();
});

describe('openWorkspaceFromPalette', () => {
  it('opens the selected workspace on its new-chat page', () => {
    const setPage = vi.fn();
    const onClose = vi.fn();

    openWorkspaceFromPalette('workspace-2', {
      selectProject,
      setPage,
      onClose,
    });

    expect(selectProject).toHaveBeenCalledWith('workspace-2');
    expect(setPage).toHaveBeenCalledWith('home');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('CommandPalette workspace routing', () => {
  it('routes a workspace result to the new-chat page', () => {
    const setPage = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), {
      target: { value: 'Workspace B' },
    });
    fireEvent.click(screen.getByText('Switch to workspace ▸ Workspace B'));

    expect(selectProject).toHaveBeenCalledWith('workspace-2');
    expect(setPage).toHaveBeenCalledWith('home');
  });

  it('keeps a specific chat result on the dashboard', () => {
    const setPage = vi.fn();
    render(<CommandPalette activePage="home" setPage={setPage} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), {
      target: { value: 'Pricing' },
    });
    fireEvent.click(screen.getByText('Pricing · Workspace B'));

    expect(selectProject).toHaveBeenCalledWith('workspace-2');
    expect(navigateToNode).toHaveBeenCalledWith(expect.any(Object), 'chat-2');
    expect(setPage).toHaveBeenCalledWith('dashboard');
  });
});
