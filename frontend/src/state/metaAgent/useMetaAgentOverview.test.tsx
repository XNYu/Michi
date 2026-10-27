import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentOverview } from 'michi-shared';

const api = vi.hoisted(() => ({ overview: vi.fn(), guardFailed: false, schedulerOff: false }));
vi.mock('../../services/api/metaAgentOverview', () => ({ fetchMetaAgentOverview: () => api.overview(), setMetaAgentPaused: vi.fn() }));
vi.mock('./useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useMetaAgent')>()),
  useMetaAgentGuardFailed: () => api.guardFailed,
  useMetaAgentSnapshot: () => ({ status: 'ready', error: null, info: {
    settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
    resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    availability: { available: true, reason: null },
    guard: { maintenance: api.guardFailed ? { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['fs_write'], checkedAt: 1 } : null, chat: null },
  } }),
}));
vi.mock('./spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: null, error: null, unreachable: false, schedulerOff: api.schedulerOff, justFinished: false }),
}));

import { resetMetaAgentOverviewStore, useMetaAgentSettingsAlert } from './useMetaAgentOverview';

const overview = (patch: Partial<MetaAgentOverview>) => ({ state: 'running', cursors: [], recentRuns: [], stopped: null, ...patch }) as unknown as MetaAgentOverview;

function Probe() { return <span data-testid="alert">{String(useMetaAgentSettingsAlert())}</span>; }

async function alertFor(value: MetaAgentOverview, guardFailed = false): Promise<string | null> {
  api.overview.mockResolvedValue(value);
  api.guardFailed = guardFailed;
  const view = render(<Probe />);
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  const text = screen.getByTestId('alert').textContent;
  view.unmount();
  return text;
}

beforeEach(() => { resetMetaAgentOverviewStore(); api.overview.mockReset(); });
afterEach(() => { document.body.innerHTML = ''; });

describe('useMetaAgentSettingsAlert (the rail Settings dot)', () => {
  it('lights for a stopped Meta agent and for a failed restriction check, not while it runs or is paused', async () => {
    expect(await alertFor(overview({ state: 'error', stopped: { reason: 'signed-out', message: 'Kiro is not signed in', workspaceIds: [] } }))).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running' }), true)).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'paused' }))).toBe('false');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running' }))).toBe('false');
  });

  it('lights for a runtime the Meta agent cannot run on, not when scheduled jobs are off, which Settings cannot change', async () => {
    expect(await alertFor(overview({ state: 'error', stopped: { reason: 'runtime-unsupported', message: 'The Meta agent does not run on Kiro Crew yet.', workspaceIds: [] } }))).toBe('true');
    resetMetaAgentOverviewStore();
    expect(await alertFor(overview({ state: 'running', notRunning: { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' } }))).toBe('false');
    resetMetaAgentOverviewStore();
    api.schedulerOff = true;
    expect(await alertFor(overview({ state: 'running' }))).toBe('false');
    api.schedulerOff = false;
  });
});
