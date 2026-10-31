import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { setKnownBackendConnections } from '../../../config/backendConnections';
import { AuthSessionContext } from '../../../services/auth';
import SettingsMain, { type SettingsLevel } from './SettingsMain';
import type { SettingsPage } from './settingsPages';

const store = vi.hoisted(() => ({
  metaAgentAlert: false,
  projects: [] as Array<{ id: string; deletedAt?: number }>,
  nodes: {} as Record<string, { nodeId: string; projectId: string; deletionGroupId?: string; pageId?: string | null }>,
  agentStatus: null as null | { runtime: string; label: string; model?: string },
}));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentSettingsAlert: () => store.metaAgentAlert }));
vi.mock('../settings/metaAgent/MetaAgentSettings', () => ({ MetaAgentSettings: () => <div>Meta agent settings</div> }));
vi.mock('../pages/settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('./GeneralTopicPage', () => ({ default: ({ page }: { page: string }) => <div>Topic page: {page}</div> }));
vi.mock('../../../state/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../state/prefs')>();
  const prefs = { ...actual.DEFAULT_PREFS, terminalPalette: 'bone' as const, terminalAccentOverrides: {}, notifications: 'approval-only' as const };
  return { ...actual, usePrefs: () => ({ prefs, setPref: () => {} }) };
});
vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: null, projects: store.projects, agentStatus: store.agentStatus }),
    useStructuralSelector: (selector: (nodes: typeof store.nodes) => unknown) => selector(store.nodes),
  };
});

/** Settings with its page and level owned by a host, as the shell does. */
function Host({ initial = 'appearance', initialView = 'menu', stacked = false, onPageChange, onNav = () => {}, workspaceReady }: {
  initial?: SettingsPage;
  initialView?: SettingsLevel;
  stacked?: boolean;
  onPageChange?: (page: SettingsPage) => void;
  onNav?: (page: string) => void;
  workspaceReady?: boolean;
}) {
  const [page, setPage] = React.useState<SettingsPage>(initial);
  const [view, setView] = React.useState<SettingsLevel>(initialView);
  return <>
    <SettingsMain page={page} onPageChange={(next) => { setPage(next); onPageChange?.(next); }} view={view} onViewChange={setView}
      stacked={stacked} onNav={onNav} workspaceReady={workspaceReady} />
    {/* The shell's header Back, on a phone. */}
    <button type="button" onClick={() => setView('menu')}>Host back</button>
    {/* A request for one page, like the Meta agent's alert. */}
    <button type="button" onClick={() => { setPage('meta-agent'); setView('section'); }}>Host request</button>
  </>;
}

const sections = () => screen.getByRole('navigation', { name: 'Settings sections' });
const button = (name: string) => within(sections()).getByRole('button', { name, exact: true } as never);
const description = (element: HTMLElement) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? null;
const root = () => document.querySelector<HTMLElement>('.terminal-settings')!;

beforeEach(() => {
  store.metaAgentAlert = false;
  store.projects = [{ id: 'ws-1' }, { id: 'ws-gone', deletedAt: 5 }];
  store.nodes = {
    a: { nodeId: 'a', projectId: 'ws-1', deletionGroupId: 'del-1' },
    helper: { nodeId: 'helper', projectId: 'ws-1', deletionGroupId: 'del-2', pageId: 'page-1' },
    arch: { nodeId: 'arch', projectId: 'ws-1', deletionGroupId: 'arch-1' },
  };
  store.agentStatus = { runtime: 'claude', label: 'Claude Code', model: 'claude-opus-5-5' };
  setKnownBackendConnections([]);
});

describe('Settings window', () => {
  it('lists every page in its group, with Trash and Archived counts and keyboard shortcuts', () => {
    render(<Host />);
    expect(root().classList.contains('terminal-settings--window')).toBe(true);
    expect(within(sections()).getAllByRole('group').map((group) => group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['Agent', 'Connections', 'App', 'Data', 'About']);
    expect(within(within(sections()).getByRole('group', { name: 'Connections' })).getAllByRole('button').map((item) => item.textContent)).toEqual(['Machines']);
    const about = within(sections()).getByRole('group', { name: 'About' });
    expect(within(about).getAllByRole('button').map((item) => item.textContent)).toEqual(['Scheduled jobs', 'Keyboard shortcuts']);
    // A deleted thread group plus a deleted workspace; the page helper is not a thread.
    expect(description(button('Trash'))).toBe('2');
    expect(description(button('Archived'))).toBe('1');
    expect(button('Appearance').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
  });

  it('opens a page from its group, and Trash as its own page', async () => {
    const onPageChange = vi.fn();
    const onNav = vi.fn();
    render(<Host onPageChange={onPageChange} onNav={onNav} />);
    fireEvent.click(button('Notifications'));
    expect(onPageChange).toHaveBeenCalledWith('notifications');
    expect(await screen.findByText('Topic page: notifications')).toBeTruthy();
    expect(button('Notifications').getAttribute('aria-current')).toBe('page');
    fireEvent.click(button('Keyboard shortcuts'));
    expect(await screen.findByText('Topic page: shortcuts')).toBeTruthy();
    fireEvent.click(button('Trash'));
    expect(onNav).toHaveBeenCalledWith('trash');
  });

  it('marks the pages that need attention', () => {
    store.metaAgentAlert = true;
    setKnownBackendConnections([{ id: 'dd', name: 'Dev desktop', transport: 'ssh', tunnelStatus: 'error', hasToken: true, createdAt: 1, updatedAt: 1 }]);
    render(<Host />);
    expect(button('Meta agent, needs attention')).toBeTruthy();
    expect(button('Machines, connection issue')).toBeTruthy();
    expect(document.querySelectorAll('.settings-window__alert')).toHaveLength(2);
  });

  it('lists Account only for a signed-in user', () => {
    const user = { email: 'someone@example.com', name: 'Someone' };
    render(<AuthSessionContext.Provider value={{ user } as never}><Host /></AuthSessionContext.Provider>);
    expect(button('Account')).toBeTruthy();
  });

  it('searches names, descriptions and preference keys, and opens a result on its page', async () => {
    const onPageChange = vi.fn();
    render(<Host initial="notifications" onPageChange={onPageChange} />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'motion' } });
    const results = screen.getByRole('region', { name: 'Search results' });
    const names = within(results).getAllByRole('button').map((hit) => hit.querySelector('.settings-window__name')?.textContent);
    expect(names[0]).toBe('Reduce motion');
    expect(names).toContain('Pane animation');
    expect(within(results).getByText('App › Appearance')).toBeTruthy();
    // While searching, no page is the current one.
    expect(button('Notifications').hasAttribute('aria-current')).toBe(false);
    // A preference key finds its setting too.
    fireEvent.change(search, { target: { value: 'theme.codeWrap' } });
    expect(within(screen.getByRole('region', { name: 'Search results' })).getByText('Code wrap')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'motion' } });
    // Enter opens the first result: its page, with the query cleared.
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPageChange).toHaveBeenLastCalledWith('appearance');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
  });

  it('opens Advanced for an advanced setting a result points at', async () => {
    render(<Host initial="notifications" />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'corner radius' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Search results' })).getByRole('button'));
    expect(await screen.findByRole('slider', { name: 'Corner radius' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advanced/i }).getAttribute('aria-expanded')).toBe('true');
  });

  it('says when nothing matches, and Escape clears the query before it reaches the window', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<Host />);
      const search = screen.getByRole('searchbox', { name: 'Search settings' });
      fireEvent.change(search, { target: { value: 'zzzz' } });
      expect(screen.getByRole('status').textContent).toBe('No settings match “zzzz”.');
      fireEvent.keyDown(search, { key: 'Escape' });
      expect((search as HTMLInputElement).value).toBe('');
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
      // With no query, Escape goes on to the window, which closes it.
      fireEvent.keyDown(search, { key: 'Escape' });
      expect(onWindowKey).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('takes ⌘F or Ctrl+F for its search while open', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(<Host />);
      const search = screen.getByRole('searchbox', { name: 'Search settings' });
      button('Notifications').focus();
      fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
      expect(document.activeElement).toBe(search);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('shows the Appearance preview beside its settings', () => {
    render(<Host />);
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
  });
});

describe('Settings list on a phone', () => {
  const row = (name: string) => screen.getByRole('button', { name, exact: true } as never);

  it('groups one row per topic, each with its current value, and has no keyboard shortcuts or search', () => {
    render(<Host stacked />);
    expect(root().getAttribute('data-view')).toBe('menu');
    const agent = within(sections()).getByRole('group', { name: 'Agent' });
    expect(within(agent).getAllByRole('button').map((item) => item.getAttribute('aria-label'))).toEqual(['Runtime & model', 'Meta agent']);
    expect(description(row('Runtime & model'))).toBe('Claude · Opus 5.5');
    expect(description(row('Appearance'))).toBe('Bone · Rust');
    expect(description(row('Notifications'))).toBe('Approval only');
    expect(description(row('Links'))).toBe('Michi Browser');
    expect(description(row('Machines'))).toBe('This machine');
    expect(description(row('Trash'))).toBe('2');
    // Phone access is part of Machines, not a row of its own.
    expect(within(within(sections()).getByRole('group', { name: 'Connections' })).getAllByRole('button').map((item) => item.getAttribute('aria-label'))).toEqual(['Machines']);
    expect(screen.queryByRole('button', { name: /shortcuts/i })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(root().querySelectorAll('.settings-phone__chevron')).toHaveLength(10);
  });

  it('names a machine with a connection issue, and the Meta agent when it needs attention', () => {
    store.metaAgentAlert = true;
    setKnownBackendConnections([{ id: 'dd', name: 'Dev desktop', transport: 'ssh', tunnelStatus: 'error', hasToken: true, createdAt: 1, updatedAt: 1 }]);
    render(<Host stacked />);
    expect(description(row('Machines, connection issue'))).toBe('Connection issue');
    expect(description(row('Meta agent, needs attention'))).toBe('Needs attention');
  });

  it('opens a page alone, focuses its heading, and returns focus to its row on Back', async () => {
    const onPageChange = vi.fn();
    render(<Host stacked onPageChange={onPageChange} />);
    fireEvent.click(row('Notifications'));
    expect(onPageChange).toHaveBeenCalledWith('notifications');
    expect(root().getAttribute('data-view')).toBe('section');
    expect(await screen.findByText('Topic page: notifications')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Host back' }));
    expect(root().getAttribute('data-view')).toBe('menu');
    expect(document.activeElement).toBe(row('Notifications'));
  });

  it('opens a requested page directly', async () => {
    render(<Host stacked />);
    fireEvent.click(screen.getByRole('button', { name: 'Host request' }));
    expect(root().getAttribute('data-view')).toBe('section');
    expect(screen.getByRole('heading', { level: 1, name: 'Meta agent' })).toBeTruthy();
    expect(await screen.findByText('Meta agent settings')).toBeTruthy();
  });

  it('opens Trash and Archived as their pages', () => {
    const onNav = vi.fn();
    const onPageChange = vi.fn();
    render(<Host stacked onNav={onNav} onPageChange={onPageChange} />);
    fireEvent.click(row('Trash'));
    fireEvent.click(row('Archived'));
    expect(onNav.mock.calls).toEqual([['trash'], ['archived']]);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('shows no counts before workspaces load', () => {
    render(<Host stacked workspaceReady={false} />);
    expect(row('Trash').hasAttribute('aria-describedby')).toBe(false);
  });
});
