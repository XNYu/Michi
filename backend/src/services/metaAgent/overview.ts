import {
  SCHEDULED_JOB_LIMITS,
  type MetaAgentCursorRow,
  type MetaAgentOverview,
  type MetaAgentOverviewState,
  type MetaAgentRecentRun,
  type MetaAgentResolvedRuntime,
  type MetaAgentStop,
  type PageWriteResult,
} from 'michi-shared';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { conversationCompletionCounter } from '../conversationUpdates';
import { getDb } from '../db';
import { listFirstRuns } from '../pages/firstRun';
import { PageMaintenanceConfigService } from '../pages/maintenanceConfig';
import { listMaintenanceBacklog, requeueMaintenanceAttention } from '../pages/maintenanceRepository';
import { scheduledJobsFeatureEnabled } from '../scheduledJobs/feature';
import type { ScheduledJobScheduler } from '../scheduledJobs/scheduler';
import { firstRunWindowDays } from './firstRunHistory';
import { getMetaAgentGuardStatus } from './guardStatus';
import { resolveMetaAgentRuntime } from './settings';
import { classifyMetaAgentRunError, errorFirstLine, runtimeLabel } from './stopReason';
import {
  listManagedMaintenanceJobIds, listMaintenanceConfigs as listConfigs, placeholders, startOfLocalDay, todayMetrics,
  type MaintenanceConfigRow as ConfigRow,
} from './todayUsage';

export { startOfLocalDay };

const RECENT_ROWS = 20;
const ROUTED_TITLES = 5;

interface PlanRow {
  id: string; workspace_id: string; after_seq: number; through_seq: number; state: string;
  created_at: number; turns: number; writes: number; proposals: number; node_id: string | null;
}

interface CheckRow { workspace_id: string; status: string; started_at: number; finished_at: number | null; error: string | null }

const db = () => getDb();

/** When the cursor last passed a finished incremental plan. */
function lastCursorMove(config: ConfigRow, ownerUserId: string): number | null {
  const row = db().prepare(`SELECT MAX(updated_at) AS at FROM page_maintenance_plans
    WHERE job_id=? AND owner_user_id=? AND state='terminal' AND scope_space_id IS NULL AND reconsider_of_plan_id IS NULL
      AND through_seq>after_seq AND through_seq<=?`).get(config.job_id, ownerUserId, config.completion_cursor) as { at: number | null };
  return row.at;
}

function cursorRow(config: ConfigRow, ownerUserId: string, runtimeId: string): { row: MetaAgentCursorRow; detail?: string } {
  const unread = Math.max(0, conversationCompletionCounter(config.workspace_id) - config.completion_cursor);
  const lastRunAt = lastCursorMove(config, ownerUserId);
  const backlog = listMaintenanceBacklog(config.workspace_id, ownerUserId);
  const attention = backlog.attentionSources;
  const failed = config.auto_paused === 1 || config.last_status === 'failed' || config.last_status === 'timed_out';
  const base = { workspaceId: config.workspace_id, workspaceName: config.workspace_name, cursor: config.completion_cursor, unread, lastRunAt };
  if (failed) {
    const classified = classifyMetaAgentRunError(config.last_error ?? '', { runtimeId, workspaceName: config.workspace_name });
    const error = config.last_error ?? 'The last run failed';
    return {
      row: { ...base, state: 'error', error, problem: { reason: classified.reason, message: classified.message, stopped: config.auto_paused === 1 } },
      ...(classified.firstLine !== classified.message ? { detail: classified.firstLine } : {}),
    };
  }
  if (attention > 0) {
    const reason = backlog.plans.flatMap((plan) => plan.sources).find((source) => source.state === 'attention')?.terminalReason;
    return {
      row: { ...base, state: 'error',
        error: `${attention} conversation turn${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention`,
        // The reader does not move past a batch it could not read, so this holds the workspace until it is resolved.
        problem: { reason: 'needs-attention', stopped: true,
          message: `${attention === 1 ? 'A conversation' : `${attention} conversations`} in ${config.workspace_name} could not be read` } },
      ...(reason ? { detail: errorFirstLine(reason) } : {}),
    };
  }
  return { row: { ...base, state: unread > 0 ? 'next' : lastRunAt === null ? 'no-new' : 'synced' } };
}

function routedResources(planId: string): string[] {
  const rows = db().prepare(`SELECT DISTINCT r.resource_kind,r.resource_id,COALESCE(p.title,d.title,r.resource_id) AS title
    FROM page_maintenance_resources r
    LEFT JOIN pages p ON r.resource_kind='page' AND p.id=r.resource_id
    LEFT JOIN page_databases d ON r.resource_kind='database' AND d.id=r.resource_id
    WHERE r.plan_id=? ORDER BY r.resource_kind DESC,title`).all(planId) as unknown as Array<{ title: string }>;
  return rows.map((row) => row.title);
}

type Entry = MetaAgentRecentRun & { mergeKey: string | null };

function planEntries(jobIds: string[], ownerUserId: string, cursors: Map<string, number>, names: Map<string, string>): Entry[] {
  const rows = db().prepare(`SELECT p.id,p.workspace_id,p.after_seq,p.through_seq,p.state,p.created_at,n.id AS node_id,
      (SELECT COUNT(*) FROM page_maintenance_sources s WHERE s.plan_id=p.id) AS turns,
      (SELECT COUNT(*) FROM page_maintenance_receipts r WHERE r.plan_id=p.id AND r.outcome='written') AS writes,
      (SELECT COUNT(*) FROM page_maintenance_receipts r WHERE r.plan_id=p.id AND r.outcome='proposed') AS proposals
    FROM page_maintenance_plans p
    LEFT JOIN scheduled_job_runs j ON j.id=p.run_id
    LEFT JOIN nodes n ON n.id=j.node_id AND n.workspace_id=p.workspace_id AND n.deleted_at IS NULL AND n.purged_at IS NULL
    WHERE p.owner_user_id=? AND p.job_id IN (${placeholders(jobIds.length)}) AND p.state<>'cancelled'
    ORDER BY p.created_at DESC,p.id LIMIT ?`).all(ownerUserId, ...jobIds, RECENT_ROWS * 3) as unknown as PlanRow[];
  return rows.map((row): Entry => {
    const done = row.state === 'terminal';
    const routed = row.turns > 0 ? routedResources(row.id) : [];
    const moved = done && row.through_seq > row.after_seq && row.through_seq <= (cursors.get(row.workspace_id) ?? -1);
    return {
      at: row.created_at, since: row.created_at, workspaceId: row.workspace_id, workspaceName: names.get(row.workspace_id) ?? null,
      workspaceCount: 1, after: row.after_seq, through: row.through_seq, turns: row.turns,
      routedPages: routed.length, routedPageTitles: routed.slice(0, ROUTED_TITLES), writes: row.writes, proposals: row.proposals,
      cursorTo: moved ? row.through_seq : null, noModelCall: row.turns === 0, kind: 'incremental', count: 1,
      state: done ? 'done' : row.state === 'attention' ? 'attention' : 'running', nodeId: row.node_id,
      // A plan whose turns are all unreadable (scheduled-job output) reads nothing: it reads as a quiet check.
      mergeKey: row.turns === 0 && done ? 'quiet' : null,
    };
  });
}

/** Runs that never opened a session or bound a plan: checks that found nothing, or that could not start. */
function checkEntries(jobIds: string[], names: Map<string, string>): Entry[] {
  const rows = db().prepare(`SELECT r.workspace_id,r.status,r.started_at,r.finished_at,r.error FROM scheduled_job_runs r
    WHERE r.job_id IN (${placeholders(jobIds.length)}) AND r.status NOT IN ('running','cancelled') AND r.node_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM page_maintenance_plans p WHERE p.run_id=r.id)
    ORDER BY r.started_at DESC LIMIT ?`).all(...jobIds, SCHEDULED_JOB_LIMITS.runHistoryPerJob * jobIds.length) as unknown as CheckRow[];
  return rows.map((row): Entry => {
    const ok = row.status === 'succeeded';
    const at = row.finished_at ?? row.started_at;
    return {
      at, since: at, workspaceId: row.workspace_id, workspaceName: names.get(row.workspace_id) ?? null, workspaceCount: 1,
      after: null, through: null, turns: 0, routedPages: 0, routedPageTitles: [], writes: 0, proposals: 0, cursorTo: null,
      noModelCall: true, kind: 'incremental', count: 1, state: ok ? 'done' : 'failed', nodeId: null,
      ...(ok ? {} : { error: row.error ?? 'The run stopped before reading' }),
      mergeKey: ok ? 'quiet' : `failed:${row.error ?? ''}`,
    };
  });
}

/** The first read of every workspace's history is one generation, so it is one row. */
function firstRunEntry(ownerUserId: string, workspaceIds: Set<string>): Entry | null {
  const runs = listFirstRuns(ownerUserId).filter((run) => workspaceIds.has(run.workspaceId));
  if (runs.length === 0) return null;
  const failed = runs.find((run) => run.state === 'failed');
  const done = runs.every((run) => run.state === 'done');
  const only = runs.length === 1 ? runs[0].workspaceId : null;
  return {
    at: Math.max(...runs.map((run) => run.updatedAt)), since: Math.min(...runs.map((run) => run.startedAt)),
    workspaceId: only, workspaceName: null, workspaceCount: runs.length, after: null, through: null,
    turns: runs.reduce((sum, run) => sum + run.total, 0), routedPages: 0, routedPageTitles: [], writes: 0, proposals: 0,
    cursorTo: null, noModelCall: false, kind: 'first-run', count: 1, nodeId: null,
    state: failed ? 'failed' : done ? 'done' : 'running', ...(failed?.error ? { error: failed.error } : {}),
    firstRunDays: Math.max(...runs.map((run) => firstRunWindowDays(run.workspaceId, ownerUserId))),
    mergeKey: null,
  };
}

interface SummaryRunRow { state: string; error: string | null; result_json: string | null; created_at: number; live: number }

/** A block's name as the Home shows it: its title, else its heading text. */
function blockName(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const { title, text, type } = block as { title?: unknown; text?: unknown; type?: unknown };
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (typeof text !== 'string') return null;
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? (type === 'heading' ? text.split('\n')[0] : null);
  return heading?.trim() || null;
}

function writtenBlocks(resultJson: string | null): string[] {
  let result: Partial<PageWriteResult> | null = null;
  try { result = resultJson ? JSON.parse(resultJson) as Partial<PageWriteResult> : null; } catch { return []; }
  const names = [...(result?.applied ?? []), ...(result?.proposed ?? [])].map((change) => {
    const snapshot = change.after?.kind === 'block' && change.after.exists ? change.after
      : change.before?.kind === 'block' && change.before.exists ? change.before : null;
    return snapshot ? blockName(snapshot.block) : null;
  });
  return [...new Set(names.filter((name): name is string => !!name))];
}

/** Workspace homes an agent changed after `after` and up to `through`: what a summary in between had new to read. */
function changedHomes(ownerUserId: string, after: number, through: number): string[] {
  const rows = db().prepare(`SELECT DISTINCT w.name FROM page_changes c
    JOIN pages p ON p.id=c.page_id JOIN workspaces w ON w.id=p.workspace_id
    WHERE c.owner_user_id=? AND p.role='workspace-home' AND c.created_at>? AND c.created_at<=?
      AND c.application_state='applied' AND json_extract(c.source,'$.kind')<>'user'
    ORDER BY w.name`).all(ownerUserId, after, through) as unknown as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Each Spaces Home summary is its own row: it reads the workspace homes, not conversations. */
function summaryEntries(ownerUserId: string): Entry[] {
  const rows = db().prepare(`SELECT h.state,h.error,h.result_json,h.created_at,
      EXISTS (SELECT 1 FROM scheduled_job_runs r WHERE r.id=h.run_id AND r.job_id=h.job_id AND r.status='running') AS live
    FROM meta_agent_home_runs h WHERE h.kind='home-summary' AND h.owner_user_id=? AND h.state<>'superseded'
    ORDER BY h.created_at DESC LIMIT ?`).all(ownerUserId, RECENT_ROWS) as unknown as SummaryRunRow[];
  const previous = db().prepare(`SELECT MAX(created_at) AS at FROM meta_agent_home_runs
    WHERE kind='home-summary' AND owner_user_id=? AND state IN ('written','no_change') AND created_at<?`);
  return rows.flatMap((row): Entry[] => {
    const settled = row.state === 'written' || row.state === 'no_change';
    // An active record whose run ended without a decision was never settled; the next summary covers it.
    if (!settled && row.state !== 'failed' && !row.live) return [];
    const since = (previous.get(ownerUserId, row.created_at) as { at: number | null }).at ?? 0;
    const homes = changedHomes(ownerUserId, since, row.created_at);
    const rewrote = row.state === 'written' ? writtenBlocks(row.result_json) : [];
    return [{
      at: row.created_at, since: row.created_at, workspaceId: null, workspaceName: null, workspaceCount: homes.length,
      after: null, through: null, turns: 0, routedPages: 0, routedPageTitles: [], writes: rewrote.length, proposals: 0,
      cursorTo: null, noModelCall: false, kind: 'summary', count: 1, nodeId: null,
      state: settled ? 'done' : row.state === 'failed' ? 'failed' : 'running',
      ...(row.state === 'failed' ? { error: row.error ?? 'The summary stopped before writing' } : {}),
      changedHomes: homes, rewroteBlocks: rewrote.slice(0, ROUTED_TITLES),
      mergeKey: null,
    }];
  });
}

function mergeQuiet(entries: Entry[]): MetaAgentRecentRun[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  const out: Array<Entry & { workspaces: Set<string> }> = [];
  for (const entry of sorted) {
    const last = out[out.length - 1];
    if (last && entry.mergeKey !== null && last.mergeKey === entry.mergeKey) {
      last.count += entry.count;
      last.since = Math.min(last.since, entry.since);
      if (entry.workspaceId) last.workspaces.add(entry.workspaceId);
      last.workspaceCount = last.workspaces.size;
      if (last.workspaceCount > 1) { last.workspaceId = null; last.workspaceName = null; }
      last.cursorTo = null; last.after = null; last.through = null; last.nodeId = null;
      continue;
    }
    if (out.length === RECENT_ROWS) break;
    out.push({ ...entry, workspaces: new Set(entry.workspaceId ? [entry.workspaceId] : []) });
  }
  return out.map(({ mergeKey: _key, workspaces: _ws, ...row }) => row);
}

type OverallState = { state: MetaAgentOverviewState; error?: string; stopped?: MetaAgentStop | null };

const stoppedBy = (stop: MetaAgentStop): OverallState => ({ state: 'error', error: stop.message, stopped: stop });

/**
 * A workspace the user paused does not count as stopped: a Meta agent paused
 * everywhere reads as paused even when a job also stopped itself, since
 * resuming restarts that job too.
 */
function overallState(
  ownerUserId: string, runtime: MetaAgentResolvedRuntime, configs: ConfigRow[],
  rows: Array<{ row: MetaAgentCursorRow; detail?: string }>,
): OverallState {
  const availability = maintenanceRuntimeAvailability(runtime.runtimeId);
  if (!availability.available) {
    return stoppedBy({ reason: 'runtime-unsupported', message: availability.reason ?? `The Meta agent cannot run on ${runtimeLabel(runtime.runtimeId)}`, workspaceIds: [] });
  }
  const guard = getMetaAgentGuardStatus('maintenance', () => runtime, ownerUserId);
  if (guard?.state === 'failed') {
    const label = runtimeLabel(guard.runtimeId);
    return stoppedBy({
      reason: 'restriction-check', workspaceIds: [],
      message: guard.unexpectedTools.length > 0
        ? `${label} started with tools outside the Meta agent's list: ${guard.unexpectedTools.join(', ')}`
        : `${label} did not pass its tool check`,
      ...(guard.detail ? { detail: errorFirstLine(guard.detail) } : {}),
    });
  }
  if (configs.length > 0 && configs.every((config) => config.paused === 1)) return { state: 'paused', stopped: null };
  const live = new Set(configs.filter((config) => config.paused !== 1).map((config) => config.workspace_id));
  const stopped = rows.filter(({ row }) => row.problem?.stopped && live.has(row.workspaceId));
  if (stopped.length > 0) {
    const [{ row, detail }] = stopped;
    return stoppedBy({ reason: row.problem!.reason, message: row.problem!.message, ...(detail ? { detail } : {}),
      workspaceIds: stopped.map((item) => item.row.workspaceId) });
  }
  return { state: 'running', stopped: null };
}

export function metaAgentOverview(input: { ownerUserId: string; now: number; dayStart?: number }): MetaAgentOverview {
  const { ownerUserId } = input;
  const runtime = resolveMetaAgentRuntime(ownerUserId);
  const configs = listConfigs(ownerUserId);
  const jobIds = configs.map((config) => config.job_id);
  const names = new Map(configs.map((config) => [config.workspace_id, config.workspace_name] as const));
  const cursors = new Map(configs.map((config) => [config.workspace_id, config.completion_cursor] as const));
  const first = firstRunEntry(ownerUserId, new Set(names.keys()));
  const entries = jobIds.length === 0 ? [] : [...planEntries(jobIds, ownerUserId, cursors, names), ...checkEntries(jobIds, names)];
  const rows = configs.map((config) => cursorRow(config, ownerUserId, runtime.runtimeId));
  return {
    ...overallState(ownerUserId, runtime, configs, rows),
    // The server builds no scheduler when the feature is off, so no maintenance job starts.
    notRunning: scheduledJobsFeatureEnabled() ? null : { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' },
    runtime,
    today: todayMetrics(ownerUserId, configs, input.dayStart ?? startOfLocalDay(input.now)),
    cursors: rows.map(({ row }) => row),
    recentRuns: mergeQuiet([...entries, ...(first ? [first] : []), ...summaryEntries(ownerUserId)]),
    managedJobIds: listManagedMaintenanceJobIds(ownerUserId),
  };
}

export class MetaAgentPauseError extends Error {
  constructor(message: string) { super(message); this.name = 'MetaAgentPauseError'; }
}

/**
 * Pauses or resumes background maintenance in every listed workspace through
 * the maintenance config service, which keeps each managed job in step.
 * Resuming also restarts a workspace's job that stopped itself after repeated
 * failures and queues again every batch held for attention (the stopped
 * state's Retry). A workspace that refuses is reported after the others were changed.
 */
export function setMetaAgentPaused(input: { scheduler: ScheduledJobScheduler; ownerUserId: string; paused: boolean; clock?: () => number }): void {
  const clock = input.clock ?? Date.now;
  const service = new PageMaintenanceConfigService(input.scheduler, clock);
  const failures: string[] = [];
  for (const config of listConfigs(input.ownerUserId)) {
    try {
      if (!input.paused) requeueMaintenanceAttention({ workspaceId: config.workspace_id, ownerUserId: input.ownerUserId, now: clock() });
      if ((config.paused === 1) !== input.paused) {
        service.update({ workspaceId: config.workspace_id, ownerUserId: input.ownerUserId, expectedRevision: config.revision,
          now: clock(), paused: input.paused });
      } else if (!input.paused && config.auto_paused === 1) {
        input.scheduler.updateJob(config.job_id, { enabled: true });
      }
    } catch (error) {
      failures.push(`${config.workspace_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new MetaAgentPauseError(`Could not ${input.paused ? 'pause' : 'resume'} ${failures.join('; ')}`);
}
