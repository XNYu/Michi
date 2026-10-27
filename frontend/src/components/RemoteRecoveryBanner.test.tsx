import { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteRecoveryDrawer, RemoteRecoveryIndicator } from './RemoteRecoveryBanner';
import { clearRemoteRecoveryIssue, getRemoteRecoveryIssues, markRemoteRecoveryRetrying, reportRemoteRecoveryFailure, reportRemoteRecoveryProgress, REMOTE_RECOVERY_GRACE_MS, REMOTE_WORKSPACE_RETRY_EVENT } from '../state/remoteRecovery';
import { fetchAgentStatus } from '../services/api/agentRuntime';
import { setKnownBackendConnections } from '../config/backendConnections';

const mocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('../services/api/agentRuntime', () => ({ fetchAgentStatus: vi.fn().mockResolvedValue({ runtime: 'none', availableRuntimes: [], hasRequiredKey: false }) }));
vi.mock('../services/api/remoteRecovery', async importOriginal => ({ ...await importOriginal<typeof import('../services/api/remoteRecovery')>(), recoverRemoteService: mocks.recover }));
const remote = { id: 'c', name: 'build+', sshHost: 'build+', transport: 'ssh' as const, hasToken: true, createdAt: 1, updatedAt: 1 };
const other = { ...remote, id: 'other', name: 'Other' };
const direct = { id: 'direct', name: 'Direct', transport: 'direct' as const, apiUrl: 'https://direct.example.com/api', hasToken: true, createdAt: 1, updatedAt: 1 };
function Recovery() {
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  return <>
    <RemoteRecoveryIndicator onOpenDetails={() => setOpen(true)} />
    <RemoteRecoveryDrawer open={open} onClose={onClose} motion="instant" />
  </>;
}
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
const elapseGracePeriod = () => act(() => { vi.advanceTimersByTime(REMOTE_RECOVERY_GRACE_MS); });
afterEach(() => {
  act(() => { for (const issue of getRemoteRecoveryIssues()) clearRemoteRecoveryIssue(issue.connectionId); });
  setKnownBackendConnections([]);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it('keeps startup failures quiet for five minutes, then offers diagnostics through an icon across retries and remounts', async () => {
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  reportRemoteRecoveryFailure(other, new Error('offline too'));
  const view = render(<Recovery />);
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  act(() => { vi.advanceTimersByTime(REMOTE_RECOVERY_GRACE_MS - 1); });
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  const indicator = screen.getByRole('button', { name: 'Remote connection details: 2 remotes unavailable' });
  expect(indicator.textContent).toBe('');
  expect(screen.queryByText('2 remotes unavailable')).toBeNull();
  expect(screen.queryByText('offline')).toBeNull();
  expect(fetchAgentStatus).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  act(() => {
    markRemoteRecoveryRetrying('c');
    reportRemoteRecoveryFailure(remote, new Error('still offline'));
  });
  expect(getRemoteRecoveryIssues()).toHaveLength(2);
  expect(getRemoteRecoveryIssues()[0].attempts).toBe(2);
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  view.unmount();
  render(<Recovery />);
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  const trigger = screen.getByRole('button', { name: 'Remote connection details: 2 remotes unavailable' });
  trigger.focus();
  fireEvent.click(trigger);
  const drawer = screen.getByRole('dialog', { name: 'Remote connections' });
  expect(within(drawer).getAllByText('Connection details')).toHaveLength(2);
  expect(fetchAgentStatus).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(within(screen.getByRole('region', { name: 'Remote recovery: build+' })).getByText('Connection details'));
    await vi.advanceTimersByTimeAsync(1);
  });
  await screen.findByText('still offline');
  expect(fetchAgentStatus).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
});

it('never surfaces a startup outage that recovers during the grace period and gives a later outage its own grace period', () => {
  reportRemoteRecoveryProgress(remote, 'Opening SSH forwarding…', {
    id: 'old-service-attempt', host: 'box', stage: 'ssh', startedAt: '2020-01-01T00:00:00Z', log: '', truncated: false,
  });
  render(<Recovery />);
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(60_000);
    reportRemoteRecoveryFailure(remote, new Error('still starting'));
    clearRemoteRecoveryIssue('c');
  });
  elapseGracePeriod();
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  act(() => { reportRemoteRecoveryFailure(remote, new Error('new incident')); });
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  elapseGracePeriod();
  expect(screen.getByRole('button', { name: 'Remote connection details: build+ is unavailable' })).toBeTruthy();
});

it('preserves the first observation through progress and retries, with independent deadlines for multiple remotes', () => {
  reportRemoteRecoveryProgress(remote, 'Checking SSH…');
  render(<Recovery />);
  act(() => {
    vi.advanceTimersByTime(60_000);
    reportRemoteRecoveryFailure(remote, new Error('timed out'));
    reportRemoteRecoveryFailure(other, new Error('offline'));
    markRemoteRecoveryRetrying('c');
  });
  act(() => { vi.advanceTimersByTime(REMOTE_RECOVERY_GRACE_MS - 60_000); });
  expect(screen.getByRole('button', { name: 'Remote connection details: build+ is unavailable' })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByRole('button', { name: 'Remote connection details: 2 remotes unavailable' })).toBeTruthy();
  act(() => { clearRemoteRecoveryIssue('c'); });
  expect(screen.getByRole('button', { name: 'Remote connection details: Other is unavailable' })).toBeTruthy();
});

it('keeps redacted history through retries and removes only the recovered machine before closing on full recovery', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  reportRemoteRecoveryFailure(remote, new Error('SSH authentication expired. Bearer private-value'));
  render(<Recovery />);
  elapseGracePeriod();
  fireEvent.click(screen.getByRole('button', { name: /Remote connection details:/ }));
  fireEvent.click(screen.getByText('Connection details'));
  await screen.findByText('No ready local runtime. View or copy diagnostics below.');
  fireEvent.click(screen.getByRole('button', { name: 'View logs' }));
  act(() => { reportRemoteRecoveryFailure(remote, new Error('VPN unavailable')); });
  expect((screen.getByLabelText('Connection log') as HTMLTextAreaElement).value).toContain('attempt 2');
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  await screen.findByText('Diagnostics copied.');
  expect(copy.mock.calls[0][0]).toContain('VPN unavailable');
  expect(copy.mock.calls[0][0]).not.toContain('private-value');
  act(() => { reportRemoteRecoveryFailure(other, new Error('offline')); });
  elapseGracePeriod();
  act(() => { clearRemoteRecoveryIssue('c'); });
  expect(screen.queryByRole('region', { name: 'Remote recovery: build+' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Remote recovery: Other' })).toBeTruthy();
  act(() => { clearRemoteRecoveryIssue('other'); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  act(() => { reportRemoteRecoveryFailure(other, new Error('new outage')); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('retries only the chosen machine and disables its action while a retry is in flight', () => {
  setKnownBackendConnections([remote, other]);
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  reportRemoteRecoveryFailure(other, new Error('offline'));
  // A waiting workspace load takes the retry, so the gateway is not asked to recover.
  const retry = vi.fn((event: Event) => { event.preventDefault(); markRemoteRecoveryRetrying((event as CustomEvent).detail.connectionId); });
  window.addEventListener(REMOTE_WORKSPACE_RETRY_EVENT, retry);
  try {
    render(<Recovery />);
    elapseGracePeriod();
    fireEvent.click(screen.getByRole('button', { name: /Remote connection details:/ }));
    const machine = within(screen.getByRole('region', { name: 'Remote recovery: build+' }));
    fireEvent.click(machine.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect((retry.mock.calls[0][0] as CustomEvent).detail).toEqual({ connectionId: 'c' });
    expect((machine.getByRole('button', { name: 'Trying…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(getRemoteRecoveryIssues()[1].retrying).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
    expect(retry).toHaveBeenCalledOnce();
    expect(getRemoteRecoveryIssues()[0].retrying).toBe(true);
  } finally {
    window.removeEventListener(REMOTE_WORKSPACE_RETRY_EVENT, retry);
  }
});

it('asks the gateway to recover a loaded SSH machine when no workspace load takes the retry', async () => {
  setKnownBackendConnections([remote, direct]);
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  reportRemoteRecoveryFailure(direct, new Error('offline'));
  let accept!: () => void;
  mocks.recover.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }))
    .mockRejectedValueOnce(new Error('Could not reconnect. Try connecting to this machine again.'));
  render(<Recovery />);
  elapseGracePeriod();
  fireEvent.click(screen.getByRole('button', { name: /Remote connection details:/ }));
  const machine = within(screen.getByRole('region', { name: 'Remote recovery: build+' }));
  fireEvent.click(machine.getByRole('button', { name: 'Try again' }));
  expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('c');
  expect((machine.getByRole('button', { name: 'Trying…' }) as HTMLButtonElement).disabled).toBe(true);
  // Accepting the request does not settle it: the recovery monitor reports its outcome.
  await act(async () => { accept(); });
  expect(getRemoteRecoveryIssues()[0].retrying).toBe(true);
  act(() => { reportRemoteRecoveryFailure(remote, new Error('still offline')); });
  fireEvent.click(machine.getByRole('button', { name: 'Try again' }));
  await act(async () => {});
  expect(mocks.recover).toHaveBeenCalledTimes(2);
  expect(getRemoteRecoveryIssues()[0]).toEqual(expect.objectContaining({ retrying: false, diagnostic: expect.objectContaining({ message: 'Could not reconnect. Try connecting to this machine again.' }) }));
  // Gateway recovery covers SSH connections only.
  fireEvent.click(within(screen.getByRole('region', { name: 'Remote recovery: Direct' })).getByRole('button', { name: 'Try again' }));
  expect(mocks.recover).toHaveBeenCalledTimes(2);
});

it('bounds repeated failure logs and labels truncation', () => {
  for (let i = 0; i < 10; i++) reportRemoteRecoveryFailure(remote, new Error('x'.repeat(5000)));
  const report = getRemoteRecoveryIssues()[0].diagnostic;
  expect(report.log.length).toBeLessThanOrEqual(32_000);
  expect(report.truncated).toBe(true);
  expect(report.log).toContain('attempt 10');
});
