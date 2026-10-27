import React from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  META_AGENT_DEFAULT_FIRST_RUN_DAYS,
  type FirstRunProgressDto, type MetaAgentCursorRow, type MetaAgentRecentRun, type MetaAgentStop, type WorkspaceHomeSummaryDto,
} from 'michi-shared';
import type { SpacesFirstRunStatus } from '../../../../services/api/spacesHome';
import type { MetaAgentUpdateState } from '../../../../state/metaAgent/metaAgentUpdate';
import { firstRunProgress } from '../../../../state/metaAgent/spacesFirstRun';
import { META_AGENT_HEADLINE } from '../../../../state/metaAgent/metaAgentStatus';
import { homeAge } from './homeFormat';
import './metaAgentStatus.css';

/** What the status line says about the Meta agent in its ordinary state. */
export interface MetaAgentHomeStatus {
  /** How often background maintenance looks for new conversations. */
  intervalSeconds: number;
  /** The last workspace home it wrote, and when. */
  lastWrite?: { workspaceName: string; at: number } | null;
  /** e.g. `Claude`. */
  runtimeLabel?: string | null;
  followsGlobal?: boolean;
}

export const DEFAULT_META_STATUS: MetaAgentHomeStatus = { intervalSeconds: 60 };

/**
 * `offline`: the backend did not answer; `not-running`: nothing can run on
 * that backend (with `reason`); `unavailable`: the Meta agent cannot run on
 * its runtime (with `reason`, and a way to Settings); `stopped`: errors
 * stopped background maintenance (with `stop`); `paused`: the user paused it;
 * `first-run`: the first read of the history is in progress; `just-read`: it
 * ended while this window watched. The Spaces Home takes the mode from
 * state/metaAgent/metaAgentStatus.ts, like every other Meta agent status.
 */
export type MetaAgentLineMode = 'normal' | 'just-read' | 'first-run' | 'paused' | 'stopped' | 'not-running' | 'unavailable' | 'offline';

export interface MetaAgentStatusLineProps {
  status: MetaAgentHomeStatus;
  workspaces: WorkspaceHomeSummaryDto[] | null;
  clock: number;
  /** Omit the latest write when the page header already shows its own update time. */
  showLastWrite?: boolean;
  mode?: MetaAgentLineMode;
  reason?: string | null;
  /** Why background maintenance stopped, for mode `stopped`. */
  stop?: MetaAgentStop | null;
  /** The range Settings chose for the first read; the range a running first read was queued with wins. */
  firstRunDays?: number | null;
  firstRun?: SpacesFirstRunStatus | null;
  cursors?: readonly MetaAgentCursorRow[] | null;
  recentRuns?: readonly MetaAgentRecentRun[] | null;
  update?: MetaAgentUpdateState;
  /** After the first run: the Spaces Home summary is being rewritten in the background. */
  homeUpdating?: boolean;
  onOpenScheduled?(): void;
  onOpenSettings?(): void;
  onResume?(): void;
  /** Retry after a stop: restart the stopped workspaces and run one round now. */
  onRetry?(): Promise<void> | void;
  onOpenWorkspace?(workspaceId: string): void;
  onRetryWorkspace?(workspaceId: string): void;
}

const goToScheduled = () => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'scheduled' } }));

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Where a workspace stands, in words: the cursor number itself is for Scheduled › Meta agent. */
function cursorState(row: MetaAgentCursorRow): string {
  if (row.problem) return row.problem.stopped ? `Stopped: ${row.problem.message}` : `Last try failed: ${row.problem.message} · retrying`;
  switch (row.state) {
    case 'synced': return 'Up to date';
    case 'next': return `${plural(row.unread, 'new conversation')} to read next round`;
    case 'no-new': return 'No new conversations yet';
    case 'error': return 'Last try failed';
  }
}

function lastResult(run: MetaAgentRecentRun | undefined): string | null {
  if (!run || run.state === 'failed') return null;
  if (run.state === 'running') return 'reading now';
  if (run.noModelCall) return 'last check found nothing new';
  return `last run: ${plural(run.writes, 'change')}${run.proposals ? `, ${plural(run.proposals, 'suggestion')}` : ''}`;
}

/** One workspace's line in the detail list: its first read while that lasts, then where it stands and its last result. */
export function workspaceDetailText(run: FirstRunProgressDto | null, cursor: MetaAgentCursorRow | undefined, last: MetaAgentRecentRun | undefined, clock: number, days: number = META_AGENT_DEFAULT_FIRST_RUN_DAYS): string {
  if (cursor?.state === 'error' && (!run || run.state === 'done')) return cursorState(cursor);
  if (!run || (run.state === 'done' && cursor && cursor.cursor > run.startSeq)) {
    if (!cursor) return 'Not read yet';
    return [cursorState(cursor), cursor.lastRunAt ? `read ${homeAge(cursor.lastRunAt, clock)}` : null, lastResult(last)]
      .filter(Boolean).join(' · ');
  }
  switch (run.state) {
    case 'queued': return `Queued · history ${run.total}`;
    case 'reading': return `Reading history ${run.readCount}/${run.total}`;
    case 'writing': return `Writing the home · read ${run.readCount}/${run.total}`;
    case 'failed': return `Not written: ${run.error || 'the run stopped'}`;
    case 'done': return [run.total === 0 ? `No conversations in the last ${days} days` : `History ${run.total}`, 'home written', continuesFrom(run.startSeq)].join(' · ');
  }
}

/** Where incremental reading picks up after the first read: the completion count it started at. */
function continuesFrom(startSeq: number): string {
  return startSeq > 0 ? `continues from #${startSeq}` : 'continues with new conversations';
}

function summaryText(firstRun: SpacesFirstRunStatus, homes: number): string {
  if (firstRun.haltedReason) return 'Stopped until the restriction check passes';
  switch (firstRun.summary.state) {
    case 'done': return `Written · read ${plural(homes, 'workspace home')}, not conversations`;
    case 'running': return `Reading ${plural(homes, 'workspace home')}`;
    case 'due': return 'Starts on the next round';
    case 'waiting': return 'Waits for every workspace home';
  }
}

function Mark({ run, problem }: { run: FirstRunProgressDto | null; problem?: MetaAgentCursorRow['problem'] }) {
  if (problem && (!run || run.state === 'done')) {
    return <X size={13} strokeWidth={2} className="spaces-home-status__bad" aria-label={problem.stopped ? 'Stopped' : 'Failed'} />;
  }
  if (run?.state === 'done') return <Check size={13} strokeWidth={2} className="spaces-home-status__ok" aria-label="Done" />;
  if (run?.state === 'reading' || run?.state === 'writing') return <span className="agent-spinner" role="img" aria-label="In progress" />;
  if (run?.state === 'failed') return <X size={13} strokeWidth={2} className="spaces-home-status__bad" aria-label="Failed" />;
  return <span className="spaces-home-status__queued" aria-hidden="true">·</span>;
}

function DetailList({ workspaces, firstRun, cursors, recentRuns, clock, days, showNote, onOpenWorkspace, onRetryWorkspace }: {
  workspaces: WorkspaceHomeSummaryDto[];
  firstRun: SpacesFirstRunStatus | null;
  cursors: readonly MetaAgentCursorRow[];
  recentRuns: readonly MetaAgentRecentRun[];
  clock: number;
  days: number;
  showNote: boolean;
  onOpenWorkspace?(workspaceId: string): void;
  onRetryWorkspace?(workspaceId: string): void;
}) {
  const done = workspaces.filter((workspace) => workspace.firstRun?.state === 'done').length;
  const globalDone = firstRun?.summary.state === 'done';
  return (
    <ul className="spaces-home-status__list" aria-label="Meta agent per workspace">
      {workspaces.length === 0 && <li className="spaces-home-muted">No workspaces yet.</li>}
      {workspaces.map((workspace) => {
        const run = workspace.firstRun;
        const cursor = cursors.find((row) => row.workspaceId === workspace.workspaceId);
        const last = recentRuns.find((item) => item.workspaceId === workspace.workspaceId);
        return (
          <li key={workspace.workspaceId} data-state={run?.state ?? 'none'} className={run?.state === 'queued' ? 'is-dim' : undefined}>
            <Mark run={run} problem={cursor?.problem} />
            <span className="spaces-home-status__name">{workspace.workspaceName}</span>
            <span className="spaces-home-status__mono">{workspaceDetailText(run, cursor, last, clock, days)}</span>
            <span>
              {run?.state === 'done' && onOpenWorkspace && <button type="button" className="spaces-home-link" aria-label={`Open ${workspace.workspaceName}`} onClick={() => onOpenWorkspace(workspace.workspaceId)}>Open</button>}
              {run?.state === 'failed' && onRetryWorkspace && <button type="button" className="spaces-home-link" aria-label={`Retry ${workspace.workspaceName}`} onClick={() => onRetryWorkspace(workspace.workspaceId)}>Retry</button>}
            </span>
          </li>
        );
      })}
      {firstRun && firstRun.requestedAt !== null && (
        <li data-state={globalDone ? 'done' : 'global'} className={globalDone || firstRun.summary.state === 'running' ? undefined : 'is-dim'}>
          {globalDone ? <Check size={13} strokeWidth={2} className="spaces-home-status__ok" aria-label="Done" />
            : firstRun.summary.state === 'running' ? <span className="agent-spinner" role="img" aria-label="In progress" />
              : <span className="spaces-home-status__queued" aria-hidden="true">·</span>}
          <span className="spaces-home-status__name">Home (global)</span>
          <span className="spaces-home-status__mono">{summaryText(firstRun, done)}</span>
          <span />
        </li>
      )}
      {showNote && <li className="is-dim spaces-home-status__note">
        <span /><span>First time: it reads your past conversations once. After that it only reads conversations that finish.</span>
      </li>}
    </ul>
  );
}

function runtimePart(status: MetaAgentHomeStatus): string | null {
  if (!status.runtimeLabel) return null;
  return `${status.runtimeLabel}${status.followsGlobal === undefined ? '' : status.followsGlobal ? ' (follows global)' : ' (custom)'}`;
}

function updateNote(update: MetaAgentUpdateState | undefined): string | null {
  if (!update) return null;
  if (update.phase === 'running') return update.workspaces > 0 ? `reading new conversations in ${plural(update.workspaces, 'workspace')}…` : 'starting a round…';
  if (update.phase === 'no-new') return 'No new conversations';
  if (update.phase === 'failed') return `Update failed${update.error ? `: ${update.error}` : ''}`;
  return null;
}

const Sep = () => <span className="spaces-home-status__sep" aria-hidden="true">·</span>;

/** The mark sits beside the first line; everything after it wraps as one run of text. */
function Line({ mark, children }: { mark: React.ReactNode; children: React.ReactNode }) {
  return <div className="spaces-home-status__line">{mark}<span className="spaces-home-status__text">{children}</span></div>;
}

const Dot = ({ tone }: { tone?: 'off' | 'warn' | 'danger' }) => <span className="spaces-home-status__dot" data-tone={tone} aria-hidden="true" />;

/** Reasons a different runtime would get around. */
const RUNTIME_REASONS: ReadonlySet<MetaAgentStop['reason']> = new Set(['runtime-missing', 'signed-out', 'quota']);

/** The days the first read covers: the range a running first read was queued with, else the one Settings chose. */
function firstRunDaysOf(recentRuns: readonly MetaAgentRecentRun[] | null | undefined, chosen: number | null | undefined): number {
  return recentRuns?.find((row) => row.kind === 'first-run')?.firstRunDays ?? chosen ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS;
}

function RetryButton({ onRetry }: { onRetry(): Promise<void> | void }) {
  const [retrying, setRetrying] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? `Couldn’t retry: ${err.message}` : 'Couldn’t retry the Meta agent');
    } finally {
      if (mounted.current) setRetrying(false);
    }
  };
  return <button type="button" className="spaces-home-link" disabled={retrying} onClick={() => { void retry(); }}>{retrying ? 'Retrying…' : 'Retry'}</button>;
}
const Spinner = () => <span className="agent-spinner spaces-home-status__spin" aria-hidden="true" />;

/** One line on what the Meta agent does and did last, with its per-workspace detail on request. */
export function MetaAgentStatusLine({
  status, workspaces, clock, showLastWrite = true, mode = 'normal', reason, stop = null, firstRunDays, firstRun = null, cursors, recentRuns, update, homeUpdating = false,
  onOpenScheduled = goToScheduled, onOpenSettings, onResume, onRetry, onOpenWorkspace, onRetryWorkspace,
}: MetaAgentStatusLineProps) {
  const firstRunOpen = mode === 'first-run' || mode === 'just-read';
  const [open, setOpen] = React.useState(firstRunOpen);
  const opened = React.useRef(firstRunOpen);
  React.useEffect(() => {
    // The detail opens by itself when a first run starts or ends, not again on every render.
    if (firstRunOpen && !opened.current) setOpen(true);
    opened.current = firstRunOpen;
  }, [firstRunOpen]);

  const live = firstRun?.workspaces ?? workspaces ?? [];
  const shown = live.filter((workspace) => workspace.hiddenAt === null);
  const toggle = <button type="button" className="spaces-home-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide' : 'Details'}</button>;
  const scheduled = <button type="button" className="spaces-home-link" onClick={onOpenScheduled}>Scheduled</button>;
  const list = open && <DetailList workspaces={shown} firstRun={firstRun} cursors={cursors ?? []} recentRuns={recentRuns ?? []} clock={clock}
    days={firstRunDaysOf(recentRuns, firstRunDays)}
    showNote={firstRunOpen} onOpenWorkspace={onOpenWorkspace} onRetryWorkspace={onRetryWorkspace} />;

  if (mode === 'offline') {
    return <div className="spaces-home-status" data-mode="offline" role="status">
      <Line mark={<Dot tone="off" />}>{META_AGENT_HEADLINE.offline} · showing the last saved Home</Line>
    </div>;
  }
  if (mode === 'unavailable' || mode === 'not-running') {
    return <div className="spaces-home-status" data-mode={mode} role="status">
      <Line mark={<Dot tone="warn" />}>
        {META_AGENT_HEADLINE['not-running']}{reason ? ` · ${reason}` : ''}
        {mode === 'unavailable' && onOpenSettings && <><Sep /><button type="button" className="spaces-home-link" onClick={onOpenSettings}>Settings › Meta agent</button></>}
      </Line>
    </div>;
  }
  if (mode === 'stopped' && stop) {
    return <div className="spaces-home-status" data-mode="stopped" role="status">
      <Line mark={<Dot tone="danger" />}>
        <span className="spaces-home-status__error">{META_AGENT_HEADLINE.stopped}: {stop.message}</span>
        {onRetry && <><Sep /><RetryButton onRetry={onRetry} /></>}
        {onOpenSettings && RUNTIME_REASONS.has(stop.reason) && <><Sep /><button type="button" className="spaces-home-link" onClick={onOpenSettings}>Change runtime</button></>}
        <Sep />{toggle}
        <Sep />{scheduled}
      </Line>
      {list}
    </div>;
  }
  if (mode === 'paused') {
    return <div className="spaces-home-status" data-mode="paused">
      <Line mark={<Dot tone="off" />}>
        {META_AGENT_HEADLINE.paused}
        {onResume && <><Sep /><button type="button" className="spaces-home-link" onClick={onResume}>Resume</button></>}
        <Sep />{scheduled}
      </Line>
    </div>;
  }
  if (mode === 'first-run') {
    const progress = firstRunProgress(firstRun);
    const doing = progress.current
      ? <>writing <b>{progress.current.workspaceName}</b>’s home</>
      : firstRun?.summary.state === 'running' ? 'writing the Pages Home' : 'waiting for its turn';
    const percent = progress.total > 0 ? Math.round((progress.read / progress.total) * 100) : 0;
    return <div className="spaces-home-status" data-mode="first-run">
      <Line mark={<Spinner />}>
        First time opening Pages · Meta agent{status.runtimeLabel ? ` (${status.runtimeLabel})` : ''} is reading the last {firstRunDaysOf(recentRuns, firstRunDays)} days
        {' · '}<b>{progress.read}</b> / {progress.total}{' · '}{doing}
        <Sep />{toggle}
      </Line>
      <div className="spaces-home-status__bar" role="progressbar" aria-label="First read" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.read}>
        <i style={{ width: `${percent}%` }} />
      </div>
      {list}
    </div>;
  }

  const parts: string[] = [];
  if (mode === 'just-read') {
    const homes = firstRunProgress(firstRun).done;
    parts.push(`Meta agent just read the history; from now on it checks new conversations every ${status.intervalSeconds} s`);
    parts.push(`wrote ${plural(homes, 'workspace home')} and this page`);
  } else {
    parts.push(`Meta agent checks new conversations every ${status.intervalSeconds} s`);
    if (showLastWrite && status.lastWrite) parts.push(`wrote ${status.lastWrite.workspaceName} ${homeAge(status.lastWrite.at, clock)}`);
  }
  const runtime = runtimePart(status);
  if (runtime) parts.push(runtime);
  const roundNote = updateNote(update);
  const note = roundNote ?? (homeUpdating && mode === 'normal' ? 'updating the Pages Home…' : null);
  const working = update?.phase === 'running' || (roundNote === null && note !== null);
  const retrying = mode === 'normal' ? cursors?.find((row) => row.problem && !row.problem.stopped)?.problem : undefined;
  return (
    <div className="spaces-home-status" data-mode={mode}>
      <Line mark={working ? <Spinner /> : <Dot />}>
        {parts.join(' · ')}
        <Sep />{toggle}
        <Sep />{scheduled}
        {note && <><Sep /><span role="status" className={update?.phase === 'failed' ? 'spaces-home-status__error' : undefined}>{note}</span></>}
        {!note && retrying && <><Sep /><span className="spaces-home-status__error">{retrying.message} · retrying</span></>}
      </Line>
      {list}
    </div>
  );
}
