import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import { getAssistantSnapshot, resetAssistantStoreForTests } from '../../state/assistant/assistantStore';

// One user workspace and the assistant's hidden one, each with a chat whose
// title and messages match "plan".
const projects = vi.hoisted(() => [
  { id: 'w1', name: 'Workspace A', trees: [], chatIds: ['n1'], edges: [], createdAt: 1, activeTreeId: null },
  { id: 'sys', name: 'Assistant', system: 'assistant', trees: [], chatIds: ['n-sys'], edges: [], createdAt: 2, activeTreeId: null },
]);
const nodes = vi.hoisted(() => ({
  n1: { nodeId: 'n1', projectId: 'w1', title: 'Plan the launch', messages: [] },
  'n-sys': { nodeId: 'n-sys', projectId: 'sys', title: 'Plan with the assistant', messages: [] },
}));

const palette = vi.hoisted(() => ({ active: null as null | Record<string, unknown> }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('../../state/chatStore')>('../../state/chatStore');
  return {
    selectAllChats: actual.selectAllChats,
    useChatNodesSnapshot: () => nodes,
    useChatStore: () => ({
      activeProject: palette.active,
      projects,
      selection: new Set<string>(),
      clearSelection: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), createDigest: vi.fn(),
      createMergedChat: vi.fn(), createThread: vi.fn(), activateTree: vi.fn(), archiveTree: vi.fn(),
      unarchiveTree: vi.fn(), selectProject: vi.fn(), setFocusedNodeId: vi.fn(), setSearchHighlightTerm: vi.fn(),
    }),
  };
});
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }) }));
vi.mock('../../state/useServerSearch', () => ({
  useServerSearch: (query: string) => ({
    matches: query ? [
      { projectId: 'w1', projectName: 'Workspace A', nodeId: 'n1', nodeTitle: 'Plan the launch', messageId: 'm1', messageIdx: 0, role: 'user', snippet: 'plan A', range: [0, 4] },
      { projectId: 'sys', projectName: 'Assistant', nodeId: 'n-sys', nodeTitle: 'Plan with the assistant', messageId: 'm2', messageIdx: 0, role: 'user', snippet: 'plan secret', range: [0, 4] },
    ] : [],
    truncated: false,
    totalUnbounded: 0,
  }),
}));
vi.mock('../../state/useNodeSearch', () => ({
  useNodeSearch: (query: string) => ({
    nodes: query ? [
      { nodeId: 'n1', workspaceId: 'w1', workspaceName: 'Workspace A', nodeTitle: 'Plan the launch', treeId: null, lastMessageAt: 1, totalMatches: 1, breadcrumb: ['Workspace A'], snippets: [{ messageId: 'm1', role: 'user', snippet: 'plan A' }] },
      { nodeId: 'n-sys', workspaceId: 'sys', workspaceName: 'Assistant', nodeTitle: 'Plan with the assistant', treeId: null, lastMessageAt: 2, totalMatches: 1, breadcrumb: ['Assistant'], snippets: [{ messageId: 'm2', role: 'user', snippet: 'plan secret' }] },
    ] : [],
    totalNodes: query ? 2 : 0,
    loading: false,
  }),
}));
vi.mock('../../state/navigateToNode', () => ({ navigateToNode: vi.fn() }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  resetAssistantStoreForTests();
});
afterEach(() => resetAssistantStoreForTests());

function search(query: string) {
  fireEvent.change(screen.getByPlaceholderText('Search chats, commands, messages…'), { target: { value: query } });
}

describe('CommandPalette and the assistant', () => {
  it('never offers the assistant workspace or its conversation', async () => {
    render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
    search('plan');
    // Message search runs on the debounced query.
    await screen.findByText(/Messages · 1 node$/);
    expect(document.body.textContent).toContain('Plan the launch');
    expect(document.body.textContent).not.toContain('Plan with the assistant');
    expect(document.body.textContent).not.toContain('plan secret');
    search('Assistant');
    expect(screen.queryByText('Switch to workspace ▸ Assistant')).toBeNull();
    search('Workspace A');
    expect(screen.getByText('Switch to workspace ▸ Workspace A')).toBeTruthy();
  });

  it('hides the assistant conversation from search before its workspace is loaded', async () => {
    const [sys] = projects.splice(1, 1);
    resetAssistantStoreForTests({
      status: 'ready',
      info: { nodeId: 'n-sys', workspaceId: 'sys', treeId: 't', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] },
    });
    try {
      render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('plan');
      await screen.findByText(/Messages · 1 node$/);
      expect(document.body.textContent).not.toContain('plan secret');
    } finally {
      projects.splice(1, 0, sys);
    }
  });

  it('offers none of the assistant workspace threads while it is the active one', () => {
    const tree = (id: string, archivedAt?: number) => ({ id, rootNodeId: 'n-sys', name: `Conversation ${id}`, createdAt: 1, lastActiveAt: 1, ...(archivedAt ? { archivedAt } : {}) });
    const user = { ...projects[0], trees: [tree('t-user')], activeTreeId: 't-user' };
    palette.active = user;
    try {
      const view = render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('Archive current');
      expect(screen.getByText('Archive current thread')).toBeTruthy();
      view.unmount();
      palette.active = { ...projects[1], trees: [tree('t-new'), tree('t-old', 5)], activeTreeId: 't-new' };
      render(<CommandPalette activePage="dashboard" setPage={vi.fn()} onClose={vi.fn()} />);
      search('thread');
      expect(screen.queryByText('Archive current thread')).toBeNull();
      expect(screen.queryByText(/Switch to archived thread/)).toBeNull();
      expect(screen.getByText('New thread')).toBeTruthy();
    } finally {
      palette.active = null;
    }
  });

  it('opens the assistant with ⌘J shown', () => {
    const onClose = vi.fn();
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={onClose} />);
    search('ask the');
    const row = screen.getByText('Ask the assistant');
    fireEvent.click(row);
    expect(onClose).toHaveBeenCalled();
    expect(getAssistantSnapshot().open).toBe(true);
  });

  it('has no assistant entry when this backend has none', () => {
    resetAssistantStoreForTests({ status: 'unsupported' });
    render(<CommandPalette activePage="home" setPage={vi.fn()} onClose={vi.fn()} />);
    search('ask the');
    expect(screen.queryByText('Ask the assistant')).toBeNull();
  });
});
