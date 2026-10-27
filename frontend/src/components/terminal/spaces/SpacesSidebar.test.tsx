import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('./AssistantHistory', () => ({ AssistantHistory: () => <nav aria-label="Assistant conversations" /> }));

const data = vi.hoisted(() => ({
  firstRun: null as unknown,
  homes: null as unknown,
  homesStatus: 'ready',
  homesError: null as string | null,
  refreshHomes: vi.fn(),
  setHidden: vi.fn(async (..._args: unknown[]) => ({})),
  refreshFirstRun: vi.fn(async () => {}),
  info: null as unknown,
  overview: null as unknown,
  sections: null as unknown,
  sectionReads: [] as string[],
  spaceReads: [] as string[],
  databaseReads: [] as string[],
  databases: {} as Record<string, unknown[]>,
  treeStatus: 'ready',
  spaces: [
    { id: 'space-1', workspaceId: 'ws-a', parentId: null, position: 0, title: 'Release', pendingProposals: 1 },
  ],
  pages: [
    { id: 'space-1', workspaceId: 'ws-a', parentId: null, position: 0, title: 'Release', pendingProposals: 1 },
    { id: 'page-2', workspaceId: 'ws-a', parentId: 'space-1', position: 0, title: 'Risks', pendingProposals: 0 },
  ],
}));

const LOCAL_PROJECTS = [
  { id: 'ws-a', name: 'Alpha' },
  { id: 'ws-b', name: 'Beta' },
  { id: 'sys', name: 'Assistant', system: true },
];
const projects = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; system?: boolean }> }));
vi.mock('../../../state/chatStore', () => ({ useChatProjects: () => ({ projects: projects.list }) }));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { workspaceOrder: [] } }) }));
vi.mock('../../../config/backendConnections', () => ({ backendConnectionIdForWorkspace: (id: string) => (id.startsWith('remote:') ? 'box' : 'local') }));
vi.mock('../../../state/pages/useSpaces', () => ({ useSpaces: (connectionId: string) => { data.spaceReads.push(connectionId); return { spaces: data.spaces, status: 'ready', error: null, refresh: vi.fn() }; } }));
vi.mock('../../../state/pages/useSpaceTree', () => ({ useSpaceTree: () => ({ pages: data.pages, status: data.treeStatus, error: null, refresh: vi.fn() }) }));
vi.mock('../../../state/pages/pageEvents', () => ({ subscribePageChanges: () => () => {} }));
vi.mock('../../../state/pages/useSpacesHome', () => ({ useSpacesHomeWorkspaces: () => ({ data: data.homes, status: data.homesStatus, error: data.homesError, stale: !!data.homesError, refresh: data.refreshHomes }) }));
vi.mock('../../../services/api/pages', () => ({ listWorkspaceDatabases: (workspaceId: string) => {
  data.databaseReads.push(workspaceId);
  return Promise.resolve(data.databases[workspaceId] ?? []);
} }));
vi.mock('./home/homeCounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./home/homeCounts')>()),
  useSpacesHomeSections: (connectionId: string) => { data.sectionReads.push(connectionId); return { data: data.sections, status: 'ready', error: null, stale: false, refresh: vi.fn() }; },
}));
vi.mock('../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: data.firstRun, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
  refreshSpacesFirstRun: data.refreshFirstRun,
}));
vi.mock('../../../services/api/spacesHome', () => ({ setWorkspaceHomeHidden: data.setHidden }));
vi.mock('../../../state/metaAgent/useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/metaAgent/useMetaAgent')>()),
  useMetaAgent: () => ({ status: 'ready', info: data.info, error: null }),
}));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentOverview: () => ({ status: 'ready', overview: data.overview, error: null }) }));

import { SpacesSidebar } from './SpacesSidebar';
import { markWorkspaceHomeOpened, resetSpacesFirstRunStore } from '../../../state/metaAgent/spacesFirstRun';

const INFO = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const run = (workspaceId: string, state: string, readCount: number, total: number, updatedAt = 5) => ({
  workspaceId, startedAt: 1, startSeq: 10, readCount, total, state, error: null, updatedAt,
});
const status = (alpha: ReturnType<typeof run>, beta: ReturnType<typeof run>, summary = 'waiting') => ({
  requestedAt: 1,
  workspaces: [
    { workspaceId: 'ws-a', workspaceName: 'Alpha', homePageId: 'ha', hasContent: true, hiddenAt: null, firstRun: alpha },
    { workspaceId: 'ws-b', workspaceName: 'Beta', homePageId: 'hb', hasContent: true, hiddenAt: null, firstRun: beta },
  ],
  summary: { state: summary, summarizedAt: null },
  haltedReason: null,
});

function renderSidebar(overrides: Partial<React.ComponentProps<typeof SpacesSidebar>> = {}) {
  const props = {
    current: { kind: 'home' as const }, waitingCount: 3, onOpenHome: vi.fn(), onOpenWorkspace: vi.fn(), onOpenPage: vi.fn(),
    onOpenAssistant: vi.fn(), onNewSpace: vi.fn(), ...overrides,
  };
  render(<SpacesSidebar {...props} />);
  return props;
}

describe('SpacesSidebar', () => {
  it('keeps Spaces settings in the fixed footer and marks its internal page selected', () => {
    const props = renderSidebar({ settingsOpen: true, onOpenSettings: vi.fn() });
    const settings = screen.getByRole('button', { name: 'Pages settings' });
    expect(settings.closest('.area-side__grow')).toBeNull();
    expect(settings.closest('.area-side__foot')).toBeTruthy();
    expect(settings.getAttribute('aria-current')).toBe('page');
    fireEvent.click(settings);
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('navigation', { name: 'Assistant conversations' })).toBeTruthy();
  });
  beforeEach(() => {
    localStorage.removeItem('michi.spaces-sidebar.expanded');
    localStorage.removeItem('michi.spaces-home.opened');
    resetSpacesFirstRunStore();
    data.firstRun = null;
    data.homes = status(run('ws-a', 'done', 1, 1), run('ws-b', 'done', 1, 1), 'done').workspaces.map((home) => ({ ...home, firstRun: null }));
    data.homesStatus = 'ready';
    data.homesError = null;
    data.refreshHomes.mockClear();
    data.info = INFO;
    data.overview = null;
    data.spaces = [{ id: 'space-1', workspaceId: 'ws-a', parentId: null, position: 0, title: 'Release', pendingProposals: 1 }];
    data.setHidden.mockClear();
    data.refreshFirstRun.mockClear();
    data.sections = null;
    data.sectionReads = [];
    data.spaceReads = [];
    data.databaseReads = [];
    data.databases = { 'ws-a': [{ id: 'db-1', workspaceId: 'ws-a', title: 'Launch list', rowCount: 6, updatedAt: 1 }] };
    data.treeStatus = 'ready';
    projects.list = LOCAL_PROJECTS;
  });

  it('omits remote placeholder workspaces and reads nothing from their connection', async () => {
    projects.list = [...LOCAL_PROJECTS, { id: 'remote:box:ws-r', name: 'Far away' }];
    renderSidebar();
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(screen.queryByText('Far away')).toBeNull();
    expect(data.spaceReads).not.toContain('box');
    expect(data.sectionReads).not.toContain('box');
    expect(data.databaseReads).not.toContain('remote:box:ws-r');
  });

  it('starts with Home and Assistant, then Spaces and Databases, with no All threads or search box', async () => {
    renderSidebar();
    const home = screen.getByRole('button', { name: /^Home/ });
    expect(home.getAttribute('aria-current')).toBe('page');
    expect(home.textContent).toContain('3');
    expect(screen.queryByRole('button', { name: /All threads/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeTruthy();
    expect(screen.getByText('Pages')).toBeTruthy();
    expect(screen.getByText('Databases')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText('Assistant', { selector: '.area-side__main *' })).toBeNull();
    expect(await screen.findByText('Launch list')).toBeTruthy();
    expect(document.querySelector('.spaces-side__footer [role="status"]')).toBeNull();
  });

  it('opens the workspace home on row click and only expands from the chevron, remembering it', () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(props.onOpenWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws-a', backendConnectionId: 'local' });
    expect(screen.queryByText('Release')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand Beta' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Alpha' }));
    expect(props.onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^Release/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Risks' }));
    expect(props.onOpenPage).toHaveBeenCalledWith({ pageId: 'page-2', workspaceId: 'ws-a', backendConnectionId: 'local' });
    expect(JSON.parse(localStorage.getItem('michi.spaces-sidebar.expanded')!)).toEqual(['local:ws-a']);
  });

  it('marks a workspace with waiting suggestions and hides system workspaces', () => {
    renderSidebar();
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    expect(alpha.querySelector('[data-tone="waiting"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Beta' }).querySelector('[data-tone="calm"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Assistant workspace' })).toBeNull();
    expect(document.querySelectorAll('[data-workspace]')).toHaveLength(2);
  });

  it('opens a child page menu without navigating and supports right-click on the same row', async () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Alpha' }));
    const trigger = screen.getByRole('button', { name: 'Actions for Risks' });
    fireEvent.click(trigger);
    expect(screen.getByText('Add a page inside')).toBeTruthy();
    expect(screen.getByText('Move…')).toBeTruthy();
    expect(screen.getByText('Move to trash')).toBeTruthy();
    expect(props.onOpenPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Rename'));
    expect(await screen.findByRole('dialog', { name: 'Rename page' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Risks');
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Risks' }));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(props.onOpenPage).not.toHaveBeenCalled();
  });

  it('disables page mutations when only a stale sidebar tree is available', () => {
    data.treeStatus = 'error';
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Risks' }));
    for (const name of ['Add a page inside', 'Rename', 'Move…', 'Move to trash']) {
      expect(screen.getByRole('menuitem', { name }).getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('omits the Meta agent reminder beneath settings', () => {
    renderSidebar();
    expect(screen.queryByText('Meta agent · Claude · checks new conversations every 60 s')).toBeNull();
  });

  it('shows the first read on the rows: a spinner on Home, n/m while reading, Queued after it, and the total below', () => {
    data.homes = null;
    data.firstRun = status(run('ws-a', 'reading', 12, 21), run('ws-b', 'queued', 0, 17));
    renderSidebar();
    const home = screen.getByRole('button', { name: /^Home/ });
    expect(home.querySelector('.agent-spinner')).not.toBeNull();
    expect(home.textContent).not.toContain('3');
    expect(screen.getByLabelText('Reading 12 of 21').textContent).toBe('12/21');
    const beta = document.querySelector('[data-workspace="ws-b"]')!;
    expect(beta.getAttribute('data-first-run')).toBe('queued');
    expect(beta.textContent).toContain('Queued');
    expect(beta.querySelector('[data-tone="pending"]')).not.toBeNull();
    expect(screen.queryByText('Meta agent is reading 12/38')).toBeNull();
  });

  it('after the first run, a later Spaces Home summary leaves Home and the bottom row ordinary', () => {
    for (const summary of ['due', 'running']) {
      data.firstRun = { ...status(run('ws-a', 'done', 21, 21), run('ws-b', 'done', 17, 17), summary), closed: true };
      const view = render(<SpacesSidebar current={{ kind: 'home' }} waitingCount={3} onOpenHome={vi.fn()} onOpenWorkspace={vi.fn()} onOpenPage={vi.fn()}
        onOpenAssistant={vi.fn()} onNewSpace={vi.fn()} />);
      const home = screen.getByRole('button', { name: /^Home/ });
      expect(home.querySelector('.agent-spinner')).toBeNull();
      expect(screen.getByLabelText('3 waiting')).toBeTruthy();
      expect(screen.queryByText('Meta agent · Claude · checks new conversations every 60 s')).toBeNull();
      expect(screen.queryByText(/Meta agent is reading/)).toBeNull();
      view.unmount();
    }
  });

  it('marks a home the first run wrote as New until it is opened', () => {
    data.firstRun = status(run('ws-a', 'done', 21, 21, 50), run('ws-b', 'done', 0, 0, 50), 'done');
    renderSidebar();
    expect(document.querySelector('[data-workspace="ws-a"]')!.textContent).toContain('New');
    expect(document.querySelector('[data-workspace="ws-b"]')!.textContent).not.toContain('New');
    act(() => markWorkspaceHomeOpened('local', 'ws-a', 50));
    expect(document.querySelector('[data-workspace="ws-a"]')!.textContent).not.toContain('New');
  });

  it('colours each workspace by its Michi conversations: waiting first, then stalled, else calm', () => {
    data.spaces = [];
    data.sections = { waiting: { items: [], total: 1 }, stalled: { items: [], total: 1 }, done: { items: [], total: 0 }, conversations: { available: true },
      byWorkspace: { 'ws-a': { waiting: 0, stalled: 2 }, 'ws-b': { waiting: 1, stalled: 4 } } };
    renderSidebar();
    expect(screen.getByRole('button', { name: /^Alpha/ }).querySelector('[data-tone="stalled"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Beta/ }).querySelector('[data-tone="waiting"]')).not.toBeNull();
  });

  it('hides empty homes, including a successful empty run, while preserving explicitly created pages', () => {
    data.homes = [
      { workspaceId: 'ws-a', homePageId: 'ha', hasContent: false, hiddenAt: null, firstRun: null },
      { workspaceId: 'ws-b', homePageId: 'hb', hasContent: false, hiddenAt: null, firstRun: run('ws-b', 'done', 4, 4) },
    ];
    renderSidebar();
    // Alpha has a custom Space; Beta only has an empty default home.
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Beta/ })).toBeNull();
  });

  it('keeps a populated home visible while another read is running or its refresh fails', () => {
    data.spaces = [];
    data.homes = [{ workspaceId: 'ws-b', homePageId: 'hb', hasContent: true, hiddenAt: null, firstRun: run('ws-b', 'writing', 4, 4) }];
    data.homesError = 'Backend unavailable';
    renderSidebar();
    expect(screen.getByRole('button', { name: /^Beta/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Alpha/ })).toBeNull();
  });

  it('shows a newly written home from first-run progress before the next summary poll', () => {
    data.spaces = [];
    data.homes = [{ workspaceId: 'ws-b', homePageId: 'hb', hasContent: false, hiddenAt: null, firstRun: run('ws-b', 'writing', 4, 4, 10) }];
    const complete = status(run('ws-a', 'done', 0, 0, 20), run('ws-b', 'done', 4, 4, 20), 'done');
    complete.workspaces[0]!.hasContent = false;
    data.firstRun = complete;
    renderSidebar();
    expect(screen.getByRole('button', { name: /^Beta/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Alpha/ })).toBeNull();
  });

  it('does not discard an existing home when an older backend omits content availability', () => {
    data.spaces = [];
    data.homes = [{ workspaceId: 'ws-b', homePageId: 'hb', hiddenAt: null, firstRun: null }];
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
  });

  it('turns a workspace red for a suggestion waiting on its home, not only on its Spaces', () => {
    data.spaces = [];
    const homes = status(run('ws-a', 'done', 1, 1), run('ws-b', 'done', 1, 1), 'done') as { workspaces: Array<Record<string, unknown>> };
    homes.workspaces[1]!.pendingProposals = 2;
    data.homes = null;
    data.firstRun = homes;
    renderSidebar();
    expect(screen.getByRole('button', { name: /^Alpha/ }).querySelector('[data-tone="calm"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Beta/ }).querySelector('[data-tone="waiting"]')).not.toBeNull();
  });

  it('hides a workspace from Spaces through its row menu and lists it under Hidden, where it can be shown again', async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Beta' }));
    expect(screen.queryByText('Delete')).toBeNull();
    fireEvent.click(await screen.findByText('Hide from Pages'));
    await vi.waitFor(() => expect(data.setHidden).toHaveBeenCalledWith('ws-b', true, 'local'));
    await vi.waitFor(() => expect(data.refreshFirstRun).toHaveBeenCalledWith('local'));
  });

  it('keeps hidden workspaces out of the list behind a Hidden row', async () => {
    const homes = status(run('ws-a', 'done', 1, 1), run('ws-b', 'done', 1, 1), 'done') as { workspaces: Array<Record<string, unknown>> };
    homes.workspaces[1]!.hiddenAt = 99;
    data.homes = null;
    data.firstRun = homes;
    renderSidebar();
    expect(document.querySelector('[data-workspace="ws-b"]')).toBeNull();
    const hiddenRow = screen.getByRole('button', { name: /Hidden from Pages/ });
    expect(hiddenRow.textContent).toContain('1');
    fireEvent.click(hiddenRow);
    expect(document.querySelector('[data-workspace="ws-b"]')!.hasAttribute('data-hidden')).toBe(true);
    fireEvent.contextMenu(document.querySelector('[data-workspace="ws-b"]')!);
    fireEvent.click(await screen.findByText('Show in Pages'));
    await vi.waitFor(() => expect(data.setHidden).toHaveBeenCalledWith('ws-b', false, 'local'));
  });
  it("offers All tasks with every workspace's task count, and leaves the task databases out of Databases", async () => {
    data.databases = {
      'ws-a': [
        { id: 'db-1', workspaceId: 'ws-a', title: 'Launch list', rowCount: 6, updatedAt: 1 },
        { id: 'tasks-a', workspaceId: 'ws-a', title: 'Tasks', role: 'tasks', rowCount: 4, updatedAt: 1 },
      ],
      'ws-b': [{ id: 'tasks-b', workspaceId: 'ws-b', title: 'Tasks', role: 'tasks', rowCount: 3, updatedAt: 1 }],
    };
    const props = renderSidebar({ onOpenAllTasks: vi.fn() });
    const row = screen.getByRole('button', { name: /^All tasks/ });
    expect(await within(row).findByLabelText('7 tasks')).toBeTruthy();
    expect(await screen.findByText('Launch list')).toBeTruthy();
    expect(screen.queryByText('Tasks')).toBeNull();
    fireEvent.click(row);
    expect(props.onOpenAllTasks).toHaveBeenCalledOnce();
  });

  it('marks All tasks current while it is shown', () => {
    renderSidebar({ current: { kind: 'all-tasks' }, onOpenAllTasks: vi.fn() });
    expect(screen.getByRole('button', { name: /^All tasks/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /^Home/ }).getAttribute('aria-current')).toBeNull();
  });

  it('has no All tasks where nothing opens it', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: /^All tasks/ })).toBeNull();
  });
});
