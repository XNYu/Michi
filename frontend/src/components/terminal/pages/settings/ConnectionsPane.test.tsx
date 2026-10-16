import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPane } from './ConnectionsPane';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  test: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../../services/api', () => ({
  listBackendConnections: mocks.list,
  testBackendConnection: mocks.test,
  saveBackendConnection: mocks.save,
  deleteBackendConnection: mocks.remove,
}));

describe('ConnectionsPane', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue([]);
    mocks.test.mockReset().mockResolvedValue({ ok: true, serverId: 'server-1' });
    mocks.save.mockReset().mockResolvedValue({
      id: 'remote-1', name: 'Build', transport: 'direct', apiUrl: 'https://build.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1,
    });
    mocks.remove.mockReset().mockResolvedValue(undefined);
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

  it('restores saved SSH fields and shows tunnel errors while editing', async () => {
    mocks.list.mockResolvedValue([{
      id: 'ssh-1',
      name: 'Build tunnel',
      transport: 'ssh',
      sshHost: 'build-server-box',
      sshUser: 'builder',
      remotePort: 3000,
      tunnelStatus: 'error',
      tunnelError: 'Permission denied',
      hasToken: true,
      createdAt: 1,
      updatedAt: 1,
    }]);
    render(<ConnectionsPane projects={[]} />);
    expect(await screen.findByText('Build tunnel')).toBeTruthy();
    expect(screen.getByText(/Permission denied/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect((screen.getByLabelText('Connection transport') as HTMLSelectElement).value).toBe('ssh');
    expect((screen.getByLabelText('SSH host') as HTMLInputElement).value).toBe('build-server-box');
    expect((screen.getByLabelText('SSH user') as HTMLInputElement).value).toBe('builder');
    expect((screen.getByLabelText('Remote Michi port') as HTMLInputElement).value).toBe('3000');
  });
  it('keeps quick connect and manual editing mutually exclusive', async () => {
    mocks.list.mockResolvedValue([{
      id: 'ssh-1', name: 'Remote Linux', transport: 'ssh', sshHost: 'build+',
      hasToken: true, createdAt: 1, updatedAt: 1,
    }]);
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('Remote Linux');
    fireEvent.click(screen.getByRole('button', { name: 'Connect remote' }));
    expect(screen.getByLabelText('Remote SSH host')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Remote SSH host')).toBeNull();
    expect((screen.getByLabelText('SSH host') as HTMLInputElement).value).toBe('build+');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Connect remote' })).toBeTruthy();
  });

  it('shows a failed manual connection test and allows retry', async () => {
    mocks.test.mockRejectedValueOnce(new Error('SSH authentication expired'));
    render(<ConnectionsPane projects={[]} />);
    await screen.findByText('Local');
    fireEvent.click(screen.getByRole('button', { name: /Manual setup/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('SSH authentication expired');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connected to Michi backend/)).toBeTruthy();
    expect(mocks.test).toHaveBeenCalledTimes(2);
    expect(mocks.save).not.toHaveBeenCalled();
  });

});
