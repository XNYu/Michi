import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentOverview } from 'michi-shared';
import type { MetaAgentInfo } from '../../../../services/api/metaAgent';
import type { FirstRunSnapshot } from '../../../../state/metaAgent/spacesFirstRun';

const mocks = vi.hoisted(() => ({
  agent: { status: 'ready', info: null, error: null } as { status: string; info: MetaAgentInfo | null; error: string | null },
  overview: { status: 'ready', overview: null, error: null } as { status: string; overview: MetaAgentOverview | null; error: string | null },
  firstRun: null as unknown as FirstRunSnapshot,
}));
vi.mock('../../../../state/metaAgent/useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/useMetaAgent')>()),
  useMetaAgent: () => mocks.agent,
}));
vi.mock('../../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentOverview: () => mocks.overview }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => mocks.firstRun,
}));

import { MetaAgentSidebarStatus } from './MetaAgentSidebarStatus';

const INFO: MetaAgentInfo = {
  settings: { runtimeId: 'codex', providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'codex', providerId: null, modelId: null, reasoning: null, followsGlobal: false },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const overview = (patch: Partial<MetaAgentOverview>) => ({ state: 'running', cursors: [], recentRuns: [], ...patch }) as unknown as MetaAgentOverview;

beforeEach(() => {
  mocks.agent = { status: 'ready', info: INFO, error: null };
  mocks.overview = { status: 'ready', overview: overview({}), error: null };
  mocks.firstRun = { load: 'ready', data: null, error: null, unreachable: false, schedulerOff: false, justFinished: false };
});

const row = () => {
  const onOpenHome = vi.fn();
  const view = render(<div data-testid="row"><MetaAgentSidebarStatus onOpenHome={onOpenHome} /></div>);
  return { onOpenHome, text: () => screen.getByTestId('row').textContent, view };
};

describe('Spaces sidebar Meta agent row', () => {
  it('says the Meta agent stopped when errors stopped background maintenance, and leads to the Home', () => {
    mocks.overview = { status: 'ready', error: null, overview: overview({ state: 'error', error: 'Codex is not installed on this computer',
      stopped: { reason: 'runtime-missing', message: 'Codex is not installed on this computer', workspaceIds: ['ws-1'] } }) };
    const { onOpenHome, text } = row();
    expect(text()).toBe('Meta agent stopped · See why');
    expect(document.querySelector('.area-side__foot-dot')?.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(screen.getByRole('button', { name: 'See why' }));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
  });

  it('keeps paused apart from stopped, and the usual line while it runs', () => {
    mocks.overview = { status: 'ready', error: null, overview: overview({ state: 'paused', stopped: null }) };
    const paused = row();
    expect(paused.text()).toBe('Meta agent is paused');
    paused.view.unmount();
    mocks.overview = { status: 'ready', error: null, overview: overview({ state: 'running', stopped: null }) };
    expect(row().text()).toBe('Meta agent · Codex · checks new conversations every 60 s');
  });

  it('says not running where scheduled jobs are off, as the Home does, instead of the usual line', () => {
    mocks.firstRun = { ...mocks.firstRun, schedulerOff: true };
    const offByStart = row();
    expect(offByStart.text()).toBe('Meta agent is not running · See why');
    expect(screen.getByTitle('Scheduled jobs are off on this backend')).toBeTruthy();
    expect(document.querySelector('.area-side__foot-dot')?.getAttribute('data-tone')).toBe('warn');
    fireEvent.click(screen.getByRole('button', { name: 'See why' }));
    expect(offByStart.onOpenHome).toHaveBeenCalledTimes(1);
    offByStart.view.unmount();
    mocks.firstRun = { ...mocks.firstRun, schedulerOff: false };
    mocks.overview = { status: 'ready', error: null, overview: overview({ notRunning: { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' } }) };
    expect(row().text()).toBe('Meta agent is not running · See why');
  });

  it('says not running on a runtime the Meta agent cannot use, with the reason', () => {
    mocks.agent = { status: 'ready', error: null, info: { ...INFO, availability: { available: false, reason: 'The Meta agent does not run on Kiro Crew yet.' } } };
    expect(row().text()).toBe('Meta agent is not running · See why');
    expect(screen.getByTitle('The Meta agent does not run on Kiro Crew yet.')).toBeTruthy();
  });
});
