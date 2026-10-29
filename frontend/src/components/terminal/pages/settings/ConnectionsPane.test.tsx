import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPane } from './ConnectionsPane';
import type { Project } from '../../../../state/chatTypes';
import { setKnownBackendConnections } from '../../../../config/backendConnections';
import { backendEntityId } from '../../../../config/backendIdentity';


const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  test: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  workspaces: vi.fn(),
}));

vi.mock('../../../../services/api', () => ({
  listBackendConnections: mocks.list,
  testBackendConnection: mocks.test,
  saveBackendConnection: mocks.save,
  deleteBackendConnection: mocks.remove,
}));

vi.mock('../../../../services/api/remoteWorkspaces', () => ({ fetchRemoteWorkspaces: mocks.workspaces }));

const desktop = { id: 'remote-1', name: 'Build box', transport: 'ssh' as const, sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
const other = { id: 'remote-2', name: 'Other machine', transport: 'direct' as const, apiUrl: 'https://example.com/api', hasToken: true, createdAt: 1, updatedAt: 1 };
const project = (id: string, backendConnectionId?: string, extra = {}): Project => ({
  id: backendConnectionId ? backendEntityId(backendConnectionId, id) : id,
  name: id, backendConnectionId, cwd: `/home/u/${id}`, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ConnectionsPane', () => {
  afterEach(() => { act(() => setKnownBackendConnections([])); vi.restoreAllMocks(); });
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.test.mockReset().mockResolvedValue({ ok: true, serverId: 'server-1' });
    mocks.save.mockReset().mockResolvedValue({
      id: 'remote-1', name: 'Build', transport: 'direct', apiUrl: 'https://build.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1,
    });
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.workspaces.mockReset().mockResolvedValue([]);
  });

  it('keeps Local visible and validates before saving a remote backend', async () => {
    render(<ConnectionsPane projects={[]} />);
    expect(await screen.findByText('Local')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/i }));
    fireEvent.change(screen.getByPlaceholderText('build-server'), { target: { value: 'Build' } });
    fireEvent.change(screen.getByLabelText('Connection transport'), { target: { value: 'direct' } });
    fireEvent.change(screen.getByPlaceholderText('https://michi.example.com:3000'), { target: { value: 'https://build.example.com' } });
    fireEvent.change(screen.getByPlaceholderText('MICHI_REMOTE_TOKEN'), { target: { value: 'secret-remote-token' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await vi.waitFor(() => expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ name: 'Build' })));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'direct',
      apiUrl: 'https://build.example.com',
    })));
    await vi.waitFor(() => expect(screen.queryByDisplayValue('secret-remote-token')).toBeNull());
  });

  it('lists current remote membership even when local projects disagree, and only opens workspaces loaded from that host', async () => {
    mocks.list.mockResolvedValue([desktop, other]);
    mocks.workspaces.mockImplementation(async id => id === desktop.id ? [
      { id: 'remote-project', name: 'Renamed on remote', cwd: '/srv/current' },
      { id: 'old-project', name: 'Archived project', archivedAt: 1 },
      { id: 'remote-only', name: 'Created on another device' },
      { id: 'collision', name: 'Remote ID collision' },
      { id: 'trashed-project', name: 'Deleted on remote', deletedAt: 1 },
    ] : [{ id: 'other-project', name: 'Other project' }]);
    const open = vi.fn();
    const projects = [project('Local project'), project('remote-project', desktop.id), project('stale-local', desktop.id),
      project('old-project', desktop.id, { archivedAt: 1 }), project('collision'), project('other-project', other.id)];
    render(<ConnectionsPane projects={projects} onOpenWorkspace={open} />);
    const list = await screen.findByRole('list', { name: 'Workspaces on Build box' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText('/srv/current')).toBeTruthy();
    expect(within(list).getByText('Archived')).toBeTruthy();
    for (const name of ['Local project', 'stale-local', 'Deleted on remote', 'Other project']) expect(within(list).queryByText(name)).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'Renamed on remote' }));
    expect(open).toHaveBeenCalledWith(backendEntityId(desktop.id, 'remote-project'));
    for (const name of ['Archived project', 'Created on another device', 'Remote ID collision']) {
      expect(within(list).getByText(name)).toBeTruthy();
      expect(within(list).queryByRole('button', { name })).toBeNull();
    }
    expect(within(screen.getByRole('list', { name: 'Workspaces on Other machine' })).getByRole('button', { name: 'Other project' })).toBeTruthy();
    expect(mocks.workspaces).toHaveBeenCalledWith(desktop.id, expect.any(AbortSignal));
    expect(mocks.workspaces).toHaveBeenCalledWith(other.id, expect.any(AbortSignal));
    expect(within(screen.getByRole('listitem', { name: desktop.name })).getByText('SSH connected')).toBeTruthy();
  });

  it('keeps matching raw IDs on Local and other hosts separate when enabling and opening a workspace', async () => {
    mocks.list.mockResolvedValue([desktop, other]);
    mocks.workspaces.mockImplementation(async id => [{
      id: 'same', name: id === desktop.id ? 'Build box shared workspace' : 'Other host shared workspace',
    }]);
    const open = vi.fn();
    const projects = [project('same'), project('same', other.id)];
    const { rerender } = render(<ConnectionsPane projects={projects} onOpenWorkspace={open} />);
    const desktopList = await screen.findByRole('list', { name: 'Workspaces on Build box' });
    const otherList = await screen.findByRole('list', { name: 'Workspaces on Other machine' });
    expect(within(desktopList).getByText('Build box shared workspace')).toBeTruthy();
    expect(within(desktopList).queryByRole('button', { name: 'Build box shared workspace' })).toBeNull();
    fireEvent.click(within(otherList).getByRole('button', { name: 'Other host shared workspace' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(backendEntityId(other.id, 'same'));

    rerender(<ConnectionsPane projects={[...projects, project('same', desktop.id)]} onOpenWorkspace={open} />);
    fireEvent.click(within(desktopList).getByRole('button', { name: 'Build box shared workspace' }));
    expect(open).toHaveBeenLastCalledWith(backendEntityId(desktop.id, 'same'));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('clears old inventory while refreshing and after failure, and reflects remote rename and deletion', async () => {
    mocks.list.mockResolvedValue([desktop]);
    mocks.workspaces.mockResolvedValueOnce([{ id: 'one', name: 'Old name' }, { id: 'two', name: 'Removed remotely' }]);
    render(<ConnectionsPane projects={[project('stale-local', desktop.id)]} />);
    await screen.findByText('Old name');
    const pending = deferred<Array<{ id: string; name: string }>>();
    mocks.workspaces.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
    expect(screen.queryByText('Old name')).toBeNull();
    expect(screen.queryByText('2 workspaces')).toBeNull();
    await act(async () => pending.resolve([{ id: 'one', name: 'New name' }]));
    expect(await screen.findByText('New name')).toBeTruthy();
    expect(screen.getByText('1 workspace')).toBeTruthy();
    expect(screen.queryByText('Removed remotely')).toBeNull();
    mocks.workspaces.mockRejectedValueOnce(new Error('Remote backend unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh workspaces' }));
    expect(await screen.findByText('Workspaces unavailable')).toBeTruthy();
    expect(screen.queryByText('New name')).toBeNull();
    expect(screen.queryByText('1 workspace')).toBeNull();
    expect(screen.queryByText('0 workspaces')).toBeNull();
  });

  it('cancels the old target inventory when a saved connection is edited', async () => {
    mocks.list.mockResolvedValueOnce([desktop]).mockResolvedValue([{ ...desktop, sshHost: 'replacement', updatedAt: 2 }]);
    const pending = deferred<Array<{ id: string; name: string }>>();
    mocks.workspaces.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([{ id: 'new', name: 'New host workspace' }]);
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('Reading remote workspaces…');
    const signal = mocks.workspaces.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'replacement' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('New host workspace');
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve([{ id: 'old', name: 'Old host workspace' }]));
    expect(screen.queryByText('Old host workspace')).toBeNull();
  });

  it('rechecks removal against remote membership including Trash, rather than local projects', async () => {
    mocks.list.mockResolvedValue([desktop]);
    mocks.workspaces.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'active', name: 'Created remotely' }, { id: 'trashed', name: 'Remote Trash', deletedAt: 1 },
    ]);
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('0 workspaces');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('2 workspaces still use this connection.')).toBeTruthy();
    expect(screen.queryByText('Remote Trash')).toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.workspaces).toHaveBeenCalledTimes(2);
  });

  it('does not block removal using stale local membership once the remote confirms it is empty', async () => {
    mocks.list.mockResolvedValueOnce([desktop]).mockResolvedValue([]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectionsPane projects={[project('stale-local', desktop.id)]} />);
    await screen.findByText('0 workspaces');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(desktop.id));
    expect(mocks.workspaces).toHaveBeenCalledTimes(2);
  });

  it('creates an SSH tunnel connection with numeric ports', async () => {
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('Local');
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/i }));
    expect((screen.getByLabelText('Connection transport') as HTMLSelectElement).value).toBe('ssh');
    fireEvent.change(screen.getByPlaceholderText('build-server'), { target: { value: 'SSH Build' } });
    fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'build-server-box' } });
    fireEvent.change(screen.getByLabelText('SSH user'), { target: { value: 'builder' } });
    fireEvent.change(screen.getByLabelText('SSH port'), { target: { value: '2222' } });
    fireEvent.change(screen.getByLabelText('Remote Michi port'), { target: { value: '4649' } });
    fireEvent.change(screen.getByPlaceholderText('MICHI_REMOTE_TOKEN'), { target: { value: 'secret-remote-token' } });
    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await vi.waitFor(() => expect(mocks.test).toHaveBeenCalledWith({
      id: undefined,
      name: 'SSH Build',
      transport: 'ssh',
      sshHost: 'build-server-box',
      sshUser: 'builder',
      sshPort: 2222,
      remotePort: 4649,
      token: 'secret-remote-token',
    }));
    expect(await screen.findByText(/Connected to Michi backend/)).toBeTruthy();
  });
  it('keeps quick connect and manual editing mutually exclusive', async () => {
    mocks.list.mockResolvedValue([{
      id: 'ssh-1', name: 'Remote Linux', transport: 'ssh', sshHost: 'build+',
      hasToken: true, createdAt: 1, updatedAt: 1,
    }]);
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('Remote Linux');
    fireEvent.click(screen.getByRole('button', { name: 'Connect remote' }));
    expect(screen.getByLabelText(/\S+ SSH host$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText(/\S+ SSH host$/)).toBeNull();
    expect((screen.getByLabelText('SSH host') as HTMLInputElement).value).toBe('build+');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Connect remote' })).toBeTruthy();
  });

});
