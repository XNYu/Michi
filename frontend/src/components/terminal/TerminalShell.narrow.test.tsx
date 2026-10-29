import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';

const topbar = vi.hoisted(() => ({ rail: [] as Array<boolean | undefined> }));

vi.mock('./Topbar', () => ({
  default: ({ sidebarRail, onToggleSidebar }: { sidebarRail?: boolean; onToggleSidebar: () => void }) => {
    topbar.rail.push(sidebarRail);
    return <button type="button" data-sidebar-rail={String(!!sidebarRail)} onClick={onToggleSidebar}>toggle sidebar</button>;
  },
}));
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/Scheduled', () => ({ default: () => <div>Scheduled page</div> }));
vi.mock('./scheduled/metaAgent/MetaAgentDetail', () => ({ default: () => <div>Meta agent detail page</div> }));
vi.mock('./pages/settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
vi.mock('./pages/settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      activeProject: null, activeProjectId: null, projects: [], order: [], edges: [], theme: 'light', availableModes: [],
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

const wideWidth = window.innerWidth;
const areas = () => screen.queryByRole('navigation', { name: 'Areas' });
const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const toggle = () => screen.getByRole('button', { name: 'toggle sidebar' });

describe('TerminalShell in a narrow window', () => {
  beforeEach(() => {
    sessionStorage.clear();
    topbar.rail = [];
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: wideWidth }); });

  it('has no area rail; its drawer opens with the areas as the first row', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(areas()).toBeNull();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');

    fireEvent.click(toggle());
    expect(rail('conversations').getAttribute('aria-current')).toBe('page');
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
    fireEvent.click(toggle());
    expect(areas()).toBeNull();
  });

  it('opens Settings from the drawer, which closes, and keeps its categories in the Settings drawer', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    expect(areas()).toBeNull();
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(screen.getByRole('button', { name: 'Runtime (global)' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBe(sections);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
  });

  it('returns from Settings with a Back button in the top-left corner instead of ×', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const back = within(dialog).getByRole('button', { name: 'Back' });
    expect(dialog.querySelector('.ui-overlay-header')!.firstElementChild).toBe(back);
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(screen.getByText('Conversation home')).toBeTruthy();
  });

  it('steps Back from a Settings section to the section list before closing, and reopens on the list', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const level = () => dialog.querySelector('.terminal-settings--drawer')?.getAttribute('data-view');
    await waitFor(() => expect(level()).toBe('menu'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Runtime (global)' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(level()).toBe('section');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(level()).toBe('menu');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    const reopened = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(reopened.querySelector('.terminal-settings--drawer')?.getAttribute('data-view')).toBe('menu'));
  });

  it('keeps the drawer open on the Scheduled list and closes it when the Meta agent row is picked', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(rail('scheduled').getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByText('Meta agent · maintain Pages'));
    expect(await screen.findByText('Meta agent detail page')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Meta agent · maintain Pages')).toBeNull());
  });

  it('keeps the overlay open when the window is wide, where there is none', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Runtime (global)' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
