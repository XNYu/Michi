import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunProgressDto, MetaAgentCursorRow, MetaAgentRecentRun, MetaAgentStop, WorkspaceHomeSummaryDto } from 'michi-shared';
import type { SpacesFirstRunStatus } from '../../../../services/api/spacesHome';

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { DEFAULT_META_STATUS, MetaAgentStatusLine, workspaceDetailText } from './MetaAgentStatusLine';

const NOW = new Date(2026, 9, 23, 10, 45).getTime();
const MIN = 60_000;

const cursor = (patch: Partial<MetaAgentCursorRow> = {}): MetaAgentCursorRow => ({
  workspaceId: 'ws-1', workspaceName: 'rabbitholes', cursor: 1289, unread: 0, lastRunAt: NOW - 12 * MIN, state: 'synced', ...patch,
});
const read = (patch: Partial<MetaAgentRecentRun> = {}): MetaAgentRecentRun => ({
  at: NOW - 12 * MIN, since: NOW - 12 * MIN, workspaceId: 'ws-1', workspaceName: 'rabbitholes', workspaceCount: 1, after: 1287, through: 1289,
  turns: 2, routedPages: 1, routedPageTitles: ['Michi 0.9 发布'], writes: 2, proposals: 1, cursorTo: 1289, noModelCall: false,
  kind: 'incremental', count: 1, state: 'done', ...patch,
});
const firstRun = (state: FirstRunProgressDto['state'], total: number, patch: Partial<FirstRunProgressDto> = {}): FirstRunProgressDto => ({
  workspaceId: 'ws-1', startedAt: 1, startSeq: 1289, readCount: state === 'done' ? total : 0, total, state, error: null, updatedAt: 2, ...patch,
});
const home = (run: FirstRunProgressDto | null): WorkspaceHomeSummaryDto => ({
  workspaceId: 'ws-1', workspaceName: 'rabbitholes', homePageId: 'home-1', hiddenAt: null, firstRun: run,
});
const STOP: MetaAgentStop = { reason: 'signed-out', message: 'Kiro is not signed in', workspaceIds: ['ws-1'] };
const stopped = (reason: MetaAgentStop['reason'], message: string): MetaAgentCursorRow['problem'] => ({ reason, message, stopped: true });

afterEach(() => { document.body.innerHTML = ''; toast.error.mockReset(); });

/** Words a person should not have to know: API and column names, cursor numbers. */
const DEVELOPER_TERMS = /completion_seq|list_threads|read_node|read_conversation_updates|incremental from|read through #|#\d/;

describe('Meta agent detail rows in words', () => {
  it('says where each workspace stands without the cursor number', () => {
    expect(workspaceDetailText(null, cursor(), read(), NOW)).toBe('Up to date · read 12m ago · last run: 2 changes, 1 suggestion');
    expect(workspaceDetailText(null, cursor({ state: 'next', unread: 2 }), read({ noModelCall: true }), NOW))
      .toBe('2 new conversations to read next round · read 12m ago · last check found nothing new');
    expect(workspaceDetailText(null, cursor({ state: 'next', unread: 1, lastRunAt: null }), undefined, NOW)).toBe('1 new conversation to read next round');
    expect(workspaceDetailText(null, cursor({ state: 'no-new', lastRunAt: null }), undefined, NOW)).toBe('No new conversations yet');
    expect(workspaceDetailText(null, cursor(), read({ state: 'running' }), NOW)).toBe('Up to date · read 12m ago · reading now');
    expect(workspaceDetailText(null, undefined, undefined, NOW)).toBe('Not read yet');
  });

  it('says a workspace stopped, or that its last try failed and it tries again, in plain words', () => {
    const error = { state: 'error' as const, error: 'kiro-cli not found (looked for /x)' };
    expect(workspaceDetailText(null, cursor({ ...error, problem: stopped('runtime-missing', 'Kiro is not installed on this computer') }), read({ state: 'failed', error: 'kiro-cli not found' }), NOW))
      .toBe('Stopped: Kiro is not installed on this computer');
    expect(workspaceDetailText(firstRun('done', 38), cursor({ ...error, problem: { reason: 'quota', message: 'Kiro reached its usage or rate limit', stopped: false } }), undefined, NOW))
      .toBe('Last try failed: Kiro reached its usage or rate limit · retrying');
  });

  it('reads a finished first run as written, and where reading new conversations picks up', () => {
    expect(workspaceDetailText(firstRun('done', 38, { startSeq: 1289 }), cursor({ cursor: 1289 }), undefined, NOW)).toBe('History 38 · home written · continues from #1289');
    expect(workspaceDetailText(firstRun('done', 0, { startSeq: 0 }), cursor({ cursor: 0 }), undefined, NOW)).toBe('No conversations in the last 30 days · home written · continues with new conversations');
    expect(workspaceDetailText(firstRun('done', 0, { startSeq: 0 }), cursor({ cursor: 0 }), undefined, NOW, 7)).toBe('No conversations in the last 7 days · home written · continues with new conversations');
  });

  it('explains the first read in plain words', () => {
    const status: SpacesFirstRunStatus = { requestedAt: 1, workspaces: [home(firstRun('reading', 21))], summary: { state: 'waiting', summarizedAt: null }, haltedReason: null };
    render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={status.workspaces} clock={NOW} mode="first-run" firstRun={status} />);
    const list = screen.getByRole('list', { name: 'Meta agent per workspace' });
    expect(within(list).getByText('First time: it reads your past conversations once. After that it only reads conversations that finish.')).toBeTruthy();
    expect(list.textContent).not.toMatch(DEVELOPER_TERMS);
  });

  it('keeps the steady-state detail list free of developer terms', () => {
    const cursors = [cursor(), cursor({ workspaceId: 'ws-2', workspaceName: 'agent-desk', state: 'next', unread: 2 })];
    const workspaces = [home(null), { ...home(null), workspaceId: 'ws-2', workspaceName: 'agent-desk' }];
    render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={workspaces} clock={NOW} cursors={cursors} recentRuns={[read()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('list', { name: 'Meta agent per workspace' }).textContent).not.toMatch(DEVELOPER_TERMS);
  });
});

describe('Meta agent status line states', () => {
  it('can leave the latest write to a page header without hiding maintenance status or actions', () => {
    const status = { ...DEFAULT_META_STATUS, lastWrite: { workspaceName: 'rabbitholes', at: NOW - 12 * MIN }, runtimeLabel: 'Claude', followsGlobal: true };
    const view = render(<MetaAgentStatusLine status={status} workspaces={[]} clock={NOW} />);
    expect(screen.getByText(/wrote rabbitholes 12m ago/)).toBeTruthy();
    view.rerender(<MetaAgentStatusLine status={status} workspaces={[]} clock={NOW} showLastWrite={false} />);
    expect(screen.queryByText(/wrote rabbitholes/)).toBeNull();
    expect(screen.getByText(/Meta agent checks new conversations every 60 s · Claude \(follows global\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scheduled' })).toBeTruthy();
  });

  it('stopped: names the reason, retries, and offers another runtime only when that helps', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onOpenSettings = vi.fn();
    const view = render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={[]} clock={NOW} mode="stopped" stop={STOP} onRetry={onRetry} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText('Meta agent stopped: Kiro is not signed in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change runtime' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.unmount();

    render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={[]} clock={NOW} mode="stopped" onRetry={onRetry} onOpenSettings={onOpenSettings}
      stop={{ reason: 'other', message: 'The model returned an empty answer', workspaceIds: [] }} />);
    expect(screen.getByText('Meta agent stopped: The model returned an empty answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change runtime' })).toBeNull();
  });

  it('stopped: a failed retry says so', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('Could not resume A: changed'));
    render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={[]} clock={NOW} mode="stopped" stop={STOP} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t retry: Could not resume A: changed'));
  });

  it('running: a failure it is still retrying shows beside the usual line', () => {
    const cursors = [cursor({ state: 'error', problem: { reason: 'quota', message: 'Claude reached its usage or rate limit', stopped: false } })];
    render(<MetaAgentStatusLine status={{ ...DEFAULT_META_STATUS, runtimeLabel: 'Claude', followsGlobal: true }} workspaces={[]} clock={NOW} cursors={cursors} />);
    expect(document.querySelector('.spaces-home-status__text')?.textContent)
      .toBe('Meta agent checks new conversations every 60 s · Claude (follows global)·Details·Scheduled·Claude reached its usage or rate limit · retrying');
  });

  it('paused: says so and resumes, apart from the stopped state', () => {
    const onResume = vi.fn();
    render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={[]} clock={NOW} mode="paused" stop={STOP} onResume={onResume} />);
    expect(screen.getByText('Meta agent is paused')).toBeTruthy();
    expect(screen.queryByText(/stopped/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('first run: reads the range Settings chose until the queued range is known', () => {
    const status: SpacesFirstRunStatus = { requestedAt: 1, workspaces: [home(firstRun('reading', 21))], summary: { state: 'waiting', summarizedAt: null }, haltedReason: null };
    const line = (props: Partial<React.ComponentProps<typeof MetaAgentStatusLine>>) => {
      const view = render(<MetaAgentStatusLine status={DEFAULT_META_STATUS} workspaces={status.workspaces} clock={NOW} mode="first-run" firstRun={status} {...props} />);
      const text = document.querySelector('.spaces-home-status__text')?.textContent;
      view.unmount();
      return text;
    };
    expect(line({})).toContain('reading the last 30 days');
    expect(line({ firstRunDays: 7 })).toContain('reading the last 7 days');
    expect(line({ firstRunDays: 7, recentRuns: [read({ kind: 'first-run', firstRunDays: 90 })] })).toContain('reading the last 90 days');
  });
});
