import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageDatabase } from 'michi-shared';
import { fetchTaskDatabaseId, openTaskDatabase } from '../../../services/api/taskDatabase';
import { PageApiError } from '../../../services/api/pages';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { NativeTaskView } from './NativeTaskView';

vi.mock('../../../services/api/taskDatabase', () => ({ fetchTaskDatabaseId: vi.fn(), openTaskDatabase: vi.fn() }));
vi.mock('./NativeDatabase', () => ({
  default: (props: { databaseId: string; viewId?: string; heading?: string; presentation?: string; readOnly?: boolean }) => (
    <div data-testid="task-db" data-database={props.databaseId} data-view={props.viewId} data-heading={props.heading}
      data-presentation={props.presentation} data-read-only={props.readOnly ? 'true' : undefined} />
  ),
}));

beforeEach(() => {
  vi.mocked(fetchTaskDatabaseId).mockReset();
  vi.mocked(openTaskDatabase).mockReset();
});

describe('NativeTaskView', () => {
  it('shows the workspace’s task database in its Board view, as a page block titled Tasks', async () => {
    vi.mocked(fetchTaskDatabaseId).mockResolvedValue('db-tasks');
    render(<NativeTaskView workspaceId="ws-1" connectionId="local" />);
    expect(screen.getByRole('status').textContent).toBe('Reading the task board…');
    const board = await screen.findByTestId('task-db');
    expect({ ...board.dataset }).toMatchObject({ database: 'db-tasks', view: 'tasks-board', heading: 'Tasks', presentation: 'page' });
    expect(fetchTaskDatabaseId).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-1', signal: expect.any(AbortSignal) });
  });

  it('opens the view the block names, under the block’s title', async () => {
    vi.mocked(fetchTaskDatabaseId).mockResolvedValue('db-tasks');
    render(<NativeTaskView workspaceId="ws-1" connectionId="local" viewId="tasks-needs-you" title="Needs you" />);
    expect({ ...(await screen.findByTestId('task-db')).dataset }).toMatchObject({ view: 'tasks-needs-you', heading: 'Needs you' });
  });

  it('offers to make the task database when the workspace has none, then shows it', async () => {
    vi.mocked(fetchTaskDatabaseId).mockResolvedValue(null);
    vi.mocked(openTaskDatabase).mockResolvedValue({ database: { id: 'db-tasks' } as PageDatabase, created: true });
    render(<NativeTaskView workspaceId="ws-1" connectionId="local" />);
    expect(await screen.findByText('This workspace has no task database yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    expect((await screen.findByTestId('task-db')).dataset.database).toBe('db-tasks');
    expect(openTaskDatabase).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-1' });
  });

  it('shows the server’s reason and stops offering Create one when the workspace cannot have a task database', async () => {
    vi.mocked(fetchTaskDatabaseId).mockResolvedValue(null);
    vi.mocked(openTaskDatabase).mockRejectedValue(new PageApiError(400, 'tasks_need_workspace', 'Task boards belong to a workspace; the Pages Home has no task database.'));
    render(<NativeTaskView workspaceId="home-ws" connectionId="local" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create one' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Task boards belong to a workspace; the Pages Home has no task database.');
    expect(screen.queryByRole('button', { name: 'Create one' })).toBeNull();
    expect(screen.queryByText('This workspace has no task database yet.')).toBeNull();
    // A page edit afterwards reads again; the refusal stays.
    act(() => { notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'home-ws' }); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toBe('Task boards belong to a workspace; the Pages Home has no task database.');
    expect(screen.queryByRole('button', { name: 'Create one' })).toBeNull();
  });

  it('reads again when the workspace’s pages change while it has none, and offers nothing to make when read only', async () => {
    vi.mocked(fetchTaskDatabaseId).mockResolvedValueOnce(null).mockResolvedValueOnce('db-tasks');
    render(<NativeTaskView workspaceId="ws-1" connectionId="local" readOnly />);
    expect(await screen.findByText('This workspace has no task database yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create one' })).toBeNull();
    act(() => { notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'ws-1' }); });
    expect((await screen.findByTestId('task-db')).dataset.readOnly).toBe('true');
  });

  it('offers Retry after a failed read instead of offering to make a database', async () => {
    vi.mocked(fetchTaskDatabaseId).mockRejectedValueOnce(new Error('Backend unavailable')).mockResolvedValueOnce('db-tasks');
    render(<NativeTaskView workspaceId="ws-1" connectionId="local" />);
    expect((await screen.findByRole('alert')).textContent).toBe('Backend unavailable');
    expect(screen.queryByRole('button', { name: 'Create one' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByTestId('task-db')).dataset.database).toBe('db-tasks');
  });

  it('never shows one workspace’s database under another, and drops a late answer for the old one', async () => {
    let finishCreate: (value: { database: PageDatabase; created: boolean }) => void = () => {};
    vi.mocked(fetchTaskDatabaseId).mockResolvedValueOnce('db-one').mockResolvedValueOnce(null);
    const { rerender } = render(<NativeTaskView workspaceId="ws-1" connectionId="local" />);
    expect((await screen.findByTestId('task-db')).dataset.database).toBe('db-one');
    rerender(<NativeTaskView workspaceId="ws-2" connectionId="local" />);
    expect(screen.queryByTestId('task-db')).toBeNull();
    expect(await screen.findByText('This workspace has no task database yet.')).toBeTruthy();
    vi.mocked(openTaskDatabase).mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    vi.mocked(fetchTaskDatabaseId).mockResolvedValue(null);
    rerender(<NativeTaskView workspaceId="ws-3" connectionId="local" />);
    await act(async () => { finishCreate({ database: { id: 'db-two' } as PageDatabase, created: true }); });
    expect(screen.queryByTestId('task-db')).toBeNull();
    expect(await screen.findByText('This workspace has no task database yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create one' })).toBeTruthy();
  });
});
