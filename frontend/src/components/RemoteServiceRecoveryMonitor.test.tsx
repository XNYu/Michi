import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteServiceRecoveryMonitor } from './RemoteServiceRecoveryMonitor';
import { setKnownBackendConnections } from '../config/backendConnections';
import { clearRemoteRecoveryIssue, getRemoteRecoveryIssues, REMOTE_WORKSPACE_RETRY_EVENT, reportRemoteRecoveryFailure } from '../state/remoteRecovery';
import { closeRemoteAuthentication, completeRemoteAuthentication, getRemoteAuthentication } from '../state/remoteAuthentication';
import { formatRemoteDiagnostic } from 'michi-shared';
import { RemoteServiceRecoveryError } from '../services/api/remoteRecovery';

const mocks = vi.hoisted(() => ({ statuses: vi.fn(), metadata: vi.fn() }));
vi.mock('../services/api/remoteRecovery', async importOriginal => ({ ...await importOriginal<typeof import('../services/api/remoteRecovery')>(), fetchRemoteServiceRecoveries: mocks.statuses }));
vi.mock('../services/api/persistence', () => ({ fetchAllWorkspacesMeta: mocks.metadata }));
const connection = { id: 'monitor-host', name: 'Remote', transport: 'ssh' as const, sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 };
beforeEach(() => {
  vi.useFakeTimers(); mocks.statuses.mockReset(); mocks.metadata.mockReset();
  setKnownBackendConnections([connection]);
});
afterEach(() => {
  vi.useRealTimers(); clearRemoteRecoveryIssue(connection.id); closeRemoteAuthentication();
  completeRemoteAuthentication(`service:${connection.id}`); setKnownBackendConnections([]);
});

it('retains failure diagnostics and clears a post-hydration issue only after metadata is readable, including an empty list', async () => {
  const ready = { connectionId: connection.id, phase: 'ready', message: 'Ready', diagnostic: { id: 'attempt-1' } };
  mocks.statuses.mockResolvedValueOnce([{ connectionId: connection.id, phase: 'error', message: 'Remote sign-in expired',
    diagnostic: { id: 'attempt-1', stage: 'ssh', code: 'remote_credentials', log: 'Actual SSH startup output', authentication: { scope: 'remote', host: 'box' } },
    authentication: { scope: 'remote', host: 'box' } }]).mockResolvedValue([ready]);
  let resolveMeta!: (result: unknown[]) => void;
  mocks.metadata.mockImplementation(() => new Promise(resolve => { resolveMeta = resolve; }));
  const wake = vi.fn(); window.addEventListener(REMOTE_WORKSPACE_RETRY_EVENT, wake);
  const view = render(<RemoteServiceRecoveryMonitor />);
  await act(async () => {});
  expect(getRemoteRecoveryIssues()[0].diagnostic.log).toContain('Actual SSH startup output');
  expect(getRemoteAuthentication()?.target.scope).toBe('remote'); closeRemoteAuthentication();
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(getRemoteRecoveryIssues()).toHaveLength(1);
  expect(mocks.metadata).toHaveBeenCalledWith(connection.id, expect.any(AbortSignal));
  await act(async () => { resolveMeta([]); });
  expect(getRemoteRecoveryIssues()).toHaveLength(0); expect(wake).toHaveBeenCalledOnce();
  view.unmount(); window.removeEventListener(REMOTE_WORKSPACE_RETRY_EVENT, wake);
});

it('keeps the notice when metadata remains unavailable and aborts in-flight polling on unmount', async () => {
  reportRemoteRecoveryFailure(connection, new Error('Service stopped'));
  mocks.statuses.mockResolvedValue([{ connectionId: connection.id, phase: 'ready', message: 'Ready' }]);
  mocks.metadata.mockRejectedValue(new Error('Remote database still unavailable'));
  const view = render(<RemoteServiceRecoveryMonitor />);
  await act(async () => {});
  expect(getRemoteRecoveryIssues()[0].diagnostic.message).toBe('Remote database still unavailable');
  const signal = mocks.statuses.mock.calls[0][0] as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mocks.statuses).toHaveBeenCalledOnce();
});

it('updates live progress and logs without inventing failures or counting each poll as a new attempt', async () => {
  const report = { id: 'ssh-attempt', host: 'box', startedAt: '2026-10-18T08:34:48Z', stage: 'ssh', log: 'Checking SSH\n', truncated: false, severity: 'info' as const };
  mocks.statuses.mockResolvedValueOnce([{ connectionId: connection.id, phase: 'starting', message: 'Checking SSH…', diagnostic: report }])
    .mockResolvedValueOnce([{ connectionId: connection.id, phase: 'starting', message: 'Opening SSH forwarding…', diagnostic: { ...report, stage: 'tunnel', log: report.log + 'Forwarding\n' } }])
    .mockResolvedValue([{ connectionId: connection.id, phase: 'error', message: 'Remote recovery timed out at tunnel', diagnostic: { ...report, stage: 'tunnel', severity: 'error', code: 'recovery_timeout', log: report.log + 'Forwarding\nTimed out\n' } }]);
  const view = render(<RemoteServiceRecoveryMonitor />);
  await act(async () => {});
  expect(getRemoteRecoveryIssues()[0].attempts).toBe(0);
  expect(formatRemoteDiagnostic(getRemoteRecoveryIssues()[0].diagnostic)).toContain('Status: Checking SSH…');
  expect(formatRemoteDiagnostic(getRemoteRecoveryIssues()[0].diagnostic)).not.toContain('Error:');
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  const progress = getRemoteRecoveryIssues()[0];
  expect(progress.diagnostic.stage).toBe('tunnel');
  expect(progress.diagnostic.log.match(/Checking SSH/g)).toHaveLength(1);
  expect(progress.attempts).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  const failed = getRemoteRecoveryIssues()[0];
  expect(failed.retrying).toBe(false); expect(failed.attempts).toBe(1);
  expect(failed.diagnostic.code).toBe('recovery_timeout');
  expect(failed.diagnostic.severity).toBe('error');
  expect(failed.diagnostic.log.match(/Checking SSH/g)).toHaveLength(1);
  view.unmount();
});

it('keeps recovery progress returned by workspace loading and counts a shared service failure once', () => {
  const diagnostic = { id: 'proxy-attempt', host: 'box', startedAt: 'now', stage: 'ssh', log: 'Waiting for SSH\n', truncated: false };
  reportRemoteRecoveryFailure(connection, new RemoteServiceRecoveryError('HTTP 502: Starting remote Michi…', {
    connectionId: connection.id, phase: 'starting', message: 'Checking SSH…', diagnostic,
  }));
  expect(getRemoteRecoveryIssues()[0].diagnostic.severity).toBe('info');
  expect(getRemoteRecoveryIssues()[0].attempts).toBe(0);
  const error = new RemoteServiceRecoveryError('HTTP 502', { connectionId: connection.id, phase: 'error', message: 'SSH timed out', diagnostic: { ...diagnostic, code: 'recovery_timeout' } });
  reportRemoteRecoveryFailure(connection, error); reportRemoteRecoveryFailure(connection, error);
  expect(getRemoteRecoveryIssues()[0].attempts).toBe(1);
  expect(getRemoteRecoveryIssues()[0].diagnostic.message).toBe('SSH timed out');
  expect(getRemoteRecoveryIssues()[0].diagnostic.log.match(/Waiting for SSH/g)).toHaveLength(1);
});
