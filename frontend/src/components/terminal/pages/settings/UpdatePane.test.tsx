import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SelfUpdateCheck, SelfUpdateJob, SelfUpdateStatus } from 'michi-shared';
import { UpdatePane } from './UpdatePane';

const mocks = vi.hoisted(() => ({ status: vi.fn(), check: vi.fn(), start: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../../services/api/selfUpdate', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../services/api/selfUpdate')>(),
  fetchSelfUpdate: mocks.status, checkSelfUpdate: mocks.check, startSelfUpdate: mocks.start,
}));
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: mocks.confirm }));

const CURRENT = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);
const status: SelfUpdateStatus = { supported: true, branch: 'main', current: { version: '1.4.0', revision: CURRENT }, job: null };
const available: SelfUpdateCheck = {
  ...status, state: 'available', latest: LATEST, total: 23, checkedAt: '2026-11-01T00:00:00Z',
  commits: [
    { revision: LATEST, subject: 'feat(settings): Update Michi from the phone', date: '2026-11-01T00:00:00Z' },
    { revision: 'c'.repeat(40), subject: 'fix(chat): Keep drafts', date: '2026-10-31T00:00:00Z' },
  ],
};
const running: SelfUpdateJob = {
  id: 'job-1', phase: 'running', stage: 'building', message: 'Building main bbbbbbbb', from: CURRENT, target: LATEST,
  startedAt: '2026-11-01T00:00:00Z', logFile: '/home/owner/.michi/self-update/job-1.log',
};

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(status);
  mocks.check.mockReset().mockResolvedValue(available);
  mocks.start.mockReset().mockResolvedValue(running);
  mocks.confirm.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); });

it('explains why a machine cannot update itself, without offering a check', async () => {
  mocks.status.mockResolvedValue({ ...status, supported: false, reason: 'Only a remote Linux machine running Michi can update itself from here.' });
  render(<UpdatePane />); await act(async () => {});
  expect(screen.getByText(/Only a remote Linux machine/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
});

it('checks main, confirms, follows the build through the restart and reloads into the new version', async () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  render(<UpdatePane reload={reload} />); await act(async () => {});
  expect(screen.getByText('aaaaaaa')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); await act(async () => {});
  expect(screen.getByText('23 new commits')).toBeTruthy();
  expect(screen.getByText('feat(settings): Update Michi from the phone')).toBeTruthy();
  expect(screen.getByText('And 21 more.')).toBeTruthy();

  // Cancelling the confirmation starts nothing.
  mocks.confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole('button', { name: 'Update now' })); await act(async () => {});
  expect(mocks.start).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Update now' })); await act(async () => {});
  expect(mocks.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringMatching(/builds main bbbbbbb.*interrupted/s) }));
  expect(mocks.start).toHaveBeenCalledWith(LATEST);
  expect(screen.getByText(/Building bbbbbbb beside the running Michi/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true);

  // The old backend stops while it switches; failed reads mean restarting.
  mocks.status.mockRejectedValue(new TypeError('Failed to fetch'));
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.getByText('Michi is restarting…')).toBeTruthy();

  // The new backend reports the outcome.
  mocks.status.mockResolvedValue({ ...status, current: { version: '1.5.0', revision: LATEST },
    job: { ...running, phase: 'succeeded', stage: 'done', message: 'Michi updated to bbbbbbb feat(settings): Update Michi from the phone' } });
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(screen.getByText(/Michi updated to bbbbbbb.*Reloading…/)).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(reload).toHaveBeenCalledTimes(1);
});

it('says when main is already current, and blocks an update the machine would refuse', async () => {
  mocks.check.mockResolvedValueOnce({ ...available, state: 'current', latest: CURRENT, commits: [], total: 0 });
  render(<UpdatePane />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); await act(async () => {});
  expect(screen.getByText('Up to date with main (aaaaaaa).')).toBeTruthy();

  mocks.check.mockResolvedValueOnce({ ...available, blocked: 'This machine’s Michi checkout has local changes that updating would not keep.' });
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toMatch(/local changes/);
  expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
});

it('shows the new commits when main moved after the check, and a failure with where its log is', async () => {
  const { SelfUpdateRequestError } = await import('../../../../services/api/selfUpdate');
  const moved: SelfUpdateCheck = { ...available, latest: 'd'.repeat(40), total: 24,
    commits: [{ revision: 'd'.repeat(40), subject: 'feat: Even newer', date: '2026-11-01T01:00:00Z' }, ...available.commits] };
  mocks.start.mockRejectedValueOnce(new SelfUpdateRequestError('main changed since the last check. Review the new commits, then update again.', 409, 'moved', moved));
  render(<UpdatePane />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' })); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Update now' })); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toMatch(/main changed/);
  expect(screen.getByText('feat: Even newer')).toBeTruthy();

  mocks.start.mockResolvedValueOnce({ ...running, target: moved.latest, phase: 'failed', message: 'Build failed; Michi keeps running /old' });
  fireEvent.click(screen.getByRole('button', { name: 'Update now' })); await act(async () => {});
  expect(mocks.start).toHaveBeenLastCalledWith(moved.latest);
  expect(screen.getByRole('heading', { name: 'Update failed' })).toBeTruthy();
  expect(screen.getByText('Build failed; Michi keeps running /old')).toBeTruthy();
  expect(screen.getByText(/job-1\.log on the machine/)).toBeTruthy();
});

it('resumes following an update that is already running when the page opens', async () => {
  vi.useFakeTimers();
  mocks.status.mockResolvedValue({ ...status, job: { ...running, stage: 'switching', message: 'Switching to the new build' } });
  render(<UpdatePane reload={() => {}} />); await act(async () => {});
  expect(screen.getByText(/Switching to the new build\. Running chats are interrupted/)).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(mocks.status).toHaveBeenCalledTimes(2);
});
