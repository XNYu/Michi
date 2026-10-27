import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunProgressDto } from 'michi-shared';
import type { SpacesFirstRunStatus } from '../../services/api/spacesHome';

const api = vi.hoisted(() => ({
  start: vi.fn(),
  fetch: vi.fn(),
  retry: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('../../services/api/spacesHome', () => ({
  startSpacesFirstRun: api.start,
  fetchSpacesFirstRun: api.fetch,
  retrySpacesFirstRun: api.retry,
}));
vi.mock('../pages/pageEvents', () => ({ notifyPageChanged: api.changed }));

import {
  FIRST_RUN_POLL_MS,
  firstRunActive,
  firstRunClosed,
  firstRunProgress,
  isWorkspaceHomeNew,
  markWorkspaceHomeOpened,
  readSpacesFirstRun,
  resetSpacesFirstRunStore,
  retrySpacesFirstRunNow,
  spacesHomeUpdating,
  startSpacesFirstRunVisit,
  subscribeFirstRunFinished,
  useSpacesFirstRun,
} from './spacesFirstRun';

const run = (state: FirstRunProgressDto['state'], readCount: number, total: number, updatedAt = 1): FirstRunProgressDto => ({
  workspaceId: 'w', startedAt: 1, startSeq: 4, readCount, total, state, error: null, updatedAt,
});
const status = (runs: Array<FirstRunProgressDto | null>, summary: SpacesFirstRunStatus['summary']['state'] = 'waiting', extra: Partial<SpacesFirstRunStatus> = {}): SpacesFirstRunStatus => ({
  requestedAt: 1,
  workspaces: runs.map((firstRun, index) => ({ workspaceId: `ws-${index}`, workspaceName: `W${index}`, homePageId: null, hiddenAt: null, firstRun })),
  summary: { state: summary, summarizedAt: null },
  haltedReason: null,
  ...extra,
});
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  resetSpacesFirstRunStore();
  for (const fn of Object.values(api)) fn.mockReset();
  localStorage.removeItem('michi.spaces-home.opened');
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('first-run progress', () => {
  it('counts what was read and what is in progress over the shown workspaces', () => {
    const value = status([run('done', 38, 38), run('reading', 12, 21), run('queued', 0, 17), run('failed', 2, 6)]);
    value.workspaces.push({ workspaceId: 'hidden', workspaceName: 'H', homePageId: null, hiddenAt: 1, firstRun: run('reading', 1, 99) });
    const progress = firstRunProgress(value);
    expect(progress).toMatchObject({ read: 52, total: 82, done: 1 });
    expect(progress.current?.workspaceId).toBe('ws-1');
    expect(progress.failed.map((item) => item.workspaceId)).toEqual(['ws-3']);
    expect(firstRunActive(value)).toBe(true);
    expect(firstRunActive(status([run('done', 1, 1)], 'running'))).toBe(true);
    expect(firstRunActive(status([run('done', 1, 1)], 'done'))).toBe(false);
    expect(firstRunActive(status([run('reading', 1, 3)], 'waiting', { haltedReason: 'kiro: fs_write' }))).toBe(false);
    expect(firstRunActive(status([run('reading', 1, 3)], 'waiting', { requestedAt: null }))).toBe(false);
  });

  it('treats a summary after the first run closed as an ordinary update, not the first run', () => {
    const later = (summary: SpacesFirstRunStatus['summary']['state']) => status([run('done', 38, 38)], summary, { closed: true });
    expect(firstRunClosed(later('due'))).toBe(true);
    expect(firstRunActive(later('due'))).toBe(false);
    expect(firstRunActive(later('running'))).toBe(false);
    expect(spacesHomeUpdating(later('due'))).toBe(false);
    expect(spacesHomeUpdating(later('running'))).toBe(true);
    expect(spacesHomeUpdating({ ...later('running'), haltedReason: 'kiro: fs_write' })).toBe(false);
    // Still the first run: its closing summary has not settled.
    expect(firstRunActive(status([run('done', 38, 38)], 'running', { closed: false }))).toBe(true);
    expect(spacesHomeUpdating(status([run('done', 38, 38)], 'running', { closed: false }))).toBe(false);
    // A workspace added later reads its history on its own; the first run stays closed.
    expect(firstRunActive(status([run('done', 38, 38), run('reading', 2, 6)], 'waiting', { closed: true }))).toBe(false);
    // A backend that does not report `closed`: a written summary closed the first run.
    expect(firstRunActive(status([run('done', 38, 38)], 'due', { summary: { state: 'due', summarizedAt: 5 } }))).toBe(false);
    expect(firstRunActive(status([run('done', 38, 38)], 'due'))).toBe(true);
  });
});

describe('useSpacesFirstRun', () => {
  it('starts on a visit, polls while anything is in progress, and stops once it is done', async () => {
    api.start.mockResolvedValue(status([run('reading', 3, 10)]));
    api.fetch.mockResolvedValueOnce(status([run('reading', 7, 10)]))
      .mockResolvedValueOnce(status([run('done', 10, 10)], 'done'));
    const finished = vi.fn();
    const stop = subscribeFirstRunFinished(finished);
    const { result } = renderHook(() => useSpacesFirstRun('local', { start: true }));
    await flush();
    expect(api.start).toHaveBeenCalledWith('local');
    expect(result.current.data?.workspaces[0].firstRun?.readCount).toBe(3);

    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS); });
    await flush();
    expect(result.current.data?.workspaces[0].firstRun?.readCount).toBe(7);
    expect(api.changed).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS); });
    await flush();
    expect(result.current.justFinished).toBe(true);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(api.changed).toHaveBeenCalledWith({ backendConnectionId: 'local' });

    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS * 3); });
    expect(api.fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps reading through a later summary to refresh the pages, without announcing a first run again', async () => {
    const later = (summary: SpacesFirstRunStatus['summary']['state']) => status([run('done', 10, 10)], summary, { closed: true });
    api.start.mockResolvedValue(later('due'));
    api.fetch.mockResolvedValueOnce(later('running')).mockResolvedValueOnce(later('done'));
    const finished = vi.fn();
    const stop = subscribeFirstRunFinished(finished);
    const { result } = renderHook(() => useSpacesFirstRun('local', { start: true }));
    await flush();
    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS); });
    await flush();
    expect(result.current.data?.summary.state).toBe('running');
    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS); });
    await flush();
    expect(result.current.data?.summary.state).toBe('done');
    expect(api.changed).toHaveBeenCalledWith({ backendConnectionId: 'local' });
    expect(result.current.justFinished).toBe(false);
    expect(finished).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS * 3); });
    expect(api.fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('pauses the poll while the window is hidden and reads again when it shows', async () => {
    api.start.mockResolvedValue(status([run('reading', 3, 10)]));
    api.fetch.mockResolvedValue(status([run('reading', 4, 10)]));
    renderHook(() => useSpacesFirstRun('local', { start: true }));
    await flush();
    visibility = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { vi.advanceTimersByTime(FIRST_RUN_POLL_MS * 5); });
    expect(api.fetch).not.toHaveBeenCalled();
    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it('only reads when not a visit, and lets a visit in flight answer instead of racing it', async () => {
    let answer: (value: SpacesFirstRunStatus) => void = () => {};
    api.start.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    api.fetch.mockResolvedValue(status([null]));
    renderHook(() => { useSpacesFirstRun('local', { start: true }); return useSpacesFirstRun('local'); });
    await flush();
    expect(api.fetch).not.toHaveBeenCalled();
    await act(async () => { answer(status([run('queued', 0, 4)])); });
    await flush();
    expect(readSpacesFirstRun('local').data?.workspaces[0].firstRun?.state).toBe('queued');
  });

  it('notes when scheduled jobs are off, still reads the status, and tells an unreachable backend apart', async () => {
    api.start.mockRejectedValueOnce(httpError(409));
    api.fetch.mockResolvedValueOnce(status([null]));
    renderHook(() => useSpacesFirstRun('local', { start: true }));
    await flush();
    expect(readSpacesFirstRun('local')).toMatchObject({ load: 'ready', schedulerOff: true, unreachable: false });

    resetSpacesFirstRunStore();
    api.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderHook(() => useSpacesFirstRun('local'));
    await flush();
    expect(readSpacesFirstRun('local')).toMatchObject({ load: 'error', unreachable: true });

    resetSpacesFirstRunStore();
    api.fetch.mockRejectedValueOnce(httpError(404));
    renderHook(() => useSpacesFirstRun('local'));
    await flush();
    expect(readSpacesFirstRun('local')).toMatchObject({ load: 'unavailable', unreachable: false });
  });

  it('retries one failed workspace and takes its answer', async () => {
    api.retry.mockResolvedValue(status([run('queued', 0, 4)]));
    await act(async () => { await retrySpacesFirstRunNow('local', 'ws-0'); });
    expect(api.retry).toHaveBeenCalledWith('local', 'ws-0');
    expect(readSpacesFirstRun('local').data?.workspaces[0].firstRun?.state).toBe('queued');
  });

  it('never starts or queues a first run on a remote connection', async () => {
    await act(async () => {
      await startSpacesFirstRunVisit('remote-box');
      await retrySpacesFirstRunNow('remote-box', 'remote:remote-box:ws-1');
    });
    expect(api.start).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
  });
});

describe('New on a written workspace home', () => {
  it('holds until the home is opened after it was written, and not for an empty workspace', () => {
    expect(isWorkspaceHomeNew('local', 'ws-1', run('done', 3, 3, 50))).toBe(true);
    expect(isWorkspaceHomeNew('local', 'ws-1', run('done', 0, 0, 50))).toBe(false);
    expect(isWorkspaceHomeNew('local', 'ws-1', run('reading', 1, 3, 50))).toBe(false);
    markWorkspaceHomeOpened('local', 'ws-1', 50);
    expect(isWorkspaceHomeNew('local', 'ws-1', run('done', 3, 3, 50))).toBe(false);
    expect(isWorkspaceHomeNew('local', 'ws-1', run('done', 3, 3, 60))).toBe(true);
    expect(isWorkspaceHomeNew('remote', 'ws-1', run('done', 3, 3, 50))).toBe(true);
    expect(JSON.parse(localStorage.getItem('michi.spaces-home.opened')!)).toEqual({ 'local|ws-1': 50 });
  });
});
