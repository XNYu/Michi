import { describe, expect, it } from 'vitest';
import type { MetaAgentOverview, SpacesFirstRunStatus } from 'michi-shared';
import type { MetaAgentInfo } from '../../services/api/metaAgent';
import { metaAgentStatus, type MetaAgentStatusInput } from './metaAgentStatus';

const INFO: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const overview = (patch: Partial<MetaAgentOverview> = {}) => ({
  state: 'running', stopped: null, runtime: INFO.resolved, today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
  cursors: [], recentRuns: [], ...patch,
}) as MetaAgentOverview;
const firstRun = (patch: Partial<NonNullable<MetaAgentStatusInput['firstRun']>> = {}) => ({ data: null, unreachable: false, schedulerOff: false, justFinished: false, ...patch });
const reading: SpacesFirstRunStatus = {
  requestedAt: 1, summary: { state: 'waiting', summarizedAt: null }, haltedReason: null,
  workspaces: [{ workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: null, hiddenAt: null,
    firstRun: { workspaceId: 'ws-1', startedAt: 1, startSeq: 0, readCount: 2, total: 9, state: 'reading', error: null, updatedAt: 1 } }],
};
const SCHEDULER_OFF = { reason: 'scheduler-off' as const, message: 'Scheduled jobs are off on this backend' };
const kind = (input: MetaAgentStatusInput) => metaAgentStatus(input).kind;

describe('metaAgentStatus', () => {
  it('reads not running, with the reason, when scheduled jobs are off, from the overview or from the first-run start', () => {
    const fromOverview = metaAgentStatus({ info: INFO, overview: overview({ notRunning: SCHEDULER_OFF }), firstRun: firstRun() });
    expect(fromOverview).toMatchObject({ kind: 'not-running', reason: 'Scheduled jobs are off on this backend', settingsAlert: false });
    expect(metaAgentStatus({ info: INFO, overview: overview(), firstRun: firstRun({ schedulerOff: true }) }))
      .toMatchObject({ kind: 'not-running', reason: 'Scheduled jobs are off on this backend' });
    // Scheduled › Meta agent only has the overview, and still reads the same.
    expect(kind({ overview: overview({ notRunning: SCHEDULER_OFF }) })).toBe('not-running');
  });

  it('puts each state in one order: offline, a failed check, not running, unsupported, stopped, first run, paused, just read', () => {
    const stopped = { reason: 'signed-out' as const, message: 'Kiro is not signed in', workspaceIds: ['ws-1'] };
    const failedGuard = { ...INFO, guard: { maintenance: { state: 'failed' as const, runtimeId: 'kiro', toolset: 'maintenance' as const, unexpectedTools: ['fs_write'], checkedAt: 1 }, chat: null } };
    expect(kind({ info: failedGuard, overview: overview({ notRunning: SCHEDULER_OFF }), firstRun: firstRun({ unreachable: true }) })).toBe('offline');
    expect(kind({ info: failedGuard, overview: overview({ notRunning: SCHEDULER_OFF }), firstRun: firstRun() })).toBe('guard-failed');
    expect(kind({ info: { ...INFO, availability: { available: false, reason: 'no' } }, overview: overview({ notRunning: SCHEDULER_OFF }) })).toBe('not-running');
    expect(kind({ info: { ...INFO, availability: { available: false, reason: 'no' } }, overview: overview({ state: 'error', stopped }) })).toBe('unsupported');
    expect(kind({ info: INFO, overview: overview({ state: 'error', stopped }), firstRun: firstRun({ data: reading }) })).toBe('stopped');
    expect(kind({ info: INFO, overview: overview({ state: 'paused' }), firstRun: firstRun({ data: reading }) })).toBe('first-run');
    expect(kind({ info: INFO, overview: overview({ state: 'paused' }), firstRun: firstRun({ justFinished: true }) })).toBe('paused');
    expect(kind({ info: INFO, overview: overview(), firstRun: firstRun({ justFinished: true }) })).toBe('just-read');
    expect(kind({ info: INFO, overview: overview(), firstRun: firstRun() })).toBe('normal');
    expect(kind({ offline: true, info: INFO })).toBe('offline');
  });

  it('reads a Spaces Home summary after the first run as the ordinary state', () => {
    const later = (state: 'due' | 'running'): SpacesFirstRunStatus => ({
      ...reading, closed: true, summary: { state, summarizedAt: 5 },
      workspaces: reading.workspaces.map((item) => ({ ...item, firstRun: { ...item.firstRun!, state: 'done', readCount: 9 } })),
    });
    expect(kind({ info: INFO, overview: overview(), firstRun: firstRun({ data: later('due') }) })).toBe('normal');
    expect(kind({ info: INFO, overview: overview(), firstRun: firstRun({ data: later('running') }) })).toBe('normal');
    expect(kind({ info: INFO, overview: overview(), firstRun: firstRun({ data: { ...later('running'), closed: false } }) })).toBe('first-run');
  });

  it('reads an unsupported runtime from Settings’ answer or from the overview, with the reason and the Settings dot', () => {
    expect(metaAgentStatus({ info: { ...INFO, availability: { available: false, reason: 'The Meta agent does not run on Kiro Crew yet.' } } }))
      .toMatchObject({ kind: 'unsupported', reason: 'The Meta agent does not run on Kiro Crew yet.', settingsAlert: true });
    expect(metaAgentStatus({ overview: overview({ state: 'error', stopped: { reason: 'runtime-unsupported', message: 'Not on Crew', workspaceIds: [] } }) }))
      .toMatchObject({ kind: 'unsupported', reason: 'Not on Crew', stop: null, settingsAlert: true });
    expect(metaAgentStatus({ info: { ...INFO, availability: { available: false, reason: null } }, runtimeLabel: () => 'Kiro' }).reason)
      .toBe('The Meta agent cannot run on Kiro');
  });

  it('turns a held first run into a failed check on the runtime it ran on', () => {
    const status = metaAgentStatus({ info: INFO, firstRun: firstRun({ data: { ...reading, haltedReason: 'fs_write appeared' } }) });
    expect(status.kind).toBe('guard-failed');
    expect(status.guardFailures).toEqual([expect.objectContaining({ runtimeId: 'kiro', detail: 'fs_write appeared', toolset: 'maintenance' })]);
    expect(status.settingsAlert).toBe(true);
    // Before either read answers there is no runtime to name: still stopped, with a reason to show.
    const unnamed = metaAgentStatus({ firstRun: firstRun({ data: { ...reading, haltedReason: 'fs_write appeared' } }) });
    expect(unnamed).toMatchObject({ kind: 'guard-failed', guardFailures: [], stop: { reason: 'restriction-check' } });
  });

  it('says not running for a backend without a Meta agent, and stays ordinary while its answer is loading', () => {
    expect(metaAgentStatus({ infoStatus: 'unavailable' })).toMatchObject({ kind: 'not-running', reason: 'This Michi backend has no Meta agent yet' });
    expect(kind({ infoStatus: 'loading' })).toBe('normal');
  });

  it('keeps a stop an older backend reported only as an error', () => {
    expect(metaAgentStatus({ overview: overview({ state: 'error', error: 'Claude is not signed in', stopped: undefined }) }))
      .toMatchObject({ kind: 'stopped', reason: 'Claude is not signed in', stop: { reason: 'other', message: 'Claude is not signed in' } });
  });
});
