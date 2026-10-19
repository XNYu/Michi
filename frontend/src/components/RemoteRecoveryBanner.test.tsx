import { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteRecoveryBanner, RemoteRecoveryDrawer, RemoteRecoveryIndicator } from './RemoteRecoveryBanner';
import { clearRemoteRecoveryIssue, getRemoteRecoveryIssues, markRemoteRecoveryRetrying, reportRemoteRecoveryFailure, REMOTE_WORKSPACE_RETRY_EVENT } from '../state/remoteRecovery';
import { fetchAgentStatus } from '../services/api/agentRuntime';

vi.mock('../services/api/agentRuntime', () => ({ fetchAgentStatus: vi.fn().mockResolvedValue({ runtime: 'none', availableRuntimes: [], hasRequiredKey: false }) }));
const remote = { id: 'c', name: 'build+', sshHost: 'build+', transport: 'ssh' as const, hasToken: true, createdAt: 1, updatedAt: 1 };
const other = { ...remote, id: 'other', name: 'Other' };
function Recovery() {
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  return <>
    <RemoteRecoveryIndicator onOpenDetails={() => setOpen(true)} />
    <RemoteRecoveryBanner onOpenDetails={() => setOpen(true)} />
    <RemoteRecoveryDrawer open={open} onClose={onClose} motion="instant" />
  </>;
}
afterEach(() => {
  for (const issue of getRemoteRecoveryIssues()) clearRemoteRecoveryIssue(issue.connectionId);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('groups failures into a dismissible notice and keeps dismissed diagnostics reachable across retries and remounts', async () => {
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  reportRemoteRecoveryFailure(other, new Error('offline too'));
  const view = render(<Recovery />);
  expect(screen.getAllByRole('region', { name: 'Remote connection issues' })).toHaveLength(1);
  expect(screen.getByText('2 remotes unavailable')).toBeTruthy();
  expect(screen.queryByText('offline')).toBeNull();
  expect(fetchAgentStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss remote connection notice' }));
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
  fireEvent.click(within(screen.getByRole('region', { name: 'Remote recovery: build+' })).getByText('Connection details'));
  await screen.findByText('still offline');
  expect(fetchAgentStatus).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
});

it('shows a notice for a newly failing remote or a new outage after recovery, without reviving dismissed incidents', () => {
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  render(<Recovery />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss remote connection notice' }));
  act(() => { reportRemoteRecoveryFailure(other, new Error('new outage')); });
  expect(screen.getByText('2 remotes unavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss remote connection notice' }));
  act(() => { clearRemoteRecoveryIssue('other'); });
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  act(() => { clearRemoteRecoveryIssue('c'); });
  expect(screen.queryByRole('button', { name: /Remote connection details:/ })).toBeNull();
  act(() => { reportRemoteRecoveryFailure(remote, new Error('new incident')); });
  expect(screen.getByText('build+ is unavailable')).toBeTruthy();
});

it('keeps redacted history through retries and removes only the recovered machine before closing on full recovery', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  reportRemoteRecoveryFailure(remote, new Error('SSH authentication expired. Bearer private-value'));
  render(<Recovery />);
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  fireEvent.click(screen.getByText('Connection details'));
  await screen.findByText('No ready local runtime. View or copy diagnostics below.');
  fireEvent.click(screen.getByRole('button', { name: 'View logs' }));
  act(() => { reportRemoteRecoveryFailure(remote, new Error('VPN unavailable')); });
  expect((screen.getByLabelText('Connection log') as HTMLTextAreaElement).value).toContain('attempt 2');
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  await screen.findByText('Diagnostics copied.');
  expect(copy.mock.calls[0][0]).toContain('VPN unavailable');
  expect(copy.mock.calls[0][0]).not.toContain('private-value');
  act(() => { reportRemoteRecoveryFailure(other, new Error('offline')); clearRemoteRecoveryIssue('c'); });
  expect(screen.queryByRole('region', { name: 'Remote recovery: build+' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Remote recovery: Other' })).toBeTruthy();
  act(() => { clearRemoteRecoveryIssue('other'); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Remote connection issues' })).toBeNull();
  act(() => { reportRemoteRecoveryFailure(other, new Error('new outage')); });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('retries only the chosen machine and disables its action while a retry is in flight', () => {
  reportRemoteRecoveryFailure(remote, new Error('offline'));
  reportRemoteRecoveryFailure(other, new Error('offline'));
  const retry = vi.fn((event: Event) => markRemoteRecoveryRetrying((event as CustomEvent).detail.connectionId));
  window.addEventListener(REMOTE_WORKSPACE_RETRY_EVENT, retry);
  try {
    render(<Recovery />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const machine = within(screen.getByRole('region', { name: 'Remote recovery: build+' }));
    fireEvent.click(machine.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect((retry.mock.calls[0][0] as CustomEvent).detail).toEqual({ connectionId: 'c' });
    expect((machine.getByRole('button', { name: 'Trying…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(getRemoteRecoveryIssues()[1].retrying).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss remote connection notice' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(getRemoteRecoveryIssues()[0].retrying).toBe(true);
  } finally {
    window.removeEventListener(REMOTE_WORKSPACE_RETRY_EVENT, retry);
  }
});

it('bounds repeated failure logs and labels truncation', () => {
  for (let i = 0; i < 10; i++) reportRemoteRecoveryFailure(remote, new Error('x'.repeat(5000)));
  const report = getRemoteRecoveryIssues()[0].diagnostic;
  expect(report.log.length).toBeLessThanOrEqual(32_000);
  expect(report.truncated).toBe(true);
  expect(report.log).toContain('attempt 10');
});
