import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteDesktopConnect } from './RemoteDesktopConnect';
import { REMOTE_DIAGNOSTIC_AGENT_EVENT, type DiagnosticAgentRequest } from '../services/remoteDiagnosticAgent';
import { RemoteFolderPicker } from './RemoteFolderPicker';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), browse: vi.fn(), status: vi.fn() }));
vi.mock('../services/api/backendConnections', () => ({
  connectRemoteDesktop: mocks.connect, browseRemoteDirectory: mocks.browse,
}));
vi.mock('../services/api/agentRuntime', () => ({ fetchAgentStatus: mocks.status }));
beforeEach(() => { mocks.connect.mockReset(); mocks.browse.mockReset(); mocks.status.mockReset().mockResolvedValue({ runtime: 'none', availableRuntimes: [], hasRequiredKey: false }); });
afterEach(() => vi.unstubAllGlobals());

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
  await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ id: 'remote-c', name: 'build+' }, '/home/u', [], ['kiro'], undefined));
  expect(mocks.connect.mock.calls[1].slice(0, 2)).toEqual(['build+', true]);
  expect(screen.queryByPlaceholderText('MICHI_REMOTE_TOKEN')).toBeNull();
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
  expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull();
});

const report = { id: 'attempt-test', host: 'build+', startedAt: '2026-10-16T12:00:00Z', stage: 'build', code: 'build', message: 'Remote build failed', log: 'npm ERR! missing dependency', truncated: false };
async function failConnection() {
  mocks.connect.mockRejectedValue(Object.assign(new Error(report.message), { diagnostic: report }));
  render(<RemoteDesktopConnect onConnected={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Remote SSH host'), { target: { value: 'build+' } });
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
  await screen.findByRole('alert');
}

it('keeps the copy fallback visible if local chat handoff fails', async () => {
  mocks.status.mockResolvedValue({ runtime: 'codex', hasRequiredKey: true,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }] });
  await failConnection();
  fireEvent.click(await screen.findByRole('button', { name: 'Ask local agent' }));
  await screen.findByText(/Local conversation is unavailable/);
  expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy();
});

it('cancels a pending agent handoff when the connection dialog is dismissed', async () => {
  mocks.status.mockResolvedValue({ runtime: 'codex', hasRequiredKey: true,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }] });
  let request: DiagnosticAgentRequest | undefined;
  const handle = (event: Event) => { event.preventDefault(); request = (event as CustomEvent<DiagnosticAgentRequest>).detail; };
  window.addEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle);
  try {
    await failConnection();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask local agent' }));
    await vi.waitFor(() => expect(request).toBeTruthy());
    cleanup();
    expect(request?.cancelled).toBe(true);
  } finally { window.removeEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle); }
});

it('exposes saved runtime warning diagnostics and can hand them to the local agent', async () => {
  const warningReport = { ...report, id: 'warning-report', severity: 'warning' as const, stage: 'runtime', code: 'runtime_warning', message: 'Codex needs sign-in', log: '[status] Codex authentication file missing' };
  mocks.connect.mockResolvedValue({ kind: 'connected', connection: { id: 'remote-c', name: 'build+' }, home: '/home/u', runtimes: ['codex'], runtimeWarnings: ['Codex needs sign-in'], diagnostic: warningReport });
  mocks.status.mockResolvedValue({ runtime: 'codex', hasRequiredKey: true, availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }] });
  const sent = vi.fn();
  const handle = (event: Event) => { event.preventDefault(); const request = (event as CustomEvent<DiagnosticAgentRequest>).detail; sent(request); request.resolve(); };
  window.addEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle);
  try {
    render(<RemoteDesktopConnect onConnected={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Remote SSH host'), { target: { value: 'build+' } });
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }));
    await screen.findByText('Connected to build+');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }));
    expect((screen.getByLabelText('Connection log') as HTMLTextAreaElement).value).toContain('Codex authentication file missing');
    fireEvent.click(await screen.findByRole('button', { name: 'Ask local agent' }));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent.mock.calls[0][0].prompt).toContain('The machine connected');
    expect(sent.mock.calls[0][0].binding.runtimeId).toBe('codex');
  } finally { window.removeEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle); }
});
