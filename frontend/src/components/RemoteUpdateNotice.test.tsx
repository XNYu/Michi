import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteUpdateJob } from 'michi-shared';
import { REMOTE_UPDATE_POLL_MS, RemoteUpdateNotice } from './RemoteUpdateNotice';
import { getRemoteAuthentication } from '../state/remoteAuthentication';

const mocks = vi.hoisted(() => ({ check: vi.fn(), update: vi.fn(), fetch: vi.fn() }));
vi.mock('../services/api/remoteUpdate', () => ({ checkRemoteVersion: mocks.check, updateRemoteBackend: mocks.update, fetchRemoteUpdate: mocks.fetch }));
vi.mock('./RemoteDiagnostics', () => ({ RemoteDiagnostics: () => <div>Update diagnostics</div> }));
const older = { local: { version: '1.0.0', revision: 'bbbbbbb' }, remote: { version: '1.0.0', revision: 'aaaaaaa' }, state: 'older', canUpdate: true };
const current = { ...older, remote: older.local, state: 'current', canUpdate: false };
const job = (overrides: Partial<RemoteUpdateJob>): RemoteUpdateJob => ({
  connectionId: 'box', attemptId: 'attempt', phase: 'running', stage: 'build', message: '', startedAt: '2026-10-23T00:00:00.000Z', ...overrides,
});
const advancePoll = () => act(async () => { await vi.advanceTimersByTimeAsync(REMOTE_UPDATE_POLL_MS); });
beforeEach(() => { mocks.check.mockReset().mockResolvedValue(older); mocks.update.mockReset(); mocks.fetch.mockReset().mockResolvedValue(null); });
afterEach(() => { vi.useRealTimers(); });

it('shows the local and remote versions and updates with progress before clearing the reminder', async () => {
  let finish!: (value: unknown) => void;
  mocks.update.mockImplementation((_id, _host, progress) => { progress('Building remotely…'); return new Promise(resolve => { finish = resolve; }); });
  const refreshed = vi.fn();
  render(<RemoteUpdateNotice connectionId="box" name="Build box" onUpdated={refreshed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update remote Michi' }));
  expect(screen.getByText('Remote aaaaaaa · This app bbbbbbb')).toBeTruthy();
  expect(screen.getByText('Building remotely…')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Updating…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(refreshed).not.toHaveBeenCalled();
  await act(async () => { finish(current); });
  expect(screen.queryByText('Remote Michi is older than this app')).toBeNull();
  expect(screen.getByText('Remote Michi is up to date.')).toBeTruthy();
  expect(refreshed).toHaveBeenCalledOnce();
});

it('keeps the update action available after failure and shows saved diagnostics', async () => {
  mocks.update.mockRejectedValue(Object.assign(new Error('Remote build failed'), { diagnostic: { id: 'report' } }));
  render(<RemoteUpdateNotice connectionId="box" name="Build box" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update remote Michi' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Remote build failed');
  expect((screen.getByRole('button', { name: 'Update remote Michi' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText('Update diagnostics')).toBeTruthy();
  expect(screen.queryByText('Remote Michi is up to date.')).toBeNull();
});

it('reopened during an update, follows its progress and outcome instead of offering another update', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // The version check started mid-update answers after the update finished.
  let answerCheck!: (value: unknown) => void;
  mocks.check.mockReturnValue(new Promise(resolve => { answerCheck = resolve; }));
  mocks.fetch.mockResolvedValueOnce(job({ message: 'Building remotely…' }))
    .mockResolvedValueOnce(job({ stage: 'verify', message: 'Reconnecting and verifying the updated Michi service…' }))
    .mockResolvedValueOnce(job({ phase: 'succeeded', stage: 'complete', message: 'Remote Michi is up to date.', result: current as RemoteUpdateJob['result'] }));
  const refreshed = vi.fn();
  render(<RemoteUpdateNotice connectionId="box" name="Build box" onUpdated={refreshed} />);
  expect((await screen.findByRole('button', { name: 'Updating…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Updating remote Michi')).toBeTruthy();
  expect(screen.getByText('Building remotely…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Update remote Michi' })).toBeNull();
  await advancePoll();
  expect(screen.getByText('Reconnecting and verifying the updated Michi service…')).toBeTruthy();
  expect(refreshed).not.toHaveBeenCalled();
  await advancePoll();
  expect(screen.getByText('Remote Michi is up to date.')).toBeTruthy();
  expect(refreshed).toHaveBeenCalledOnce();
  await act(async () => { answerCheck(older); });
  expect(screen.queryByText('Remote Michi is older than this app')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  await advancePoll();
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
  expect(mocks.update).not.toHaveBeenCalled();
});

it('reopened after a failed update, shows that failure with diagnostics and a retry without asking for sign-in again', async () => {
  const authentication = { scope: 'local' as const, host: 'box' };
  mocks.fetch.mockResolvedValue(job({ phase: 'failed', stage: 'build', message: 'Remote build failed', diagnostic: { id: 'report', host: 'box', startedAt: '', stage: 'build', log: '', truncated: false, authentication } }));
  render(<RemoteUpdateNotice connectionId="box" name="Build box" />);
  expect((await screen.findByRole('alert')).textContent).toContain('Remote build failed');
  expect(screen.getByText('Update diagnostics')).toBeTruthy();
  expect((await screen.findByRole('button', { name: 'Update remote Michi' }) as HTMLButtonElement).disabled).toBe(false);
  expect(getRemoteAuthentication()).toBeNull();
});

it('follows the running update when a duplicate request is rejected, without reporting a failure', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.update.mockRejectedValue(Object.assign(new Error('This machine is already updating.'), { diagnostic: { id: 'client-1', stage: 'request', code: 'connection_interrupted' } }));
  mocks.fetch.mockResolvedValueOnce(null)
    .mockResolvedValueOnce(job({ attemptId: 'elsewhere', message: 'Building remotely…' }))
    .mockResolvedValueOnce(job({ attemptId: 'elsewhere', phase: 'succeeded', stage: 'complete', message: 'Remote Michi is up to date.', result: current as RemoteUpdateJob['result'] }));
  const refreshed = vi.fn();
  render(<RemoteUpdateNotice connectionId="box" name="Build box" onUpdated={refreshed} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update remote Michi' }));
  expect(await screen.findByText('Building remotely…')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Updating…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  await advancePoll();
  expect(screen.getByText('Remote Michi is up to date.')).toBeTruthy();
  expect(refreshed).toHaveBeenCalledOnce();
});

it('shows manual guidance for direct connections and hides the action for current or different versions', async () => {
  mocks.check.mockResolvedValueOnce({ ...older, canUpdate: false, message: 'Connect over SSH to update.' });
  const { rerender } = render(<RemoteUpdateNotice connectionId="direct" name="Direct" />);
  expect(await screen.findByText('Connect over SSH to update.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Update remote Michi' })).toBeNull();
  mocks.check.mockResolvedValueOnce({ ...older, state: 'different', canUpdate: false });
  rerender(<RemoteUpdateNotice connectionId="other" name="Other" />);
  await vi.waitFor(() => expect(screen.queryByText('Remote Michi is older than this app')).toBeNull());
});
