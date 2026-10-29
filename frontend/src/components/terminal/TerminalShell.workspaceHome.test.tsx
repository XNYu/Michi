import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { clearHeldWorkspaceHome, readHeldWorkspaceHome, requestWorkspaceHome } from '../../state/pages/workspaceHomeNav';

const projects = vi.hoisted(() => [{ id: 'ws-1', name: 'rabbitholes', chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, cwd: '/tmp/r' }]);

vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./spaces/SpacesPage', async () => {
  const actual = await vi.importActual<typeof import('./spaces/SpacesPage')>('./spaces/SpacesPage');
  return {
    ...actual,
    default: ({ target }: { target: { kind: string; workspaceId?: string } }) => <div data-testid="spaces-main">{target.kind === 'workspace' ? `workspace home ${target.workspaceId}` : 'spaces home'}</div>,
  };
});
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/pages/useSpacesHome', async () => {
  const actual = await vi.importActual<typeof import('../../state/pages/useSpacesHome')>('../../state/pages/useSpacesHome');
  return {
    ...actual,
    useSpacesHomeWorkspaces: () => ({ data: [{ workspaceId: 'ws-1', homePageId: 'home-ws-1', hasContent: true }], refresh: vi.fn() }),
  };
});
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
      selectAllTrees: () => {}, selectProject: () => {},
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
const wideWidth = window.innerWidth;

describe('TerminalShell: a workspace home requested from anywhere', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearHeldWorkspaceHome();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
  });
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: wideWidth }); });

  it('restores the workspace home after leaving Pages for Chat', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    act(() => requestWorkspaceHome({ workspaceId: 'ws-1', backendConnectionId: 'local' }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('workspace home ws-1');
    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('workspace home ws-1');
    expect(crumb()).toBe('PAGES›rabbitholes');
  });

  it('switches to Spaces and names the workspace in the crumb with the narrow sidebar closed', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(screen.queryByLabelText('Pages navigation')).toBeNull();

    act(() => requestWorkspaceHome({ workspaceId: 'ws-1', backendConnectionId: 'local' }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('workspace home ws-1');
    expect(screen.queryByLabelText('Pages navigation')).toBeNull();
    await waitFor(() => expect(crumb()).toBe('PAGES›rabbitholes'));
    expect(readHeldWorkspaceHome()).toBeNull();
    // A narrow window has no rail: the drawer's area row names the current area.
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(rail('spaces').getAttribute('aria-current')).toBe('page');
  });

  it('marks the workspace current in the Spaces sidebar and returns to Home from the rail', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('spaces home');
    expect(crumb()).toBe('PAGES›Home');

    act(() => requestWorkspaceHome({ workspaceId: 'ws-1', backendConnectionId: 'local' }));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('workspace home ws-1');
    expect(crumb()).toBe('PAGES›rabbitholes');
    expect(document.querySelector('[data-workspace="ws-1"]')?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(rail('spaces'));
    expect((await screen.findByTestId('spaces-main')).textContent).toBe('spaces home');
    expect(crumb()).toBe('PAGES›Home');
  });
});
