import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentOverview } from 'michi-shared';
import { HttpResponseError } from '../../../../services/api/httpError';
import { requestScheduledJobDetail } from '../scheduledNav';
import MetaAgentScheduledPage, { MetaAgentDetail } from './MetaAgentDetail';
import { closeMetaAgentDetail, openMetaAgentDetail, useMetaAgentDetailOpen } from './metaAgentNav';
import { resetMetaAgentOverviewStore } from './useMetaAgentOverview';

const api = vi.hoisted(() => ({ fetch: vi.fn(), setPaused: vi.fn() }));
vi.mock('../../../../services/api/metaAgentOverview', () => ({
  fetchMetaAgentOverview: (...args: unknown[]) => api.fetch(...args),
  setMetaAgentPaused: (...args: unknown[]) => api.setPaused(...args),
}));
const jobs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: jobs.list, loading: false, unavailable: false }) }));
const chat = vi.hoisted(() => ({ reveal: vi.fn() }));
vi.mock('../../../../state/chatStore', () => ({ useChatProjects: () => ({ projects: [] }), useChatActions: () => ({ revealBackendNode: chat.reveal }) }));
const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toasts.error } }));
const round = vi.hoisted(() => ({ run: vi.fn(), refreshInfo: vi.fn() }));
vi.mock('../../../../state/metaAgent/metaAgentUpdate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/metaAgentUpdate')>()),
  runMetaAgentUpdate: (...args: unknown[]) => round.run(...args),
}));
vi.mock('../../../../state/metaAgent/useMetaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/useMetaAgent')>()),
  refreshMetaAgent: () => round.refreshInfo(),
  useMetaAgent: () => ({ status: 'ready', info: null, error: null }),
}));

const NOW = new Date(2026, 9, 23, 10, 45).getTime();
const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).getTime();

function overview(patch: Partial<MetaAgentOverview> = {}): MetaAgentOverview {
  const run = { since: 0, workspaceId: null, workspaceName: null, workspaceCount: 1, after: null, through: null, turns: 0,
    routedPages: 0, routedPageTitles: [], writes: 0, proposals: 0, cursorTo: null, noModelCall: true, kind: 'incremental' as const,
    count: 1, state: 'done' as const };
  return {
    state: 'running',
    runtime: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
    today: { checks: 342, checksTruncated: false, modelCalls: 9, writes: 14, pendingProposals: 3 },
    cursors: [
      { workspaceId: 'r', workspaceName: 'rabbitholes', cursor: 1289, unread: 0, lastRunAt: at(23, 10, 42), state: 'synced' },
      { workspaceId: 'd', workspaceName: 'agent-desk', cursor: 4012, unread: 2, lastRunAt: at(23, 10, 41), state: 'next' },
      { workspaceId: 'n', workspaceName: 'sample-dashboard', cursor: 233, unread: 0, lastRunAt: at(9, 17, 20), state: 'no-new' },
      { workspaceId: 'b', workspaceName: 'sample-notes', cursor: 518, unread: 0, lastRunAt: at(17, 9, 0), state: 'synced' },
      { workspaceId: 'p', workspaceName: '个人', cursor: 41, unread: 0, lastRunAt: at(22, 20, 0), state: 'error', error: 'Claude is not signed in' },
    ],
    recentRuns: [
      { ...run, at: at(23, 10, 42), since: at(23, 10, 42), workspaceId: 'r', workspaceName: 'rabbitholes', after: 1287, through: 1289,
        turns: 2, routedPages: 2, routedPageTitles: ['Michi 0.9 发布', 'rabbitholes 首页'], writes: 2, proposals: 1, cursorTo: 1289, noModelCall: false },
      { ...run, at: at(23, 10, 41), since: at(23, 10, 41), workspaceCount: 5, count: 5 },
      { ...run, at: at(23, 9, 59), since: at(23, 9, 30), workspaceCount: 2, count: 60 },
      { ...run, at: at(23, 9, 30), since: at(23, 9, 30), kind: 'first-run', turns: 194, workspaceCount: 5, noModelCall: false },
      { ...run, at: at(22, 23, 5), since: at(22, 23, 5), workspaceId: 'p', workspaceName: '个人', state: 'failed', error: 'Claude is not signed in', count: 3 },
    ],
    ...patch,
  };
}

function detail(value: MetaAgentOverview, props: Partial<React.ComponentProps<typeof MetaAgentDetail>> = {}) {
  const handlers = { onTogglePause: vi.fn(), onOpenSettings: vi.fn() };
  render(<MetaAgentDetail overview={value} now={NOW} busy={false} {...handlers} {...props} />);
  return handlers;
}

beforeEach(() => {
  api.fetch.mockReset(); api.setPaused.mockReset(); jobs.list = [];
  api.fetch.mockResolvedValue(overview());
  resetMetaAgentOverviewStore();
});
afterEach(() => { act(() => closeMetaAgentDetail()); });

describe('Scheduled › Meta agent detail', () => {
  it('shows the status, explanation, runtime, restriction and today', () => {
    detail(overview());
    expect(screen.getByRole('heading', { level: 1, name: 'Meta agent · Maintain Pages' })).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Every 60 seconds it checks each workspace for new conversations. When there’s nothing new, it doesn’t use the AI.')).toBeTruthy();
    expect(screen.getByText(/Claude · claude-opus-5\.5 · reasoning high \(follows global\)/)).toBeTruthy();
    expect(screen.getByText('Limits: Claude’s own tools are off, and Michi checks every tool call')).toBeTruthy();
    expect(screen.getByText('342')).toBeTruthy();
    expect(screen.getByText('333 with nothing new')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
    expect(screen.getByText('3 suggestions for you')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bcursor\b|model call|\bruntime\b|no session/i);
  });

  it('lists each workspace cursor with its unread count, last read and state', () => {
    detail(overview());
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) =>
      within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['rabbitholes', '#1289', '0', '10:42', 'Up to date'],
      ['agent-desk', '#4012', '2', '10:41', 'Next round'],
      ['sample-dashboard', '#233', '0', 'Oct 9', 'No new conversations'],
      ['sample-notes', '#518', '0', '6 days ago', 'Up to date'],
      ['个人', '#41', '0', 'Yesterday', 'Error'],
    ]);
    expect(screen.getByText('Error').getAttribute('title')).toBe('Claude is not signed in');
  });

  it('lists recent runs: a read with its range, merged quiet checks, the first run and a failure', () => {
    detail(overview());
    const items = within(screen.getByRole('list')).getAllByRole('listitem').map((item) => item.textContent);
    expect(items[0]).toBe('rabbitholes · 2 new conversations10:42read turns #1288–#1289 → for Michi 0.9 发布, rabbitholes 首页 → 2 changes, 1 suggestion → now read up to #1289');
    expect(items[1]).toBe('No new conversations in 5 workspaces10:41Nothing new, so no AI was used.');
    expect(items[2]).toBe('No new conversations in 2 workspaces09:30–09:59Nothing new, so no AI was used. 60 checks in all.');
    expect(items[3]).toMatch(/^First read09:30Read 194 past conversations \(last 30 days, up to 1,000\) once → wrote 5 workspace homes\. Conversations that finished meanwhile are read in the next round\.$/);
    expect(items[4]).toBe('个人 could not runyesterday 23:05Claude is not signed in · 3 times');
  });

  it('lists a Spaces Home summary as its own row: which homes changed and what it rewrote, in plain words', () => {
    const summary = { ...overview().recentRuns[0], kind: 'summary' as const, workspaceId: null, workspaceName: null, after: null, through: null, turns: 0,
      routedPages: 0, routedPageTitles: [], proposals: 0, cursorTo: null, noModelCall: false, nodeId: null };
    const value = overview({ recentRuns: [
      { ...summary, at: at(23, 10, 12), since: at(23, 10, 12), workspaceCount: 2, writes: 2, changedHomes: ['rabbitholes', 'agent-desk'], rewroteBlocks: ['本周重点', '各 workspace'] },
      { ...summary, at: at(23, 10, 20), since: at(23, 10, 20), state: 'running', workspaceCount: 1, writes: 0, changedHomes: ['sample-notes'], rewroteBlocks: [] },
      { ...summary, at: at(23, 10, 25), since: at(23, 10, 25), state: 'failed', error: 'Kiro reached its usage or rate limit', workspaceCount: 0, writes: 0, changedHomes: [], rewroteBlocks: [] },
    ] });
    detail(value, { onOpenRun: vi.fn() });
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Home (all workspaces) · 2 workspace homes changed10:12New in rabbitholes and agent-desk → rewrote “本周重点”, “各 workspace”. It reads pages, not conversations.',
      'Home (all workspaces) · updating10:20New in sample-notes → reading the workspace homes… It reads pages, not conversations.',
      'Home (all workspaces) · failed10:25Failed: Kiro reached its usage or rate limit',
    ]);
    expect(items.map((item) => item.getAttribute('data-tone'))).toEqual(['summary', 'summary', 'error']);
    expect(within(screen.getByRole('list')).queryAllByRole('button')).toHaveLength(0);
  });

  it('opens a run’s conversation from its row; merged checks and the first read stay plain', () => {
    const onOpenRun = vi.fn();
    const value = overview();
    value.recentRuns[0] = { ...value.recentRuns[0], nodeId: 'n-maint' };
    value.recentRuns[1] = { ...value.recentRuns[1], nodeId: null };
    detail(value, { onOpenRun });
    const buttons = within(screen.getByRole('list')).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['rabbitholes · 2 new conversations, 10:42, open its conversation']);
    fireEvent.click(buttons[0]);
    expect(onOpenRun).toHaveBeenCalledWith({ workspaceId: 'r', nodeId: 'n-maint' });
  });

  it('opens Settings › Meta agent from Change, and pauses or resumes', () => {
    const handlers = detail(overview());
    fireEvent.click(screen.getByRole('button', { name: 'Change the Meta agent’s AI service' }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause background updates' }));
    expect(handlers.onTogglePause).toHaveBeenCalledWith(true);
  });

  it('shows a paused state with a resume button', () => {
    const handlers = detail(overview({ state: 'paused' }));
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('Background updates are paused: new conversations aren’t read and pages aren’t updated. The chat window in Pages still works.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume background updates' }));
    expect(handlers.onTogglePause).toHaveBeenCalledWith(false);
  });

  it('shows why the Meta agent stopped, with a link to its settings', () => {
    const handlers = detail(overview({
      state: 'error', error: 'The Meta agent does not run on Kiro Crew yet.',
      runtime: { runtimeId: 'crew', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Meta agent stopped: The Meta agent does not run on Kiro Crew yet.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Settings › Meta agent' }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Error', { selector: '.meta-sched__tag' })).toBeTruthy();
    expect(screen.getByText(/Crew · default model \(follows global\)/)).toBeTruthy();
    expect(screen.getByText('Limits: the Meta agent can’t use Kiro Crew yet')).toBeTruthy();
  });

  it('shows Error with the reason a job stopped, the error’s first line, and Retry', () => {
    const onRetry = vi.fn();
    const cursors = overview().cursors.map((row) => row.workspaceId === 'p'
      ? { ...row, error: 'codex binary not found. Paused after 5 failed runs in a row.', problem: { reason: 'runtime-missing' as const, message: 'Codex is not installed on this computer', stopped: true } }
      : row.workspaceId === 'b' ? { ...row, state: 'error' as const, error: 'Claude AI usage limit reached', problem: { reason: 'quota' as const, message: 'Claude reached its usage or rate limit', stopped: false } } : row);
    detail(overview({
      state: 'error', error: 'Codex is not installed on this computer', cursors,
      stopped: { reason: 'runtime-missing', message: 'Codex is not installed on this computer', detail: 'codex binary not found', workspaceIds: ['p'] },
    }), { onRetry });
    expect(screen.getByText('Error', { selector: '.meta-sched__tag' })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Meta agent stopped: Codex is not installed on this computer · Retry · Open Settings › Meta agentcodex binary not found');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const states = within(screen.getByRole('table')).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[4]);
    expect(states.map((cell) => cell.textContent)).toEqual(['Up to date', 'Next round', 'No new conversations', 'Retrying', 'Stopped']);
    expect(states[4].getAttribute('title')).toBe('codex binary not found. Paused after 5 failed runs in a row.');
  });

  it('offers no Retry when only another runtime can fix it, and names no function or column', () => {
    detail(overview({
      state: 'error', error: 'The Meta agent does not run on Kiro Crew yet.',
      stopped: { reason: 'runtime-unsupported', message: 'The Meta agent does not run on Kiro Crew yet.', workspaceIds: [] },
    }), { onRetry: vi.fn() });
    expect(within(screen.getByRole('alert')).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/completion_seq|list_threads|read_node|read_conversation_updates/);
  });

  it('says not running, without Retry, where the runtime is unsupported, and why Settings can fix it', () => {
    const handlers = detail(overview({
      state: 'error', error: 'The Meta agent does not run on Kiro Crew yet.',
      stopped: { reason: 'runtime-unsupported', message: 'The Meta agent does not run on Kiro Crew yet.', workspaceIds: [] },
    }), { onRetry: vi.fn() });
    expect(screen.getByText('Not running', { selector: '.meta-sched__tag' })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Meta agent is not running: The Meta agent does not run on Kiro Crew yet. · Open Settings › Meta agent');
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Settings › Meta agent' }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('says not running where scheduled jobs are off, as the Spaces sidebar and Home do', () => {
    detail(overview({ notRunning: { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' } }));
    expect(screen.getByText('Not running', { selector: '.meta-sched__tag' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Meta agent is not running: Scheduled jobs are off on this backend');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByRole('button', { name: /background updates/ })).toBeNull();
  });

  it('says when history was pruned and when nothing is maintained yet', () => {
    detail(overview({ today: { checks: 250, checksTruncated: true, modelCalls: 0, writes: 0, pendingProposals: 0 }, cursors: [], recentRuns: [] }));
    expect(screen.getByText('or more (older runs were pruned)')).toBeTruthy();
    expect(screen.getByText('no suggestions for you')).toBeTruthy();
    expect(screen.getByText('No workspace has background updates turned on yet.')).toBeTruthy();
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });
});

describe('Scheduled › Meta agent page', () => {
  it('loads the overview, then pauses through the API', async () => {
    api.fetch.mockResolvedValue(overview());
    api.setPaused.mockResolvedValue(overview({ state: 'paused' }));
    render(<MetaAgentScheduledPage onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading the Meta agent’s status' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause background updates' }));
    expect(api.setPaused).toHaveBeenCalledWith(true);
    expect(await screen.findByText('Paused')).toBeTruthy();
  });

  it('retries a stopped Meta agent: resumes, then runs one round, then reads the overview again', async () => {
    const stoppedOverview = overview({ state: 'error', error: 'Kiro is not signed in',
      stopped: { reason: 'signed-out', message: 'Kiro is not signed in', workspaceIds: ['p'] } });
    api.fetch.mockResolvedValueOnce(stoppedOverview).mockResolvedValue(overview());
    api.setPaused.mockResolvedValue(overview());
    round.run.mockReset().mockResolvedValue(undefined);
    round.refreshInfo.mockReset().mockResolvedValue(undefined);
    render(<MetaAgentScheduledPage onOpenSettings={vi.fn()} />);
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(round.run).toHaveBeenCalledWith('local'));
    expect(api.setPaused).toHaveBeenCalledWith(false);
    expect(round.refreshInfo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
  });

  it('reveals a run’s maintenance conversation, and says so when it is gone', async () => {
    const value = overview();
    value.recentRuns[0] = { ...value.recentRuns[0], nodeId: 'n-maint' };
    api.fetch.mockResolvedValue(value);
    chat.reveal.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    toasts.error.mockReset();
    render(<MetaAgentScheduledPage onOpenSettings={vi.fn()} />);
    const row = await screen.findByRole('button', { name: /open its conversation$/ });
    fireEvent.click(row);
    await waitFor(() => expect(chat.reveal).toHaveBeenCalledWith('r', 'n-maint'));
    expect(toasts.error).not.toHaveBeenCalled();
    fireEvent.click(row);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('That conversation is no longer available'));
  });

  it('shows a quiet notice when the backend has no overview route', async () => {
    api.fetch.mockRejectedValue(new HttpResponseError('Not found', 404));
    render(<MetaAgentScheduledPage onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('This Michi backend does not report the Meta agent’s maintenance yet.')).toBeTruthy();
  });

  it('offers a retry when the overview cannot be read', async () => {
    api.fetch.mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(overview());
    render(<MetaAgentScheduledPage onOpenSettings={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('connection refused');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
  });
});

describe('Meta agent row in the Scheduled sidebar', () => {
  function Probe() { return <span data-testid="open">{String(useMetaAgentDetailOpen())}</span>; }
  const job = (id: string, name: string) => ({ id, name, workspaceId: 'r', schedule: { kind: 'every', everySeconds: 3600 }, activeRunId: null });

  async function sidebar(props: { selectedJobId?: string | null; onSelectJob?: (id: string) => void } = {}) {
    const { ScheduledSidebar } = await import('../../rail/AreaSidebars');
    const onSelectJob = props.onSelectJob ?? vi.fn();
    const view = render(<><ScheduledSidebar selectedJobId={props.selectedJobId ?? null} onSelectJob={onSelectJob} /><Probe /></>);
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
    return { ...view, onSelectJob };
  }

  it('opens the detail page and is marked current; opening another job closes it', async () => {
    await sidebar();
    const row = screen.getByRole('button', { name: /Meta agent · maintain Pages/ });
    expect(row.getAttribute('aria-current')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByTestId('open').textContent).toBe('true');
    expect(row.getAttribute('aria-current')).toBe('true');
    act(() => requestScheduledJobDetail('job-1'));
    expect(screen.getByTestId('open').textContent).toBe('false');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByTestId('open').textContent).toBe('true');
    act(() => openMetaAgentDetail());
    expect(screen.getByTestId('open').textContent).toBe('true');
  });

  it('lists the managed maintenance jobs only as the system row, with a sub-line from the overview', async () => {
    jobs.list = [job('job-m1', 'Space maintenance'), job('job-daily', 'Daily summary'), job('job-m2', 'Space maintenance')];
    api.fetch.mockResolvedValue(overview({ managedJobIds: ['job-m1', 'job-m2'] }));
    await sidebar();
    const rows = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(rows).toEqual(['Meta agent · maintain Pages System', 'Daily summary']);
    expect(screen.getByText('Running · 1 needs reading')).toBeTruthy();
  });

  it.each([
    [{ state: 'paused' as const }, 'Paused'],
    [{ state: 'error' as const, error: 'Claude is not signed in' }, 'Error'],
    [{ cursors: overview().cursors.filter((cursor) => cursor.state !== 'next') }, 'Running · 4 workspaces'],
    [{ cursors: [] }, 'Running · no workspace yet'],
    [{ notRunning: { reason: 'scheduler-off' as const, message: 'Scheduled jobs are off on this backend' } }, 'Not running'],
    [{ state: 'error' as const, stopped: { reason: 'runtime-unsupported' as const, message: 'Not on Crew', workspaceIds: [] } }, 'Not running'],
  ])('says %o as “%s”', async (patch, text) => {
    api.fetch.mockResolvedValue(overview(patch));
    await sidebar();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('says when the backend reports no Meta agent', async () => {
    api.fetch.mockRejectedValue(new HttpResponseError('Not found', 404));
    await sidebar();
    expect(screen.getByText('Not set up yet')).toBeTruthy();
  });

  it('does not highlight the last job while the Meta agent page is open, and keeps the page when Scheduled is restored', async () => {
    jobs.list = [job('job-daily', 'Daily summary'), job('job-weekly', 'Weekly report')];
    const { onSelectJob } = await sidebar({ selectedJobId: 'job-daily' });
    const daily = screen.getByRole('button', { name: 'Daily summary' });
    expect(daily.getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Meta agent · maintain Pages/ }));
    expect(daily.getAttribute('aria-current')).toBeNull();

    // Coming back to Scheduled, the shell asks for the job it remembers.
    act(() => requestScheduledJobDetail('job-daily'));
    expect(screen.getByTestId('open').textContent).toBe('true');

    fireEvent.click(daily);
    expect(screen.getByTestId('open').textContent).toBe('false');
    expect(onSelectJob).toHaveBeenCalledWith('job-daily');
    expect(daily.getAttribute('aria-current')).toBe('true');
  });
});

describe('Shared overview', () => {
  it('updates the sidebar row at once when the page pauses maintenance', async () => {
    const { ScheduledSidebar } = await import('../../rail/AreaSidebars');
    api.fetch.mockResolvedValue(overview());
    api.setPaused.mockResolvedValue(overview({ state: 'paused' }));
    render(<><ScheduledSidebar selectedJobId={null} onSelectJob={vi.fn()} /><MetaAgentScheduledPage onOpenSettings={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause background updates' }));
    await waitFor(() => expect(screen.getAllByText('Paused').length).toBeGreaterThan(0));
    expect(screen.getByText('Paused', { selector: '.area-side__sub' })).toBeTruthy();
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });
});
