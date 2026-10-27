import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import TerminalWorkspaces, { buildCard } from './Workspaces';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
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

vi.mock('../../../state/chatStore', async () => {
  const actual: any = await vi.importActual('../../../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({
      projects,
      activeProjectId: 'ws-a',
      deleteProject: vi.fn(),
      archiveProject: vi.fn(),
      unarchiveProject: vi.fn(),
      pinProject: vi.fn(),
      unpinProject: vi.fn(),
      renameProject: vi.fn(),
      setProjectCwd: vi.fn(),
    }),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => new Set<string>(),
    useStructuralSelector: () => new Set<string>(),
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
