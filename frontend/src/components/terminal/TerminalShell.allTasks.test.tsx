import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { requestAllTasks } from '../../state/pages/allTasksNav';
import { getSourceNavState, openConversationFromSpaces, resetSourceNavForTests, returnToSourceOrigin } from '../../state/sourceNav/sourceNav';

const projects = vi.hoisted(() => [{ id: 'ws-1', name: 'rabbitholes', chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, cwd: '/tmp/r' }]);

vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./spaces/SpacesPage', async () => {
  const actual = await vi.importActual<typeof import('./spaces/SpacesPage')>('./spaces/SpacesPage');
  return {
    ...actual,
    default: ({ target }: { target: { kind: string; workspaceId?: string } }) => (
      <div data-testid="spaces-main">{target.kind === 'all-tasks' ? 'all tasks' : target.kind === 'workspace' ? `workspace home ${target.workspaceId}` : 'spaces home'}</div>
    ),
  };
});
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/pages/useSpacesHome', async () => {
  const actual = await vi.importActual<typeof import('../../state/pages/useSpacesHome')>('../../state/pages/useSpacesHome');
  return { ...actual, useSpacesHomeWorkspaces: () => ({ data: [{ workspaceId: 'ws-1', homePageId: 'home-ws-1', hasContent: true }], refresh: vi.fn() }) };
});
vi.mock('../../services/api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/pages')>()),
  listWorkspaceDatabases: async () => [{ id: 'tasks-1', workspaceId: 'ws-1', title: 'Tasks', role: 'tasks', rowCount: 5, updatedAt: 1 }],
}));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      activeProject: null, activeProjectId: null, projects, order: [], edges: [], theme: 'light', availableModes: [],
      agentStatus: null, warmFailedError: null, focusedNodeId: null, selection: new Set<string>(), hydrated: true,
      treeSelection: new Set<string>(), searchHighlightTerm: null,
    }),
    useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatActions: () => ({
      createProject: vi.fn(), enterChatsWorkspace: () => Promise.resolve('chats-default'), focusPane: () => {}, closePane: () => {},
      openPane: () => {}, createBlankChild: vi.fn(), restoreLastDeletion: vi.fn(), clearSelection: () => {}, clearTreeSelection: () => {},
      selectAllTrees: () => {}, selectProject: () => {}, openPaneInTree: () => {}, activateTree: () => {}, setFocusedNodeId: () => {},
      revealBackendNode: async () => true,
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const crumb = () => document.querySelector('.terminal-topbar-breadcrumb')?.textContent?.replace(/\s+/g, ' ').trim();
const sidebar = () => screen.getByLabelText('Pages navigation');

describe('TerminalShell: All tasks', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetSourceNavForTests();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
  });

  it('opens on request and from the sidebar, names itself in the crumb and is marked current', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    act(() => requestAllTasks());
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('all tasks');
    expect(rail('spaces').getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(crumb()).toBe('PAGES›All tasks'));
    const row = within(sidebar()).getByRole('button', { name: /^All tasks/ });
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(await within(row).findByLabelText('5 tasks')).toBeTruthy();

    fireEvent.click(within(sidebar()).getByRole('button', { name: /^Home/ }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('spaces home');
    fireEvent.click(within(sidebar()).getByRole('button', { name: /^All tasks/ }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('all tasks');
    expect(crumb()).toBe('PAGES›All tasks');
  });

  it('comes back to All tasks from a conversation opened there', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    act(() => requestAllTasks());
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('all tasks');
    await act(async () => { await openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: 'ws-1', nodeId: 'n1', messageId: null }); });
    expect(getSourceNavState().back?.origin).toEqual({ kind: 'all-tasks', title: 'All tasks' });
    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    act(() => returnToSourceOrigin());
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('all tasks');
    expect(crumb()).toBe('PAGES›All tasks');
  });
});
