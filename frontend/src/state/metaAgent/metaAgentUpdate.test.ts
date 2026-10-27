import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentRoundStatus, MetaAgentRunNowResponse, MetaAgentRunNowWorkspace } from 'michi-shared';

const api = vi.hoisted(() => ({
  roundNow: vi.fn(),
  round: vi.fn(),
  overview: vi.fn(),
  resume: vi.fn(),
  retryGuard: vi.fn(),
  info: null as unknown,
  firstRunData: null as unknown,
  wake: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('../../services/api/pageMaintenance', () => ({ runMetaAgentRoundNow: api.roundNow, fetchMetaAgentRound: api.round }));
vi.mock('../pages/pageEvents', () => ({ notifyPageChanged: api.changed }));
vi.mock('./useMetaAgentOverview', () => ({ refreshMetaAgentOverview: api.overview, resumeMetaAgent: api.resume }));
vi.mock('./useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useMetaAgent')>()),
  readMetaAgent: () => ({ status: 'ready', info: api.info, error: null }),
  retryMetaAgentGuard: api.retryGuard,
}));
vi.mock('./spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spacesFirstRun')>()),
  readSpacesFirstRun: () => ({ data: api.firstRunData }),
  startSpacesFirstRunVisit: api.wake,
}));

import { UPDATE_NOTE_MS, UPDATE_POLL_MS, readMetaAgentUpdate, resetMetaAgentUpdate, retryStoppedMetaAgent, runMetaAgentUpdate } from './metaAgentUpdate';

const row = (workspaceId: string, outcome: MetaAgentRunNowWorkspace['outcome'], extra: Partial<MetaAgentRunNowWorkspace> = {}): MetaAgentRunNowWorkspace => ({
  workspaceId, workspaceName: workspaceId, outcome, cursor: 1, unread: outcome === 'no_new' ? 0 : 2, ...extra,
});
const answer = (...workspaces: MetaAgentRunNowWorkspace[]): MetaAgentRunNowResponse => ({ workspaces });
const round = (running: Record<string, boolean>): MetaAgentRoundStatus => ({
  workspaces: Object.entries(running).map(([workspaceId, value]) => ({ workspaceId, cursor: 1, unread: 0, running: value })),
});
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of [api.roundNow, api.round, api.overview, api.resume, api.retryGuard, api.wake, api.changed]) fn.mockReset();
  api.overview.mockResolvedValue(null);
  api.info = { guard: { maintenance: null, chat: null } };
  api.firstRunData = null;
  resetMetaAgentUpdate();
});
afterEach(() => vi.useRealTimers());

describe('runMetaAgentUpdate', () => {
  it('says there is nothing new and clears the note after a while', async () => {
    api.roundNow.mockResolvedValue(answer(row('a', 'no_new'), row('b', 'no_new')));
    await act(async () => { await runMetaAgentUpdate('local'); });
    expect(api.roundNow).toHaveBeenCalledTimes(1);
    expect(api.roundNow).toHaveBeenCalledWith('local');
    expect(api.round).not.toHaveBeenCalled();
    expect(readMetaAgentUpdate().phase).toBe('no-new');
    expect(api.changed).toHaveBeenCalledWith({ backendConnectionId: 'local' });
    act(() => { vi.advanceTimersByTime(UPDATE_NOTE_MS); });
    expect(readMetaAgentUpdate().phase).toBe('idle');
  });

  it('asks the backend for one round and follows the workspaces it started until none is running', async () => {
    api.roundNow.mockResolvedValue(answer(row('a', 'started', { runId: 'r1' }), row('b', 'no_new'), row('c', 'started', { runId: null })));
    api.round
      .mockResolvedValueOnce(round({ a: false, b: false, c: true }))
      .mockResolvedValueOnce(round({ a: false, b: false, c: false }));
    let done = false;
    void runMetaAgentUpdate('remote-1').then(() => { done = true; });
    await flush();
    expect(api.roundNow).toHaveBeenCalledWith('remote-1');
    expect(readMetaAgentUpdate()).toMatchObject({ phase: 'running', workspaces: 2 });
    await act(async () => { vi.advanceTimersByTime(UPDATE_POLL_MS); });
    await flush();
    expect(done).toBe(false);
    await act(async () => { vi.advanceTimersByTime(UPDATE_POLL_MS); });
    await flush();
    expect(done).toBe(true);
    expect(api.round).toHaveBeenCalledWith('remote-1');
    expect(readMetaAgentUpdate().phase).toBe('idle');
    expect(api.changed).toHaveBeenCalledWith({ backendConnectionId: 'remote-1' });
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('reports why a round could not start', async () => {
    api.roundNow.mockResolvedValue(answer(row('a', 'skipped', { skip: 'guard_hold', reason: 'Meta agent restriction check failed on kiro: x' })));
    await act(async () => { await runMetaAgentUpdate('remote-1'); });
    expect(readMetaAgentUpdate()).toMatchObject({ phase: 'failed', error: 'Meta agent restriction check failed on kiro: x' });
  });

  it('reports a failed request', async () => {
    api.roundNow.mockRejectedValue(new Error('Scheduled jobs are off on this backend, so the Meta agent cannot run'));
    await act(async () => { await runMetaAgentUpdate('local'); });
    expect(readMetaAgentUpdate()).toMatchObject({ phase: 'failed', error: 'Scheduled jobs are off on this backend, so the Meta agent cannot run' });
  });

  it('only re-reads while every workspace is paused', async () => {
    api.roundNow.mockResolvedValue(answer(row('a', 'skipped', { skip: 'paused', reason: 'Maintenance is paused in this workspace' })));
    await act(async () => { await runMetaAgentUpdate('local'); });
    expect(readMetaAgentUpdate().phase).toBe('idle');
    expect(api.changed).toHaveBeenCalled();
  });

  it('retries a stored maintenance check failure on this computer instead of starting a round', async () => {
    api.info = { guard: { maintenance: { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['x'], checkedAt: 1 }, chat: null } };
    api.retryGuard.mockResolvedValue(undefined);
    await act(async () => { await runMetaAgentUpdate('local'); });
    expect(api.retryGuard).toHaveBeenCalledTimes(1);
    expect(api.roundNow).not.toHaveBeenCalled();
  });

  it('leaves this computer’s check alone on a remote connection', async () => {
    api.info = { guard: { maintenance: { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['x'], checkedAt: 1 }, chat: null } };
    api.roundNow.mockResolvedValue(answer(row('a', 'no_new')));
    await act(async () => { await runMetaAgentUpdate('remote-1'); });
    expect(api.retryGuard).not.toHaveBeenCalled();
    expect(api.roundNow).toHaveBeenCalledWith('remote-1');
    expect(readMetaAgentUpdate().phase).toBe('no-new');
  });

  it('wakes a first run in progress instead of starting incremental runs', async () => {
    api.firstRunData = { requestedAt: 1, haltedReason: null, summary: { state: 'waiting', summarizedAt: null },
      workspaces: [{ workspaceId: 'a', workspaceName: 'a', homePageId: null, hiddenAt: null, firstRun: { state: 'reading' } }] };
    api.wake.mockResolvedValue(undefined);
    await act(async () => { await runMetaAgentUpdate('local'); });
    expect(api.wake).toHaveBeenCalledWith('local');
    expect(api.roundNow).not.toHaveBeenCalled();
  });
});

describe('retryStoppedMetaAgent', () => {
  it('resumes this computer’s Meta agent, which restarts stopped workspaces, then runs one round', async () => {
    const order: string[] = [];
    api.resume.mockImplementation(async () => { order.push('resume'); });
    api.roundNow.mockImplementation(async () => { order.push('round'); return answer(row('a', 'no_new')); });
    await act(async () => { await retryStoppedMetaAgent('local'); });
    expect(order).toEqual(['resume', 'round']);
  });

  it('does not resume through this computer for a remote backend, and stops when resuming fails', async () => {
    api.roundNow.mockResolvedValue(answer(row('a', 'no_new')));
    await act(async () => { await retryStoppedMetaAgent('remote-1'); });
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.roundNow).toHaveBeenCalledWith('remote-1');

    api.roundNow.mockClear();
    api.resume.mockRejectedValue(new Error('Could not resume A'));
    await expect(retryStoppedMetaAgent('local')).rejects.toThrow('Could not resume A');
    expect(api.roundNow).not.toHaveBeenCalled();
  });
});
