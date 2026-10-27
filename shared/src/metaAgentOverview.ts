/**
 * The Meta agent's background maintenance at a glance, for Scheduled › Meta agent.
 * Read-only and computed from the maintenance configs, plans, receipts, runs and
 * first-run progress; nothing here is stored.
 *
 * Backend: GET /api/meta-agent/overview, POST /api/meta-agent/pause, POST /api/meta-agent/resume
 * (both POSTs answer with the overview). Local-only, like GET /api/meta-agent.
 */

import type { MetaAgentResolvedRuntime } from './metaAgent';

export type MetaAgentOverviewState = 'running' | 'paused' | 'error';

/**
 * Why background maintenance cannot go on. `runtime-unsupported`: the Meta
 * agent does not run on the chosen runtime; `restriction-check`: the runtime
 * started with tools outside the Meta agent's list; `runtime-missing`: its CLI
 * is not installed; `signed-out`: it is not signed in or has no API key;
 * `quota`: a usage or rate limit; `needs-attention`: a batch of conversations
 * could not be read; `other`: anything else, with the error's first line.
 */
export type MetaAgentStopReason =
  | 'runtime-unsupported' | 'restriction-check' | 'runtime-missing' | 'signed-out' | 'quota' | 'needs-attention' | 'other';

/** Background maintenance stopped by errors, as opposed to paused by the user. */
export interface MetaAgentStop {
  reason: MetaAgentStopReason;
  /** One plain sentence for people, e.g. "Codex is not installed on this computer". */
  message: string;
  /** The first line of the error as it was reported, when it says more than `message`. */
  detail?: string;
  /** The workspaces it stopped; empty when it holds every workspace. */
  workspaceIds: string[];
}

/**
 * Why background maintenance does not run at all on this backend, whatever
 * `state` says. `scheduler-off`: scheduled jobs are off there
 * (MICHI_SCHEDULED_JOBS=0), so no maintenance job ever starts.
 */
export interface MetaAgentNotRunning {
  reason: 'scheduler-off';
  /** One plain sentence for people. */
  message: string;
}

/** One workspace's maintenance cursor. */
export interface MetaAgentCursorRow {
  workspaceId: string;
  workspaceName: string;
  /** The completion_seq read through. */
  cursor: number;
  /** The workspace counter minus the cursor. */
  unread: number;
  /** When the cursor last moved; null when it never has. */
  lastRunAt: number | null;
  /** synced: read up to the counter; next: the next run reads `unread`; no-new: nothing completed since maintenance began. */
  state: 'synced' | 'next' | 'no-new' | 'error';
  error?: string;
  /** With state `error`: the same error in plain words, and whether runs stopped (true) or keep retrying (false). */
  problem?: { reason: MetaAgentStopReason; message: string; stopped: boolean };
}

/** One row of the recent-runs list. Consecutive checks that found nothing new are merged into one row. */
export interface MetaAgentRecentRun {
  /** Latest time in the row. */
  at: number;
  /** Earliest time in a merged row; equals `at` otherwise. */
  since: number;
  /** Null when the row covers several workspaces. */
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceCount: number;
  /** completion_seq range read; null for first-run, summary and merged rows. */
  after: number | null;
  through: number | null;
  /** Conversation turns read (first-run: historical conversations to read). */
  turns: number;
  routedPages: number;
  /** Titles of the routed pages and databases, at most five. */
  routedPageTitles: string[];
  writes: number;
  proposals: number;
  /** Where the cursor moved to; null when it did not move. */
  cursorTo: number | null;
  noModelCall: boolean;
  /** `summary`: the Spaces Home rewritten from the workspace homes, over every workspace (`workspaceId` null). */
  kind: 'incremental' | 'first-run' | 'summary';
  /** Checks merged into this row; 1 for a single run. */
  count: number;
  state: 'done' | 'running' | 'attention' | 'failed';
  error?: string;
  /** first-run rows: the days of history read (the widest when workspaces were queued with different ranges). */
  firstRunDays?: number;
  /** summary rows: the workspaces whose homes changed since the summary before, by name; `workspaceCount` counts them. */
  changedHomes?: string[];
  /** summary rows: the titles of the Spaces Home blocks it wrote, at most five. */
  rewroteBlocks?: string[];
  /**
   * The maintenance conversation the run read in, in `workspaceId`; null for
   * merged, first-run and summary rows and for a run that opened none. Absent from an older backend.
   */
  nodeId?: string | null;
}

export interface MetaAgentTodayMetrics {
  checks: number;
  /** True when run history was pruned since local midnight, so `checks` is a lower bound. */
  checksTruncated: boolean;
  modelCalls: number;
  writes: number;
  pendingProposals: number;
}

export interface MetaAgentOverview {
  state: MetaAgentOverviewState;
  /** With state `error`: `stopped.message`. */
  error?: string;
  /** Set with state `error`; absent from an older backend. A paused Meta agent is not stopped. */
  stopped?: MetaAgentStop | null;
  /** Set when nothing can run on this backend; absent from an older backend. */
  notRunning?: MetaAgentNotRunning | null;
  runtime: MetaAgentResolvedRuntime;
  today: MetaAgentTodayMetrics;
  cursors: MetaAgentCursorRow[];
  recentRuns: MetaAgentRecentRun[];
  /** Every managed maintenance job of the owner's, enabled or not; the Scheduled list shows them as this one system task. */
  managedJobIds?: string[];
}

/**
 * One Meta agent round started now instead of on the next 60-second tick
 * (the Spaces Home's Update button). Every maintained workspace reads one
 * bounded page of new conversations through its managed maintenance job.
 *
 * Backend: POST /api/meta-agent/run-now -> MetaAgentRunNowResponse
 *          GET  /api/meta-agent/run-now -> MetaAgentRoundStatus (poll until no workspace is running)
 * Unlike the routes above these are served by every backend that runs
 * scheduled jobs, remote ones included; without scheduled jobs they answer 503.
 */
export type MetaAgentRunNowOutcome = 'started' | 'no_new' | 'skipped';

/** paused: this workspace's maintenance is paused; guard_hold: the runtime failed its restriction check; unsupported_runtime: the Meta agent cannot run on it; stopped: the job stopped itself after repeated failures; unavailable: the scheduler refused to start it. */
export type MetaAgentRunNowSkip = 'paused' | 'guard_hold' | 'unsupported_runtime' | 'stopped' | 'unavailable';

export interface MetaAgentRunNowWorkspace {
  workspaceId: string;
  workspaceName: string;
  outcome: MetaAgentRunNowOutcome;
  /** Set only when skipped. */
  skip?: MetaAgentRunNowSkip;
  /** Why it was skipped, or that a started read waits for a free run slot or was already under way. */
  reason?: string;
  /** Set only when started: the run reading this workspace, null while it waits for a free run slot. */
  runId?: string | null;
  /** The completion_seq read through when the round was asked for. */
  cursor: number;
  unread: number;
}

export interface MetaAgentRunNowResponse {
  workspaces: MetaAgentRunNowWorkspace[];
}

export interface MetaAgentRoundWorkspace {
  workspaceId: string;
  cursor: number;
  unread: number;
  /** A run is reading this workspace now, or is due to start in a free run slot. */
  running: boolean;
}

export interface MetaAgentRoundStatus {
  workspaces: MetaAgentRoundWorkspace[];
}
