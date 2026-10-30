import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import TerminalWorkspaces, { buildCard } from './Workspaces';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { displayPath, formatAgo } from './workspaceList';
import { _resetForTest, getManageWorkspaceId } from '../../../state/manageRoute';
import { setKnownBackendConnections } from '../../../config/backendConnections';

const base = { chatIds: [], edges: [], activeTreeId: null, artifacts: [] };
const tree = (id: string, lastActiveAt: number) => ({ id, rootNodeId: `${id}-root`, createdAt: 0, lastActiveAt });

// Newest activity: web-platform (300) › atlas (200) › zeta (100) › shared (0).
const projects = [
  { ...base, id: 'ws-x', name: 'web-platform', cwd: '/Users/someone/code/web', createdAt: 0, trees: [tree('x1', 300)] },
  { ...base, id: 'ws-a', name: 'atlas', createdAt: 0, trees: [tree('a1', 200), tree('a2', 50), tree('a3', 40)] },
  { ...base, id: 'ws-z', name: 'zeta', cwd: '/srv/zeta', backendConnectionId: 'remote-z', createdAt: 0, trees: [tree('z1', 100), tree('z2', 10)] },
  { ...base, id: 'ws-s', name: 'shared', cwd: '/Users/Shared/proj', createdAt: 0, trees: [] },
];

type Nodes = Record<string, ChatNodeState>;
/** What the mocked store holds; tests swap projects and nodes in and out. */
const store = {
  projects: projects as Project[],
  nodes: {} as Nodes,
  actions: {
    deleteProject: vi.fn(),
    restoreProject: vi.fn(),
    archiveProject: vi.fn(),
    unarchiveProject: vi.fn(),
    pinProject: vi.fn(),
    unpinProject: vi.fn(),
    renameProject: vi.fn(),
    setProjectCwd: vi.fn(),
  },
};

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({ projects: store.projects, activeProjectId: 'ws-a', ...store.actions }),
    useChatNodesSnapshot: () => store.nodes,
    useNodesSelector: (selector: (nodes: Nodes) => unknown) => selector(store.nodes),
    useStructuralSelector: (selector: (nodes: Nodes) => unknown) => selector(store.nodes),
    useChatNode: (nodeId: string) => store.nodes[nodeId],
  };
});

/** Workspace ids in the order the table renders them. */
function rowOrder(): string[] {
  return screen
    .getAllByTestId(/^workspace-table-row-/)
    .map((row) => row.getAttribute('data-testid')!.replace('workspace-table-row-', ''));
}

const cellsOf = (id: string) => within(screen.getByTestId(`workspace-table-row-${id}`)).getAllByRole('cell');

it('shows workspace machines, filters by host or remote, and updates renamed connection labels', () => {
  const connection = { id: 'remote-z', name: 'Build box', transport: 'ssh' as const, sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  setKnownBackendConnections([connection]);
  const view = render(<TerminalWorkspaces onNav={vi.fn()} />);
  try {
    expect(within(cellsOf('ws-z')[2]).getByText('Remote - Build box')).toBeTruthy();
    expect(within(cellsOf('ws-x')[2]).getByText('Local')).toBeTruthy();
    const filter = screen.getByRole('searchbox', { name: 'Filter workspaces' });
    for (const value of ['build+', 'Remote', 'Build box', 'Remote - Build box']) {
      fireEvent.change(filter, { target: { value } }); expect(rowOrder()).toEqual(['ws-z']);
    }
    act(() => setKnownBackendConnections([{ ...connection, name: 'Build machine' }]));
    expect(screen.getByText(/No workspaces match/)).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'Build machine' } });
    expect(within(cellsOf('ws-z')[2]).getByText('Remote - Build machine')).toBeTruthy();
    act(() => setKnownBackendConnections([]));
    fireEvent.change(filter, { target: { value: 'Remote' } });
    expect(within(cellsOf('ws-z')[2]).getByText('Remote - Unavailable connection')).toBeTruthy();
  } finally { view.unmount(); setKnownBackendConnections([]); }
});

describe('TerminalWorkspaces — header controls', () => {
  beforeEach(() => _resetForTest());

  it('clears the filter from the field\'s own clear button', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: 'Filter workspaces' }) as HTMLInputElement;
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    fireEvent.change(search, { target: { value: 'zeta' } });
    expect(rowOrder()).toEqual(['ws-z']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(search.value).toBe('');
    expect(rowOrder().length).toBeGreaterThan(1);
  });
});

describe('TerminalWorkspaces — row click', () => {
  beforeEach(() => _resetForTest());

  it('clicking a workspace row sets manageWorkspaceId and navigates to workspace-manage', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    // The row contains the workspace name; find any element with that text
    // and walk up to find the click handler element. Or simply click the
    // text container — the row's onClick handler bubbles correctly.
    fireEvent.click(screen.getByText('web-platform'));
    expect(getManageWorkspaceId()).toBe('ws-x');
    expect(onNav).toHaveBeenCalledWith('workspace-manage');
  });

  it('opens the row menu from the kebab without opening the workspace', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    const row = screen.getByTestId('workspace-table-row-ws-x');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
    expect(within(screen.getByRole('menu')).getByText('Manage workspace')).toBeTruthy();
    expect(onNav).not.toHaveBeenCalled();
    expect(getManageWorkspaceId()).toBeNull();
  });
});

describe('TerminalWorkspaces — table', () => {
  beforeEach(() => _resetForTest());

  it('sorts by a column on click and flips direction on a second click', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(rowOrder()).toEqual(['ws-a', 'ws-s', 'ws-x', 'ws-z']);
    expect(screen.getByRole('columnheader', { name: /name/i }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: /last/i }).getAttribute('aria-sort')).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(rowOrder()).toEqual(['ws-z', 'ws-x', 'ws-s', 'ws-a']);

    fireEvent.click(screen.getByRole('button', { name: /^last/i }));
    expect(rowOrder()).toEqual(['ws-x', 'ws-a', 'ws-z', 'ws-s']);
  });
});

describe('workspace list helpers', () => {
  it('shortens every home directory form to ~, but not /Users/Shared', () => {
    expect(displayPath('/Users/someone/code/web')).toBe('~/code/web');
    expect(displayPath('/home/someone')).toBe('~');
    expect(displayPath('/local/home/someone/MichiWorkspace')).toBe('~/MichiWorkspace');
    expect(displayPath('/Users/Shared/proj')).toBe('/Users/Shared/proj');
    expect(displayPath('/srv/zeta')).toBe('/srv/zeta');
  });

  it('reads an age as time ago, never as “just now ago”', () => {
    expect(formatAgo(Date.now())).toBe('just now');
    expect(formatAgo(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(formatAgo(0)).toBe('—');
  });
});

describe('TerminalWorkspaces — cards', () => {
  it('leave Meta agent maintenance runs and page helpers out of every count and preview', () => {
    const node = (nodeId: string, title: string, at: number, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
      nodeId, projectId: 'ws-m', kind: 'chat', chatId: null, title, status: 'idle', followUps: [],
      messages: [{ id: `${nodeId}-m`, role: 'user', text: title, toolCalls: [], createdAt: at }], ...extra,
    });
    const project: Project = {
      ...base, id: 'ws-m', name: 'maintained', createdAt: 0,
      chatIds: ['mine', 'mine-branch', 'run', 'helper'],
      edges: [{ source: 'mine', target: 'mine-branch', kind: 'branch' }],
      trees: [
        { id: 't-mine', rootNodeId: 'mine', createdAt: 0, lastActiveAt: 100 },
        { id: 't-run', rootNodeId: 'run', createdAt: 0, lastActiveAt: 900 },
        { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 800 },
      ],
    };
    const snapshot = {
      mine: node('mine', 'My thread', 100),
      'mine-branch': node('mine-branch', 'My branch', 120, { parentNodeId: 'mine' }),
      run: node('run', 'Space maintenance · Oct 23', 900, { maintenanceJobId: 'job-1' }),
      helper: node('helper', 'Page helper', 800, { pageId: 'pg-1' }),
    };
    const card = buildCard(project, snapshot, new Set(['run']), null);
    expect(card).toMatchObject({ liveCount: 2, threadCount: 1, branches: 1, streaming: 0, lastTs: 120 });
    expect(card.threads.map((t) => t.title)).toEqual(['My thread']);
    expect(card.nodes.map((n) => n.title)).toEqual(['My thread', 'My branch']);
  });
});

describe('TerminalWorkspaces — phone', () => {
  const desktopWidth = window.innerWidth;
  const now = Date.now();
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const node = (nodeId: string, projectId: string, title: string, when: number, extra: Partial<ChatNodeState> = {}): ChatNodeState => ({
    nodeId, projectId, kind: 'chat', chatId: null, title, status: 'idle', followUps: [],
    messages: [{ id: `${nodeId}-u`, role: 'user', text: title, toolCalls: [], createdAt: when }], ...extra,
  });
  const treeOf = (id: string, rootNodeId: string, lastActiveAt: number) => ({ id, rootNodeId, createdAt: 0, lastActiveAt });
  const phoneProjects: Project[] = [
    { ...base, id: 'ws-x', name: 'web-platform', cwd: '/local/home/someone/code/web', createdAt: 0, chatIds: ['x-run'], trees: [treeOf('x1', 'x-run', at(1))] },
    { ...base, id: 'ws-w', name: 'waiting-room', createdAt: 0, chatIds: ['w-ask'], trees: [treeOf('w1', 'w-ask', at(2))] },
    { ...base, id: 'ws-f', name: 'flaky', cwd: '/srv/flaky', createdAt: 0, chatIds: ['f-err'], trees: [treeOf('f1', 'f-err', at(3))] },
    { ...base, id: 'ws-p', name: 'pinned-one', createdAt: 0, pinnedAt: 5, chatIds: ['p-1'], trees: [treeOf('p1', 'p-1', at(600))] },
    { ...base, id: 'ws-old', name: 'old-archive', createdAt: 0, archivedAt: 10, chatIds: [], trees: [] },
  ];
  const phoneNodes: Nodes = {
    'x-run': node('x-run', 'ws-x', 'Ship the phone list', at(1), {
      status: 'streaming',
      messages: [
        { id: 'x-u', role: 'user', text: 'Ship the phone list', toolCalls: [], createdAt: at(1) },
        { id: 'x-a', role: 'assistant', text: '', toolCalls: [{ id: 't', title: 'Read src/a.ts', status: 'in_progress', kind: 'read' }], createdAt: at(1) },
      ],
    }),
    'w-ask': node('w-ask', 'ws-w', 'Tidy the logs', at(2), {
      status: 'streaming',
      pendingPermission: { requestId: 1, title: 'Run   npm test', options: [] },
    }),
    'f-err': node('f-err', 'ws-f', 'Flaky build', at(3), { status: 'error' }),
    'p-1': node('p-1', 'ws-p', 'Pinned thread', at(600)),
  };
  const rowOf = (id: string) => screen.getByTestId(`workspace-row-${id}`);
  const phoneRows = () => screen.getAllByTestId(/^workspace-row-/).map((row) => row.dataset.testid!.replace('workspace-row-', ''));
  const openSheetFor = (id: string) => fireEvent.click(within(rowOf(id)).getByRole('button', { name: 'More actions' }));

  // jsdom has no PointerEvent; without one, fired pointer events carry no
  // coordinates or pointer type. A MouseEvent with the two pointer fields will do.
  class TestPointerEvent extends MouseEvent {
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? '';
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  const hadPointerEvent = 'PointerEvent' in window;

  beforeEach(() => {
    _resetForTest();
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    if (!hadPointerEvent) Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: TestPointerEvent });
    store.projects = phoneProjects;
    store.nodes = phoneNodes;
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    if (!hadPointerEvent) delete (window as { PointerEvent?: unknown }).PointerEvent;
    store.projects = projects;
    store.nodes = {};
  });

  it('lists each workspace as a row that says what it is doing, pinned ones first', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Pinned' })).getByTestId('workspace-row-ws-p')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recent' })).getAllByTestId(/^workspace-row-/)).toHaveLength(3);

    expect(within(rowOf('ws-x')).getByText('Reading code…')).toBeTruthy();
    expect(within(rowOf('ws-x')).getByText('Ship the phone list')).toBeTruthy();
    // A dev desktop's /local/home/<user> reads as ~ too.
    expect(within(rowOf('ws-x')).getByText('~/code/web')).toBeTruthy();
    expect(within(rowOf('ws-w')).getByText('Needs approval')).toBeTruthy();
    expect(within(rowOf('ws-w')).getByText('Run npm test')).toBeTruthy();
    expect(within(rowOf('ws-f')).getByText('Last turn failed')).toBeTruthy();
    expect(within(rowOf('ws-f')).getByText('Flaky build')).toBeTruthy();
    expect(within(rowOf('ws-p')).getByText('Pinned thread')).toBeTruthy();

    // Archived workspaces wait behind their own disclosure.
    expect(screen.queryByTestId('workspace-row-ws-old')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Archived workspaces/ }));
    expect(rowOf('ws-old')).toBeTruthy();
  });

  it('opens an archived workspace to what can be done with it, not to the workspace', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    fireEvent.click(screen.getByRole('button', { name: /Archived workspaces/ }));
    fireEvent.click(within(rowOf('ws-old')).getByText('old-archive'));
    expect(onNav).not.toHaveBeenCalled();
    const sheet = screen.getByRole('dialog', { name: 'old-archive' });
    expect(within(sheet).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['Rename…', 'Unarchive', 'Delete workspace…', 'Cancel']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Unarchive' }));
    expect(store.actions.unarchiveProject).toHaveBeenCalledWith('ws-old');
  });

  it('filters to what needs you or is running from the counts at the top', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const needsYou = screen.getByRole('button', { name: /1 needs you/ });
    fireEvent.click(needsYou);
    expect(needsYou.getAttribute('aria-pressed')).toBe('true');
    expect(phoneRows()).toEqual(['ws-w']);
    fireEvent.click(screen.getByRole('button', { name: /1 running/ }));
    expect(phoneRows()).toEqual(['ws-x']);
    fireEvent.click(screen.getByRole('button', { name: /1 running/ }));
    expect(phoneRows()).toHaveLength(4);
  });

  it('searches names, paths and threads, and says why a workspace matched', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: 'Filter workspaces' });
    fireEvent.change(search, { target: { value: 'build' } });
    expect(phoneRows()).toEqual(['ws-f']);
    expect(screen.getByRole('status').textContent).toBe('1 workspace · 1 matching thread');
    expect(within(rowOf('ws-f')).getByText('build').tagName).toBe('MARK');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(phoneRows()).toHaveLength(4);
  });

  it('opens a workspace with a tap', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    fireEvent.click(within(rowOf('ws-x')).getByText('web-platform'));
    expect(getManageWorkspaceId()).toBe('ws-x');
    expect(onNav).toHaveBeenCalledWith('workspace-manage');
  });

  it('offers the row menu’s actions in a sheet, and archives from it', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    openSheetFor('ws-x');
    const sheet = screen.getByRole('dialog', { name: 'web-platform' });
    const actions = within(sheet).getAllByRole('button').map((button) => button.textContent);
    expect(actions).toEqual(['Manage workspace', 'Rename…', 'Pin', 'Archive', 'Delete workspace…', 'Cancel']);
    expect(onNav).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    expect(store.actions.archiveProject).toHaveBeenCalledWith('ws-x');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renames in the sheet, with the field ready to type into', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    openSheetFor('ws-x');
    fireEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const field = screen.getByRole('textbox', { name: 'Workspace name' }) as HTMLInputElement;
    expect(screen.getByRole('dialog', { name: 'Rename workspace' })).toBeTruthy();
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('web-platform');
    fireEvent.change(field, { target: { value: '  web-mobile  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(store.actions.renameProject).toHaveBeenCalledWith('ws-x', 'web-mobile');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before deleting, and says the files stay', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    openSheetFor('ws-x');
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace…' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete “web-platform”?' });
    expect(confirm.textContent).toContain('Its 1 thread moves to Trash with it. You can restore it from Trash. Files in its folder stay on disk.');
    // The safe choice holds focus.
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(store.actions.deleteProject).not.toHaveBeenCalled();

    openSheetFor('ws-x');
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
    expect(store.actions.deleteProject).toHaveBeenCalledWith('ws-x');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the sheet on a long press without also opening the workspace', () => {
    vi.useFakeTimers();
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    const open = within(rowOf('ws-f')).getByText('flaky').closest('button')!;
    fireEvent.pointerDown(open, { pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('dialog', { name: 'flaky' })).toBeTruthy();
    // The release's click neither opens the workspace nor lands as a scrim tap.
    fireEvent.click(open);
    fireEvent.click(document.querySelector('.ui-scrim')!);
    expect(onNav).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'flaky' })).toBeTruthy();
    // A tap that starts on the scrim closes the sheet.
    const scrim = document.querySelector('.ui-scrim')!;
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets a press that moves scroll instead, and closes the sheet on Escape', () => {
    vi.useFakeTimers();
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const open = within(rowOf('ws-f')).getByText('flaky').closest('button')!;
    fireEvent.pointerDown(open, { pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(open, { pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 60 });
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.queryByRole('dialog')).toBeNull();

    openSheetFor('ws-f');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
