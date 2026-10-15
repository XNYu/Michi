import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TerminalWorkspaces from './Workspaces';
import { _resetForTest, getManageWorkspaceId } from '../../../state/manageRoute';

const base = { chatIds: [], edges: [], activeTreeId: null, artifacts: [] };
const tree = (id: string, lastActiveAt: number) => ({ id, rootNodeId: `${id}-root`, createdAt: 0, lastActiveAt });

// Newest activity: web-platform (300) › atlas (200) › zeta (100) › shared (0).
// Thread count:    atlas (3) › zeta (2) › web-platform (1) › shared (0).
const projects = [
  { ...base, id: 'ws-x', name: 'web-platform', cwd: '/Users/someone/code/web', createdAt: 0, trees: [tree('x1', 300)] },
  { ...base, id: 'ws-a', name: 'atlas', createdAt: 0, trees: [tree('a1', 200), tree('a2', 50), tree('a3', 40)] },
  { ...base, id: 'ws-z', name: 'zeta', cwd: '/srv/zeta', createdAt: 0, trees: [tree('z1', 100), tree('z2', 10)] },
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

describe('TerminalWorkspaces — header controls', () => {
  beforeEach(() => _resetForTest());

  it('uses the shared primary Button and page search field', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const create = screen.getByRole('button', { name: '+ new workspace' });
    expect(create.className).toContain('ui-btn--primary');
    // No fill of its own: the colour is the shared recipe's (Send's accent).
    expect(create.style.background).toBe('');

    const search = screen.getByRole('searchbox', { name: 'Filter workspaces' });
    expect(search.closest('label')!.className).toBe('ui-search');
  });

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

  it('exposes the name as a button so the row can be opened from the keyboard', () => {
    const onNav = vi.fn();
    render(<TerminalWorkspaces onNav={onNav} />);
    const row = screen.getByTestId('workspace-table-row-ws-z');
    fireEvent.click(within(row).getByRole('button', { name: 'zeta' }));
    expect(getManageWorkspaceId()).toBe('ws-z');
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

  it('renders one table row per live workspace, newest activity first', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(rowOrder()).toEqual(['ws-x', 'ws-a', 'ws-z', 'ws-s']);
    expect(screen.getByRole('columnheader', { name: /last/i }).getAttribute('aria-sort')).toBe('descending');
  });

  it('puts thread and node counts in their own columns', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const cells = cellsOf('ws-a');
    // name · path · threads · nodes · latest thread · 14 days · last · actions
    expect(cells).toHaveLength(8);
    expect(cells[2].textContent).toBe('3');
    expect(cells[3].textContent).toBe('0');
  });

  it('shortens the home prefix of a path and keeps the full path as a tooltip', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    expect(cellsOf('ws-x')[1].textContent).toBe('~/code/web');
    expect(cellsOf('ws-x')[1].getAttribute('title')).toBe('/Users/someone/code/web');
    // Paths outside a home directory are shown as they are — including
    // /Users/Shared, which is nobody's home.
    expect(cellsOf('ws-z')[1].textContent).toBe('/srv/zeta');
    expect(cellsOf('ws-s')[1].textContent).toBe('/Users/Shared/proj');
    // No folder at all.
    expect(cellsOf('ws-a')[1].textContent).toBe('quick chat · no folder');
  });

  it('sorts by a column on click and flips direction on a second click', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(rowOrder()).toEqual(['ws-a', 'ws-s', 'ws-x', 'ws-z']);
    expect(screen.getByRole('columnheader', { name: /name/i }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: /last/i }).getAttribute('aria-sort')).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(rowOrder()).toEqual(['ws-z', 'ws-x', 'ws-s', 'ws-a']);

    // Counts start largest-first.
    fireEvent.click(screen.getByRole('button', { name: /^threads/i }));
    expect(rowOrder()).toEqual(['ws-a', 'ws-z', 'ws-x', 'ws-s']);
  });

  it('marks the active workspace row', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    expect(cellsOf('ws-a')[0].style.boxShadow).toContain('var(--term-accent)');
    expect(cellsOf('ws-x')[0].style.boxShadow).toBe('');
  });

  it('filters rows by name', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/filter workspaces/i), { target: { value: 'zet' } });
    expect(rowOrder()).toEqual(['ws-z']);
  });

  it('filters by the path as displayed, and by the part of the path the display hides', () => {
    render(<TerminalWorkspaces onNav={vi.fn()} />);
    const filter = screen.getByPlaceholderText(/filter workspaces/i);

    // What the row shows is what the user will type.
    fireEvent.change(filter, { target: { value: '~/code' } });
    expect(rowOrder()).toEqual(['ws-x']);
    expect(cellsOf('ws-x')[1].textContent).toBe('~/code/web');

    // A hit inside the collapsed prefix shows the full path, so the match is visible.
    fireEvent.change(filter, { target: { value: 'someone' } });
    expect(rowOrder()).toEqual(['ws-x']);
    expect(cellsOf('ws-x')[1].textContent).toBe('/Users/someone/code/web');
    expect(within(cellsOf('ws-x')[1]).getByText('someone').tagName).toBe('MARK');
  });
});
