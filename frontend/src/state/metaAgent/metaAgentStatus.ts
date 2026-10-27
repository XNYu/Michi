import type { MetaAgentGuardStatus, MetaAgentOverview, MetaAgentStop, SpacesFirstRunStatus } from 'michi-shared';
import type { MetaAgentInfo } from '../../services/api/metaAgent';
import { metaAgentGuardFailures, type MetaAgentStatus as MetaAgentReadStatus } from './useMetaAgent';
import { firstRunActive } from './spacesFirstRun';

/**
 * One reading of what the Meta agent is doing, shared by the Spaces sidebar's
 * bottom row, the Spaces Home status line, Scheduled › Meta agent and the
 * rail's Settings dot, so no two of them disagree. Earlier kinds win:
 *
 * - `offline`: the backend did not answer;
 * - `guard-failed`: a restriction check failed;
 * - `not-running`: nothing can run on this backend (scheduled jobs are off, or it has no Meta agent);
 * - `unsupported`: the chosen runtime cannot run the Meta agent;
 * - `stopped`: errors stopped background maintenance;
 * - `first-run`: the first read of the history is in progress;
 * - `paused`: the user paused background maintenance;
 * - `just-read`: the first read ended while this window watched;
 * - `normal`: it checks for new conversations every 60 s.
 */
export type MetaAgentStatusKind =
  | 'offline' | 'guard-failed' | 'not-running' | 'unsupported' | 'stopped' | 'first-run' | 'paused' | 'just-read' | 'normal';

export interface MetaAgentStatus {
  kind: MetaAgentStatusKind;
  /** Why it is not running, cannot run or stopped, in one plain sentence. */
  reason: string | null;
  /** With kinds `stopped` and `guard-failed`: what stopped it. */
  stop: MetaAgentStop | null;
  /** With kind `guard-failed`: the failed restriction checks, empty until the runtime they ran on is known. */
  guardFailures: MetaAgentGuardStatus[];
  /** Settings › Meta agent can fix it: the rail's Settings dot. */
  settingsAlert: boolean;
}

export interface MetaAgentStatusInput {
  /** GET /api/meta-agent, and how reading it went. */
  info?: MetaAgentInfo | null;
  infoStatus?: MetaAgentReadStatus;
  /** The local connection's first-run snapshot. */
  firstRun?: { data: SpacesFirstRunStatus | null; unreachable: boolean; schedulerOff: boolean; justFinished: boolean } | null;
  overview?: MetaAgentOverview | null;
  /** Something else says the backend is out of reach, e.g. the Spaces Home showing its last saved copy. */
  offline?: boolean;
  /** e.g. `Claude`, for a runtime the backend gave no reason for. */
  runtimeLabel?: (runtimeId: string) => string;
}

export const SCHEDULER_OFF_REASON = 'Scheduled jobs are off on this backend';
export const NO_META_AGENT_REASON = 'This Michi backend has no Meta agent yet';
export const GUARD_FAILED_REASON = 'Its tool check failed';

/** The words every surface leads with for each state that is not a progress or an ordinary line. */
export const META_AGENT_HEADLINE: Record<Exclude<MetaAgentStatusKind, 'first-run' | 'just-read' | 'normal'>, string> = {
  offline: 'Backend not connected',
  'guard-failed': 'Meta agent stopped',
  'not-running': 'Meta agent is not running',
  unsupported: 'Meta agent is not running',
  stopped: 'Meta agent stopped',
  paused: 'Meta agent is paused',
};

const SETTINGS_FIXES: ReadonlySet<MetaAgentStatusKind> = new Set(['guard-failed', 'unsupported', 'stopped']);

function status(kind: MetaAgentStatusKind, extra: Partial<MetaAgentStatus> = {}): MetaAgentStatus {
  return { kind, reason: null, stop: null, guardFailures: [], settingsAlert: SETTINGS_FIXES.has(kind), ...extra };
}

export function metaAgentStatus(input: MetaAgentStatusInput): MetaAgentStatus {
  const info = input.info ?? null;
  const overview = input.overview ?? null;
  const firstRun = input.firstRun ?? null;
  if (input.offline || firstRun?.unreachable) return status('offline');

  const stop = overview?.stopped ?? (overview?.state === 'error'
    ? { reason: 'other' as const, message: overview.error ?? 'The reason is unknown', workspaceIds: [] } : null);
  const guardFailures = metaAgentGuardFailures(info);
  const halted = firstRun?.data?.haltedReason ?? null;
  const runtimeId = info?.resolved.runtimeId ?? overview?.runtime.runtimeId ?? null;
  if (guardFailures.length === 0 && halted && runtimeId) {
    guardFailures.push({ state: 'failed', runtimeId, toolset: 'maintenance', unexpectedTools: [], detail: halted, checkedAt: firstRun?.data?.requestedAt ?? 0 });
  }
  if (guardFailures.length > 0 || halted) {
    const reason = stop?.reason === 'restriction-check' ? stop.message : GUARD_FAILED_REASON;
    return status('guard-failed', { guardFailures, reason, stop: stop?.reason === 'restriction-check' ? stop : { reason: 'restriction-check', message: reason, workspaceIds: [] } });
  }

  const notRunning = overview?.notRunning?.message
    ?? (firstRun?.schedulerOff ? SCHEDULER_OFF_REASON : null)
    ?? (input.infoStatus === 'unavailable' ? NO_META_AGENT_REASON : null);
  if (notRunning) return status('not-running', { reason: notRunning });

  if (info && !info.availability.available) {
    const label = input.runtimeLabel?.(info.resolved.runtimeId) ?? info.resolved.runtimeId;
    return status('unsupported', { reason: info.availability.reason ?? `The Meta agent cannot run on ${label}` });
  }
  if (stop?.reason === 'runtime-unsupported') return status('unsupported', { reason: stop.message });
  if (stop) return status('stopped', { reason: stop.message, stop });
  if (firstRunActive(firstRun?.data)) return status('first-run');
  if (overview?.state === 'paused') return status('paused');
  if (firstRun?.justFinished) return status('just-read');
  return status('normal');
}
