import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopConnect } from './RemoteDesktopConnect';
import { RemoteFolderPicker } from './RemoteFolderPicker';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), browse: vi.fn() }));
vi.mock('../services/api/backendConnections', () => ({
  connectRemoteDesktop: mocks.connect, browseRemoteDirectory: mocks.browse,
}));
beforeEach(() => { mocks.connect.mockReset(); mocks.browse.mockReset(); });

it('connects with only a host and requests installation explicitly', async () => {
  mocks.connect.mockResolvedValueOnce({ kind: 'install_required', host: 'build+' }).mockResolvedValueOnce({
    kind: 'connected', connection: { id: 'remote-c', name: 'build+' }, home: '/home/u', runtimes: ['kiro'],
  });
  const connected = vi.fn();
  render(<RemoteDesktopConnect onConnected={connected} />);
  fireEvent.change(screen.getByLabelText('Remote SSH host'), { target: { value: 'build+' } });
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  const install = await screen.findByRole('button', { name: 'Install and connect' });
  expect(connected).not.toHaveBeenCalled();
  expect(mocks.connect.mock.calls[0].slice(0, 2)).toEqual(['build+', false]);
  fireEvent.click(install);
  await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ id: 'remote-c', name: 'build+' }, '/home/u', []));
  expect(mocks.connect.mock.calls[1].slice(0, 2)).toEqual(['build+', true]);
  expect(screen.queryByPlaceholderText('MICHI_REMOTE_TOKEN')).toBeNull();
});

it('clears installation authorization when the host changes and shows actionable errors', async () => {
  mocks.connect.mockResolvedValueOnce({ kind: 'install_required', host: 'build+' }).mockRejectedValueOnce(new Error('Sign in with ssh other, then reconnect.'));
  render(<RemoteDesktopConnect onConnected={vi.fn()} />);
  const input = screen.getByLabelText('Remote SSH host');
  fireEvent.change(input, { target: { value: 'build+' } });
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  await screen.findByRole('button', { name: 'Install and connect' });
  fireEvent.change(input, { target: { value: 'other' } });
  expect(screen.queryByRole('button', { name: 'Install and connect' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  expect((await screen.findByRole('alert')).textContent).toContain('Sign in with ssh other');
});

it('aborts its setup request on dismissal', async () => {
  mocks.connect.mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<RemoteDesktopConnect onConnected={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Remote SSH host'), { target: { value: 'build+' } });
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  const signal = mocks.connect.mock.calls[0][3] as AbortSignal;
  unmount(); expect(signal.aborted).toBe(true);
});

it('reports runtime authentication separately from a successful machine connection', async () => {
  const warning = 'Kiro is installed but not signed in. Run kiro-cli login on the remote machine before starting a chat.';
  mocks.connect.mockResolvedValue({ kind: 'connected', connection: { id: 'remote-c', name: 'build+' }, home: '/home/u', runtimes: ['kiro'], runtimeWarnings: [warning] });
  const connected = vi.fn(); render(<RemoteDesktopConnect onConnected={connected} />);
  fireEvent.change(screen.getByLabelText('Remote SSH host'), { target: { value: 'build+' } });
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  expect(await screen.findByText(warning)).toBeTruthy();
  expect(connected).toHaveBeenCalledWith({ id: 'remote-c', name: 'build+' }, '/home/u', [warning]);
});

it('browses directories then selects the canonical remote path', async () => {
  mocks.browse.mockResolvedValueOnce({ path: '/home/u', parent: '/home', entries: [{ name: 'project', path: '/home/u/project' }] })
    .mockResolvedValueOnce({ path: '/home/u/project', parent: '/home/u', entries: [] });
  const select = vi.fn(); render(<RemoteFolderPicker connectionId="remote-c" onSelect={select} />);
  fireEvent.click(await screen.findByRole('button', { name: 'project /' }));
  await vi.waitFor(() => expect((screen.getByLabelText('Browse remote folder') as HTMLInputElement).value).toBe('/home/u/project'));
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
  expect(select).toHaveBeenCalledWith('/home/u/project');
});

it('does not allow selecting a stale directory after a failed navigation', async () => {
  mocks.browse.mockResolvedValueOnce({ path: '/home/u', parent: '/home', entries: [] }).mockRejectedValueOnce(new Error('Folder not found'));
  render(<RemoteFolderPicker connectionId="remote-c" onSelect={vi.fn()} />);
  await screen.findByRole('button', { name: 'Use this folder' });
  fireEvent.change(screen.getByLabelText('Browse remote folder'), { target: { value: '/missing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Go' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement).disabled).toBe(true);
});
