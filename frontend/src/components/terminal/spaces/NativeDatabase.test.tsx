import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { PageDatabase, ThreadCardItem } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { fetchThreadStates } from '../../../services/api/spacesHome';
import { usePageDatabase } from '../../../state/pages/usePageDatabase';
import { NativeDatabase } from './NativeDatabase';

vi.mock('../../../state/pages/usePageDatabase', () => ({ usePageDatabase: vi.fn() }));
vi.mock('./components/CustomDatabaseView', () => ({
  CustomDatabaseView: ({ view, readOnly, onNavigatePage, onAskDraft }: { view: { id: string }; readOnly?: boolean; onNavigatePage?: (pageId: string) => void; onAskDraft?: (draft: string) => void }) => (
    <div data-custom-view={view.id} data-read-only={readOnly || undefined}>
      Custom view
      <button type="button" onClick={() => onNavigatePage?.('target-page')}>Navigate</button>
      <button type="button" onClick={() => onAskDraft?.('draft text')}>Ask</button>
    </div>
  ),
}));

vi.mock('../../../services/api/spacesHome', () => ({ fetchThreadStates: vi.fn(), fetchHomeConversations: vi.fn() }));
vi.mock('../../../services/api/taskDatabase', () => ({ fetchTaskActivity: vi.fn(() => new Promise(() => {})), fetchTaskOrigin: vi.fn(() => new Promise(() => {})) }));

const database: PageDatabase = {
  id: 'db-native', workspaceId: 'ws-1', title: 'Plan', revision: 4, updatedAt: 10,
  columns: [{ id: 'title', name: 'Title', type: 'text' }],
  views: [{ id: 'table', name: 'Table', type: 'table', position: 0, config: { filters: [], match: 'all', sorts: [] } }],
  rows: [{ id: 'row-1', values: { title: 'Task' }, body: 'Notes', position: 0, updatedAt: 9, rev: 3, edited: {}, bodyEditedAt: null }],
};

const hook = vi.mocked(usePageDatabase);

beforeEach(() => {
  hook.mockReset();
  vi.mocked(fetchThreadStates).mockReset().mockResolvedValue([]);
  hook.mockReturnValue({
    database, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn(),
  });
});

describe('NativeDatabase', () => {
  it('uses the shared row editor while withholding Michi assistant actions', () => {
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    expect(document.querySelector('[data-native-database][data-database-id="db-native"] [data-row-id="row-1"]')).toBeTruthy();
    fireEvent.click(screen.getByText('Task'));
    expect(within(screen.getByRole('dialog', { name: /Row/ })).queryByRole('button', { name: 'Hand to agent…' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Task' }));
    expect(within(screen.getByRole('toolbar', { name: '1 row selected' })).queryByRole('button', { name: 'Hand to agent…' })).toBeNull();
  });

  it('shows a stale snapshot read-only and offers an explicit refresh', () => {
    const refresh = vi.fn();
    hook.mockReturnValue({ database, status: 'ready', error: 'Connection unavailable', stale: true, refresh, edit: vi.fn() });
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    expect(screen.getByRole('region', { name: 'Plan read-only rows' })).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  });

  it('forces an owning-surface read-only state and dispatches custom views to the native component host', () => {
    const custom: PageDatabase = {
      ...database,
      views: [{
        id: 'custom-1', name: 'Custom', type: 'custom', position: 0,
        config: { componentId: 'component-1', props: {}, filters: [], match: 'all', sorts: [] },
      }],
    };
    hook.mockReturnValue({ database: custom, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const { rerender } = render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="custom-1" readOnly />);
    expect(document.querySelector('[data-native-database][data-read-only]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();

    rerender(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="custom-1" />);
    expect(document.querySelector('[data-custom-view="custom-1"]')).toBeTruthy();
  });

  it('forwards custom database view navigation and draft actions to its owning surface', () => {
    const custom: PageDatabase = {
      ...database,
      views: [{ id: 'custom-1', name: 'Custom', type: 'custom', position: 0, config: { componentId: 'component-1', props: {}, filters: [], match: 'all', sorts: [] } }],
    };
    hook.mockReturnValue({ database: custom, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const onNavigatePage = vi.fn();
    const onAskDraft = vi.fn();
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="custom-1" onNavigatePage={onNavigatePage} onAskDraft={onAskDraft} />);
    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onNavigatePage).toHaveBeenCalledWith('target-page');
    expect(onAskDraft).toHaveBeenCalledWith('draft text');
  });

  it('heads a Space page block with the database title and the view kind, and keeps the editing bar in the view', () => {
    const boards: PageDatabase = {
      ...database,
      views: [...database.views, { id: 'board', name: 'Board', type: 'board', position: 1, config: { filters: [], match: 'all', sorts: [] } }],
    };
    hook.mockReturnValue({ database: boards, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const { rerender } = render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="board" presentation="page" />);
    const root = document.querySelector<HTMLElement>('[data-native-database][data-presentation="page"]')!;
    expect(within(root).getByRole('heading', { level: 2, name: 'Plan' })).toBeTruthy();
    expect(root.querySelector('.native-db-head__tag')?.textContent).toBe('Database · Board view');
    // Editing stays where it was: the view's tabs, toolbar and New are all still there.
    fireEvent.click(within(root).getByRole('tab', { name: 'Table' }));
    expect(root.querySelector('.native-db-head__tag')?.textContent).toBe('Database · Table view');
    expect(within(root).getByRole('button', { name: 'New' })).toBeTruthy();
    expect(within(root).getByRole('checkbox', { name: 'Select Task' })).toBeTruthy();
    // Narrow (docked) shows a board as a table and says so.
    rerender(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="board" presentation="page" compact />);
    expect(document.querySelector('.native-db-head__tag')?.textContent).toBe('Database · Table view');
  });

  it('offers every Michi view, and Custom… asks the page assistant to build one', () => {
    const onAskDraft = vi.fn();
    const { unmount } = render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" onAskDraft={onAskDraft} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    const menu = screen.getByRole('menu', { name: 'Add view' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Table', 'Board', 'List', 'Timeline', 'Calendar', 'Gallery', 'Custom…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Custom…' }));
    expect(onAskDraft).toHaveBeenCalledWith('Make a custom view of the “Plan” database that shows ');
    expect(screen.queryByRole('menu', { name: 'Add view' })).toBeNull();
    unmount();
    // Where no assistant can build one, there is no Custom….
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    expect(within(screen.getByRole('menu', { name: 'Add view' })).queryByRole('menuitem', { name: 'Custom…' })).toBeNull();
  });

  it('saves a new calendar view through the Pages API', () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    hook.mockReturnValue({ database, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit });
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Add view' })).getByRole('menuitem', { name: 'Calendar' }));
    expect(edit).toHaveBeenCalledWith([{ op: 'view.save', view: { id: expect.any(String), name: 'Calendar', type: 'calendar', config: { filters: [], match: 'all', sorts: [] } } }]);
  });

  it('draws a list, calendar, gallery and timeline, beside the chat too', () => {
    const types = ['list', 'calendar', 'gallery', 'timeline'] as const;
    const dated: PageDatabase = {
      ...database,
      columns: [...database.columns, { id: 'due', name: 'Due', type: 'date' }],
      views: types.map((type, position) => ({ id: type, name: type, type, position, config: { filters: [], match: 'all', sorts: [] } })),
      rows: [{ ...database.rows[0]!, values: { title: 'Task', due: '2026-10-21' } }],
    };
    hook.mockReturnValue({ database: dated, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const drawn = { list: '.michi-db-list', calendar: '.michi-cal', gallery: '.michi-db-gallery', timeline: '.michi-db-timeline' };
    const label = { list: 'List', calendar: 'Calendar', gallery: 'Gallery', timeline: 'Timeline' };
    for (const type of types) {
      const { rerender, unmount } = render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId={type} presentation="page" />);
      expect(document.querySelector(drawn[type]), type).toBeTruthy();
      expect(document.querySelector('.native-db-head__tag')?.textContent).toBe(`Database · ${label[type]} view`);
      rerender(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId={type} presentation="page" compact />);
      expect(document.querySelector(drawn[type]), type).toBeTruthy();
      expect(document.querySelector('.native-db-head__tag')?.textContent).toBe(`Database · ${label[type]} view`);
      unmount();
    }
  });

  it('keeps a board a board when it is saved while drawn as a table beside the chat', () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const config = { filters: [], match: 'all' as const, sorts: [] };
    const board: PageDatabase = { ...database, views: [{ id: 'board', name: 'Board', type: 'board', position: 0, config }] };
    hook.mockReturnValue({ database: board, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit });
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" viewId="board" compact />);
    expect(document.querySelector('.michi-db-table')).toBeTruthy();
    expect(document.querySelector('.michi-db-board')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More for Board' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(edit).toHaveBeenCalledWith([{ op: 'view.save', view: { id: expect.any(String), name: 'Board copy', type: 'board', config } }]);
  });

  it('adds no heading outside a Space page', () => {
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    expect(document.querySelector('[data-native-database]')?.getAttribute('data-presentation')).toBeNull();
    expect(document.querySelector('.native-db-head')).toBeNull();
  });
});

const taskDb: PageDatabase = {
  id: 'db-tasks', workspaceId: 'ws-1', title: 'Tasks', role: 'tasks', revision: 2, updatedAt: 10,
  columns: taskDatabaseColumns(), views: taskDatabaseViews(),
  rows: [{ id: 't1', values: { task: 'Pick a schema naming rule', status: 'doing', threads: ['n1'] }, position: 0, updatedAt: 9, rev: 1, edited: {}, bodyEditedAt: null }],
};
const waitingCard: ThreadCardItem = { nodeId: 'n1', workspaceId: 'ws-1', title: 'Schema naming', state: 'waiting', summary: 'Which one?', at: 5, messageId: null };

describe('NativeDatabase as a task board', () => {
  it('heads the board with its own title, count and view, and opens a linked conversation from its card', async () => {
    vi.mocked(fetchThreadStates).mockResolvedValue([waitingCard]);
    hook.mockReturnValue({ database: taskDb, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const onOpenThread = vi.fn();
    render(<NativeDatabase databaseId="db-tasks" workspaceId="ws-1" connectionId="local" viewId="tasks-board" presentation="page" heading="Release tasks" onOpenThread={onOpenThread} />);
    const root = document.querySelector<HTMLElement>('[data-native-database][data-tasks]')!;
    expect(within(root).getByRole('heading', { level: 2, name: 'Release tasks' })).toBeTruthy();
    expect(root.querySelector('.native-db-head__count')?.textContent).toBe('1');
    expect(root.querySelector('.native-db-head__tag')?.textContent).toBe('Tasks · Board view');
    fireEvent.click(await within(root).findByTitle('Schema naming'));
    expect(onOpenThread).toHaveBeenCalledWith(waitingCard);
    expect(fetchThreadStates).toHaveBeenCalledWith('local', { nodeIds: ['n1'], signal: expect.any(AbortSignal) });
    expect(root.querySelector('.michi-card')?.getAttribute('data-attention')).toBe('true');
  });

  it('says how to start on an empty board, and when the conversations could not be read', async () => {
    hook.mockReturnValue({ database: { ...taskDb, rows: [] }, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    const { unmount } = render(<NativeDatabase databaseId="db-tasks" workspaceId="ws-1" connectionId="local" presentation="page" />);
    expect(screen.getByText(/No tasks yet\. Ask the assistant/)).toBeTruthy();
    unmount();
    vi.mocked(fetchThreadStates).mockRejectedValue(new Error('offline'));
    hook.mockReturnValue({ database: taskDb, status: 'ready', error: null, stale: false, refresh: vi.fn(), edit: vi.fn() });
    render(<NativeDatabase databaseId="db-tasks" workspaceId="ws-1" connectionId="local" presentation="page" />);
    expect(await screen.findByText("Couldn't read where the linked conversations stand just now.")).toBeTruthy();
  });

  it('reads no conversation states for a database that is not a task database', () => {
    render(<NativeDatabase databaseId="db-native" workspaceId="ws-1" connectionId="local" />);
    expect(fetchThreadStates).not.toHaveBeenCalled();
  });
});
