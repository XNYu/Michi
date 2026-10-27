import type { MetaAgentCursorRow, MetaAgentRecentRun, MetaAgentResolvedRuntime } from 'michi-shared';
import { META_AGENT_DEFAULT_FIRST_RUN_DAYS } from 'michi-shared';
import { metaAgentResolvedText, metaAgentRestriction, metaAgentRuntimeLabel } from '../../settings/metaAgent/runtimeCopy';
import { MONTHS, formatMichiClock } from '../../content/michiFormat';

export const runtimeLabel = metaAgentRuntimeLabel;

export const restrictionText = (runtimeId: string) => metaAgentRestriction(runtimeId) ?? 'no checked limits for this AI service';

/** The same words as Settings › Meta agent and the window's chip. */
export function runtimeText(runtime: MetaAgentResolvedRuntime): string {
  return metaAgentResolvedText(runtime);
}

const pad = (n: number) => String(n).padStart(2, '0');
const DAY = 86_400_000;

function dayStart(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

export const clock = (time: number) => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const monthDay = (time: number) => { const d = new Date(time); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const daysBefore = (time: number, now: number) => Math.round((dayStart(now) - dayStart(time)) / DAY);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Today: 10:42; yesterday: Yesterday; within a week: N days ago; older: Oct 9. */
export function lastSeen(time: number | null, now: number): string {
  if (time === null) return '—';
  const days = daysBefore(time, now);
  if (days <= 0) return clock(time);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return monthDay(time);
}

/** The time of a recent-runs row: its clock time, prefixed with the day when not today; a span for merged rows. */
export function runTime(row: MetaAgentRecentRun, now: number): string {
  const stamp = (time: number) => {
    const days = daysBefore(time, now);
    if (days <= 0) return clock(time);
    return days === 1 ? `yesterday ${clock(time)}` : formatMichiClock(time);
  };
  return clock(row.since) === clock(row.at) && daysBefore(row.since, now) === daysBefore(row.at, now)
    ? stamp(row.at) : `${stamp(row.since)}–${stamp(row.at)}`;
}

export const CURSOR_STATE_LABELS: Record<MetaAgentCursorRow['state'], string> = {
  synced: 'Up to date',
  next: 'Next round',
  'no-new': 'No new conversations',
  error: 'Error',
};

const who = (row: MetaAgentRecentRun) => row.workspaceCount > 1 ? `${row.workspaceCount} workspaces` : row.workspaceName ?? 'Workspace';

export const SUMMARY_TITLE = 'Home (all workspaces)';

export function runTitle(row: MetaAgentRecentRun): string {
  if (row.kind === 'summary') {
    if (row.state === 'running') return `${SUMMARY_TITLE} · updating`;
    if (row.state === 'failed') return `${SUMMARY_TITLE} · failed`;
    return row.workspaceCount > 0 ? `${SUMMARY_TITLE} · ${plural(row.workspaceCount, 'workspace home')} changed` : SUMMARY_TITLE;
  }
  if (row.kind === 'first-run') return row.state === 'running' ? 'First read · reading' : row.state === 'failed' ? 'First read · failed' : 'First read';
  if (row.state === 'failed') return `${who(row)} could not run`;
  if (row.noModelCall) return `No new conversations in ${who(row)}`;
  const read = `${who(row)} · ${plural(row.turns, 'new conversation')}`;
  return row.state === 'attention' ? `${read} · needs attention` : row.state === 'running' ? `${read} · in progress` : read;
}

/** The parts of a read row after its read call, joined by arrows. */
export function readSteps(row: MetaAgentRecentRun): string[] {
  const more = row.routedPages > row.routedPageTitles.length ? ` and ${row.routedPages - row.routedPageTitles.length} more` : '';
  const routed = row.routedPages > 0 ? `for ${row.routedPageTitles.join(', ')}${more}` : 'no page to update';
  const wrote = [row.writes > 0 ? `${plural(row.writes, 'change')}` : '', row.proposals > 0 ? plural(row.proposals, 'suggestion') : ''].filter(Boolean).join(', ');
  return [routed, wrote || 'nothing to change', row.cursorTo !== null ? `now read up to #${row.cursorTo}` : 'read position unchanged'];
}

export function quietText(row: MetaAgentRecentRun): string {
  if (row.state === 'failed') return `${row.error ?? 'Could not start'}${row.count > 1 ? ` · ${row.count} times` : ''}`;
  return `Nothing new, so no AI was used.${row.count > row.workspaceCount ? ` ${row.count} checks in all.` : ''}`;
}

export function firstRunText(row: MetaAgentRecentRun): string {
  const range = `last ${row.firstRunDays ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS} days, up to 1,000`;
  if (row.state === 'failed') return `Failed: ${row.error ?? 'could not finish reading'}`;
  if (row.state === 'running') return `Reading ${plural(row.turns, 'past conversation')} (${range}) to write ${plural(row.workspaceCount, 'workspace home')}.`;
  return `Read ${plural(row.turns, 'past conversation')} (${range}) once → wrote ${plural(row.workspaceCount, 'workspace home')}. Conversations that finished meanwhile are read in the next round.`;
}

const names = (list: readonly string[]) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** A Spaces Home summary: the workspace homes that changed, then what it rewrote. It never reads conversations. */
export function summaryText(row: MetaAgentRecentRun): string {
  if (row.state === 'failed') return `Failed: ${row.error ?? 'the summary stopped before writing'}`;
  const changed = row.changedHomes?.length ? `New in ${names(row.changedHomes)} → ` : '';
  const did = row.state === 'running' ? 'reading the workspace homes…'
    : row.rewroteBlocks?.length ? `rewrote ${row.rewroteBlocks.map((title) => `“${title}”`).join(', ')}.` : 'nothing to change.';
  const text = `${changed}${did}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} It reads pages, not conversations.`;
}

/** The completion counts a read covered: after `after`, through `through`. */
export function readRange(row: MetaAgentRecentRun): string {
  if (row.after === null || row.through === null) return 'read';
  return row.through === row.after + 1 ? `read turn #${row.through}` : `read turns #${row.after + 1}–#${row.through}`;
}

/** A cursor row's state: a problem says whether runs stopped or keep retrying. */
export function cursorStateLabel(row: MetaAgentCursorRow): string {
  if (row.problem) return row.problem.stopped ? 'Stopped' : 'Retrying';
  return CURSOR_STATE_LABELS[row.state];
}
