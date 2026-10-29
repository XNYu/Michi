/**
 * Agent tools for the calling workspace's Scheduled Jobs: list, create,
 * update, run now and delete. Registered for chat threads on every runtime
 * (MCP for Kiro/Claude/Codex/Crew, built-in tools for Pi).
 *
 * The Scheduled window's assistant conversation gets the same tools through
 * assistantScheduledJobTool (assistant/tools.ts), across the user's workspaces.
 *
 * Boundaries enforced here, independent of runtime permission modes:
 *  - In a chat thread the workspace comes from the session binding, never
 *    from tool arguments, and a job in another workspace is reported as not
 *    found. The Scheduled window names a new job's workspace, which its
 *    caller checks against the user's own rules (system, archived and
 *    AI-navigation-off workspaces are refused); every card names it.
 *  - Every change except pausing needs an explicit, single-use approval from
 *    the user. Trust/YOLO, "always allow" grants and session trust never
 *    approve it: a job runs prompts later with nobody watching, so a prompt
 *    injected into this conversation must not be able to plant one.
 *  - Agent Runs and the turn of a scheduled run itself are refused: nobody is
 *    there to approve, and a job must not create or start jobs.
 *  - Inputs go through the same validation and limits as the Scheduled page.
 */

import {
  type ChatPermissionMode,
  type ScheduledJobDto,
  type ScheduledJobRunDto,
  type ScheduledJobSchedule,
  type ScheduledJobSessionMode,
  type ScheduledJobsSchedulerStatus,
} from "michi-shared";
import { computeNextRun, systemTimeZone } from "../services/scheduledJobs/schedule";
import {
  JobValidationError,
  ScheduledJobConflictError,
  ScheduledJobNotFoundError,
  type ScheduledJobScheduler,
} from "../services/scheduledJobs/scheduler";
import type { ParsedJobFields } from "../services/scheduledJobs/validation";

import { type ScheduledJobToolName } from "./scheduledJobToolNames";

export { SCHEDULED_JOB_TOOL_NAMES, isScheduledJobToolName, type ScheduledJobToolName } from "./scheduledJobToolNames";

/** Session-bound identity of the calling thread. Never sourced from tool arguments. */
export interface ScheduledJobToolCaller {
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  isAgentRun: boolean;
}

export type ScheduledJobApprovalAction = "create" | "update" | "run" | "delete";

export interface ScheduledJobApprovalRequest {
  toolName: ScheduledJobToolName;
  action: ScheduledJobApprovalAction;
  jobName: string;
  title: string;
  /** One fact per line: schedule, permissions, thread mode, prompt preview… */
  lines: string[];
  /** Label of the approving choice ("Create", "Run now"…). */
  approveLabel: string;
}

export type ScheduledJobApprovalResult =
  | { approved: true }
  | { approved: false; reason: "declined" | "no_answer" | "unavailable"; note?: string };

export type ScheduledJobApprover = (request: ScheduledJobApprovalRequest) => Promise<ScheduledJobApprovalResult>;

export interface ScheduledJobToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

type SchedulerApi = Pick<ScheduledJobScheduler,
  | "status" | "listJobs" | "getJob" | "listRuns" | "validateCreate" | "createJob"
  | "validateUpdate" | "updateJob" | "runNow" | "deleteJob" | "requirePromptJob">;

export interface ScheduledJobToolDeps {
  scheduler: SchedulerApi;
  /** True while the given thread's current turn is a scheduled run. */
  isScheduledRunNode(nodeId: string): boolean;
  workspaceName?(workspaceId: string): string | null;
  clock?: () => number;
  timeZone?: () => string;
}

let configuredDeps: ScheduledJobToolDeps | null = null;

/** Wired once at boot (server.ts); null when scheduling is off. Tests pass deps explicitly. */
export function configureScheduledJobTools(deps: ScheduledJobToolDeps | null): void {
  configuredDeps = deps;
}

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorResult(code: string, message: string): ScheduledJobToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

function jsonResult(value: Record<string, unknown>): ScheduledJobToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(error: unknown): ScheduledJobToolResult {
  if (error instanceof ToolError) return errorResult(error.code, error.message);
  if (error instanceof JobValidationError) return errorResult("INVALID_ARGUMENT", error.message);
  if (error instanceof ScheduledJobNotFoundError) return errorResult("NOT_FOUND", error.message);
  if (error instanceof ScheduledJobConflictError) return errorResult("CONFLICT", error.message);
  throw error;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const PREVIEW_CHARS = 280;

function preview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function intervalText(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

function formatTime(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
    }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

export function describeJobSchedule(schedule: ScheduledJobSchedule, localTimeZone: string): string {
  switch (schedule.kind) {
    case "every": return `Every ${intervalText(schedule.everySeconds)}`;
    case "cron": return `Cron "${schedule.expression}" in ${schedule.timezone ?? `${localTimeZone} (this computer's time zone)`}`;
    case "at": return `Once at ${formatTime(schedule.at, localTimeZone)}`;
  }
}

const PERMISSION_TEXT: Record<ChatPermissionMode, string> = {
  ask: "Ask: tool approvals wait for you, and the run pauses until you answer",
  trust: "Trust: tools run without asking for approval",
  yolo: "YOLO: tools run without asking, with full access where the agent supports it",
};

const SESSION_TEXT: Record<ScheduledJobSessionMode, string> = {
  fresh: "a new thread for each run",
  persistent: "one thread that every run continues",
};

function minutes(seconds: number): string {
  return seconds % 60 === 0 ? plural(seconds / 60, "minute") : plural(seconds, "second");
}

// ── Agent-facing views ───────────────────────────────────────────────────────

interface Env {
  now: number;
  timeZone: string;
}

function scheduleTimeZone(schedule: ScheduledJobSchedule, env: Env): string {
  return schedule.kind === "cron" && schedule.timezone ? schedule.timezone : env.timeZone;
}

function timeView(ms: number | null, timeZone: string): { at: string; local: string } | null {
  return ms === null ? null : { at: new Date(ms).toISOString(), local: formatTime(ms, timeZone) };
}

function jobView(job: ScheduledJobDto, env: Env, full: boolean): Record<string, unknown> {
  const tz = scheduleTimeZone(job.schedule, env);
  return {
    jobId: job.id,
    name: job.name,
    state: job.activeRunId ? "running" : job.autoPaused ? "paused_after_failures" : job.enabled ? "active" : "paused",
    schedule: job.schedule,
    scheduleText: describeJobSchedule(job.schedule, env.timeZone),
    nextRun: timeView(job.nextRunAt, tz),
    lastRun: job.lastRunAt === null ? null : {
      ...timeView(job.lastRunAt, tz),
      status: job.lastStatus,
      ...(job.lastError ? { error: job.lastError } : {}),
    },
    permissionMode: job.permissionMode,
    sessionMode: job.sessionMode,
    notify: job.notify,
    timeoutSeconds: job.timeoutSeconds,
    ...(full ? { prompt: job.prompt } : { promptPreview: preview(job.prompt, 160) }),
    ...(job.runtimeId || job.modelId ? { agent: { runtimeId: job.runtimeId, modelId: job.modelId } } : {}),
  };
}

function runView(run: ScheduledJobRunDto, env: Env): Record<string, unknown> {
  return {
    runId: run.id,
    trigger: run.trigger,
    status: run.status,
    started: timeView(run.startedAt, env.timeZone),
    finished: timeView(run.finishedAt, env.timeZone),
    nodeId: run.nodeId,
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function schedulerNote(status: ScheduledJobsSchedulerStatus): string | undefined {
  if (!status.active) return "Another Michi instance on this computer schedules jobs right now; runs happen there.";
  if (!status.serviceMode) return "Jobs run only while Michi's backend is running. Turning on Settings → Background keeps it running.";
  return undefined;
}

// ── Arguments ────────────────────────────────────────────────────────────────

const EDITABLE_FIELDS = ["name", "prompt", "schedule", "sessionMode", "permissionMode", "notify", "enabled", "timeoutSeconds"] as const;
type EditableField = typeof EDITABLE_FIELDS[number];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Accept `at` as an ISO 8601 string (what models write) as well as epoch ms. */
function normalizeSchedule(value: unknown): unknown {
  const schedule = asRecord(value);
  if (schedule.kind !== "at" || typeof schedule.at !== "string") return value;
  const at = Date.parse(schedule.at);
  if (!Number.isFinite(at)) throw new ToolError("INVALID_ARGUMENT", "schedule.at must be an ISO 8601 date-time, e.g. 2026-10-17T09:00:00+09:00");
  return { kind: "at", at };
}

/** Only editable fields; workspaceId and agent profile fields are never taken from the agent. */
function pickFields(args: Record<string, unknown>): Partial<Record<EditableField, unknown>> {
  const picked: Partial<Record<EditableField, unknown>> = {};
  for (const key of EDITABLE_FIELDS) {
    if (args[key] === undefined || args[key] === null) continue;
    picked[key] = key === "schedule" ? normalizeSchedule(args[key]) : args[key];
  }
  return picked;
}

function requireJobId(args: Record<string, unknown>): string {
  const id = typeof args.jobId === "string" ? args.jobId.trim() : "";
  if (!id) throw new ToolError("INVALID_ARGUMENT", "jobId is required");
  return id;
}

// ── Caller and ownership ─────────────────────────────────────────────────────

/** A workspace the Scheduled window's agent may schedule in. */
export interface ScheduleWorkspace {
  id: string;
  name: string;
}

/** Why it may not: a tool error code ("INVALID_ARGUMENT", "NAVIGATION_DISABLED"…) and a message for the agent. */
export interface ScheduleWorkspaceRefusal {
  refused: string;
  message: string;
}

/**
 * The Scheduled window's assistant conversation. It has no workspace of its
 * own (it lives in the assistant's hidden one), so each new job names its
 * workspace and an existing job is reached through its own. Session-bound
 * like ScheduledJobToolCaller; only the workspace a job goes in comes from
 * the arguments, and `workspace` decides whether the agent may use it.
 */
export interface AssistantScheduledJobCaller {
  ownerUserId: string | null;
  nodeId: string | null;
  /**
   * The user's rules for one workspace: it exists for this owner, is not a
   * system workspace and lets AI navigate it; `create` also refuses an
   * archived one, whose existing jobs stay reachable.
   */
  workspace(workspaceId: string, use: "create" | "existing"): ScheduleWorkspace | ScheduleWorkspaceRefusal;
}

/** Which jobs a caller sees and where a new one goes. */
interface JobScope {
  nodeId: string;
  /** The checked workspace for a new job. Throws ToolError when the caller may not use it. */
  createWorkspace(args: Record<string, unknown>): { id: string; name: string | null };
  /** True for a job the caller may see and change; any other reads as missing. */
  sees(job: ScheduledJobDto): boolean;
  /** The jobs a list call returns (the assistant may name one workspace). */
  listFilter(args: Record<string, unknown>): (job: ScheduledJobDto) => boolean;
  /** Approval-card lines naming an existing job's workspace; none where the session has one. */
  workspaceLines(job: ScheduledJobDto): string[];
  /** Names each listed job's workspace (the assistant works across workspaces). */
  workspaceOf?(job: ScheduledJobDto): ScheduleWorkspace | null;
}

/** A chat thread: its own workspace, from the session binding. */
function chatScope(caller: ScheduledJobToolCaller, deps: ScheduledJobToolDeps): JobScope {
  if (caller.isAgentRun) {
    throw new ToolError("UNSUPPORTED", "scheduled jobs can be managed only from chat threads, not Agent Runs");
  }
  if (!caller.nodeId || !caller.workspaceId) {
    throw new ToolError("SOURCE_UNAVAILABLE", "this session is not yet bound to a chat thread in a workspace");
  }
  if (deps.isScheduledRunNode(caller.nodeId)) {
    throw new ToolError("UNSUPPORTED", "scheduled jobs cannot be managed from inside a scheduled run");
  }
  const workspaceId = caller.workspaceId;
  const own = (job: ScheduledJobDto) => job.workspaceId === workspaceId;
  return {
    nodeId: caller.nodeId,
    createWorkspace: () => ({ id: workspaceId, name: deps.workspaceName?.(workspaceId) ?? null }),
    sees: own,
    listFilter: () => own,
    workspaceLines: () => [],
  };
}

/** The Scheduled window: any workspace the user lets it use, named per job. */
function assistantScope(caller: AssistantScheduledJobCaller): JobScope {
  if (!caller.nodeId) {
    throw new ToolError("SOURCE_UNAVAILABLE", "this session is not yet bound to its conversation");
  }
  const resolve = (workspaceId: string, use: "create" | "existing"): ScheduleWorkspace => {
    const found = caller.workspace(workspaceId, use);
    if ("refused" in found) throw new ToolError(found.refused, found.message);
    return found;
  };
  const usable = (job: ScheduledJobDto): ScheduleWorkspace | null => {
    const found = caller.workspace(job.workspaceId, "existing");
    return "refused" in found ? null : found;
  };
  return {
    nodeId: caller.nodeId,
    createWorkspace: (args) => {
      const id = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
      if (!id) throw new ToolError("INVALID_ARGUMENT", "workspaceId is required: the workspace the job runs in, from list_workspaces");
      return resolve(id, "create");
    },
    sees: (job) => usable(job) !== null,
    listFilter: (args) => {
      const id = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
      if (!id) return (job) => usable(job) !== null;
      const workspace = resolve(id, "existing");
      return (job) => job.workspaceId === workspace.id;
    },
    workspaceLines: (job) => [`Workspace: ${resolve(job.workspaceId, "existing").name}`],
    workspaceOf: usable,
  };
}

/** A job the caller may not see is indistinguishable from a missing one. */
function ownJob(deps: ScheduledJobToolDeps, scope: JobScope, jobId: string): ScheduledJobDto {
  deps.scheduler.requirePromptJob(jobId);
  const job = deps.scheduler.getJob(jobId);
  if (!scope.sees(job)) throw new ScheduledJobNotFoundError("Scheduled job not found");
  return job;
}

// ── Approval texts ───────────────────────────────────────────────────────────

function createLines(fields: ParsedJobFields, env: Env, workspace: string | null): string[] {
  const tz = scheduleTimeZone(fields.schedule, env);
  const next = fields.enabled ? computeNextRun(fields.schedule, env.now) : null;
  return [
    ...(workspace ? [`Workspace: ${workspace}`] : []),
    `Schedule: ${describeJobSchedule(fields.schedule, env.timeZone)}`
      + (fields.enabled ? (next !== null ? `, first run ${formatTime(next, tz)}` : "") : " (starts paused)"),
    `Permissions: ${PERMISSION_TEXT[fields.permissionMode]}`,
    `Thread: ${SESSION_TEXT[fields.sessionMode]}`,
    `Notify when a run finishes: ${fields.notify ? "yes" : "no"}`,
    `Time limit per run: ${minutes(fields.timeoutSeconds)}`,
    `Prompt: “${preview(fields.prompt)}”`,
  ];
}

function updateLines(job: ScheduledJobDto, patch: Partial<ParsedJobFields>, env: Env): string[] {
  const lines: string[] = [];
  if (patch.name !== undefined) lines.push(`Name → ${patch.name}`);
  if (patch.schedule !== undefined) lines.push(`Schedule → ${describeJobSchedule(patch.schedule, env.timeZone)}`);
  if (patch.enabled !== undefined) lines.push(patch.enabled ? "Turns the job back on" : "Pauses the job");
  if (patch.permissionMode !== undefined) lines.push(`Permissions → ${PERMISSION_TEXT[patch.permissionMode]}`);
  if (patch.sessionMode !== undefined) lines.push(`Thread → ${SESSION_TEXT[patch.sessionMode]}`);
  if (patch.notify !== undefined) lines.push(`Notify when a run finishes → ${patch.notify ? "yes" : "no"}`);
  if (patch.timeoutSeconds !== undefined) lines.push(`Time limit per run → ${minutes(patch.timeoutSeconds)}`);
  if (patch.prompt !== undefined) lines.push(`Prompt → “${preview(patch.prompt)}”`);
  if (patch.permissionMode === undefined) lines.push(`Permissions (unchanged): ${PERMISSION_TEXT[job.permissionMode]}`);
  return lines;
}

function runLines(job: ScheduledJobDto): string[] {
  return [
    `Permissions: ${PERMISSION_TEXT[job.permissionMode]}`,
    `Thread: ${SESSION_TEXT[job.sessionMode]}`,
    `Prompt: “${preview(job.prompt)}”`,
  ];
}

const DELETE_LINES = ["Removes the job and its run history. Threads it already created stay."];

function declined(approval: Exclude<ScheduledJobApprovalResult, { approved: true }>, what: string): ScheduledJobToolResult {
  if (approval.reason === "unavailable") {
    return errorResult("APPROVAL_UNAVAILABLE", `this runtime cannot ask the user for approval; ${what}`);
  }
  return jsonResult({
    status: "declined",
    ...(approval.note ? { userNote: approval.note } : {}),
    next: approval.reason === "no_answer"
      ? `The user did not answer; ${what}. Do not retry unless the user asks.`
      : `The user declined; ${what}. Do not retry unless the user asks.`,
  });
}

// ── Tool entry point ─────────────────────────────────────────────────────────

export async function scheduledJobTool(
  name: ScheduledJobToolName,
  caller: ScheduledJobToolCaller,
  rawArgs: unknown,
  approve: ScheduledJobApprover,
  deps: ScheduledJobToolDeps | null = configuredDeps,
): Promise<ScheduledJobToolResult> {
  return runTool(name, (d) => chatScope(caller, d), rawArgs, approve, deps);
}

/**
 * The same tools for the Scheduled window's assistant conversation: a new
 * job names its workspace (checked by `caller.workspace`), and every approval
 * card names the job's workspace. All other boundaries are the chat
 * version's: single-use approval for every change but pausing, maintenance
 * jobs invisible, the scheduler's own validation.
 */
export async function assistantScheduledJobTool(
  name: ScheduledJobToolName,
  caller: AssistantScheduledJobCaller,
  rawArgs: unknown,
  approve: ScheduledJobApprover,
  deps: ScheduledJobToolDeps | null = configuredDeps,
): Promise<ScheduledJobToolResult> {
  return runTool(name, () => assistantScope(caller), rawArgs, approve, deps);
}

async function runTool(
  name: ScheduledJobToolName,
  scopeOf: (deps: ScheduledJobToolDeps) => JobScope,
  rawArgs: unknown,
  approve: ScheduledJobApprover,
  deps: ScheduledJobToolDeps | null,
): Promise<ScheduledJobToolResult> {
  if (!deps) return errorResult("UNAVAILABLE", "scheduled jobs are not available on this server");
  const args = asRecord(rawArgs);
  const env: Env = { now: (deps.clock ?? Date.now)(), timeZone: (deps.timeZone ?? systemTimeZone)() };
  try {
    const scope = scopeOf(deps);
    switch (name) {
      case "list_scheduled_jobs": return listJobs(deps, scope, args, env);
      case "create_scheduled_job": return await createJob(deps, scope, args, env, approve);
      case "update_scheduled_job": return await updateJob(deps, scope, args, env, approve);
      case "run_scheduled_job": return await runJob(deps, scope, args, approve);
      case "delete_scheduled_job": return await deleteJob(deps, scope, args, approve);
    }
  } catch (error) {
    return toolError(error);
  }
}

/** A job as the agent sees it; across workspaces, with the workspace it belongs to. */
function scopedJobView(scope: JobScope, job: ScheduledJobDto, env: Env, full: boolean): Record<string, unknown> {
  const workspace = scope.workspaceOf?.(job);
  return { ...jobView(job, env, full), ...(workspace ? { workspace } : {}) };
}

function listJobs(deps: ScheduledJobToolDeps, scope: JobScope, args: Record<string, unknown>, env: Env): ScheduledJobToolResult {
  const status = deps.scheduler.status();
  const note = schedulerNote(status);
  if (typeof args.jobId === "string" && args.jobId.trim()) {
    const job = ownJob(deps, scope, args.jobId.trim());
    const runs = deps.scheduler.listRuns(job.id).slice(0, 10).map((run) => runView(run, env));
    return jsonResult({ job: scopedJobView(scope, job, env, true), recentRuns: runs, ...(note ? { note } : {}) });
  }
  const jobs = deps.scheduler.listJobs().filter(scope.listFilter(args));
  return jsonResult({
    timeZone: env.timeZone,
    count: jobs.length,
    jobs: jobs.map((job) => scopedJobView(scope, job, env, false)),
    ...(note ? { note } : {}),
    next: jobs.length > 0 ? "Pass jobId to see one job's full prompt and recent runs." : undefined,
  });
}

async function createJob(
  deps: ScheduledJobToolDeps, scope: JobScope, args: Record<string, unknown>, env: Env, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const workspace = scope.createWorkspace(args);
  const input = { ...pickFields(args), workspaceId: workspace.id };
  // Validate first so the user is never asked to approve something invalid,
  // and so the card shows the saved values (defaults applied).
  const fields = deps.scheduler.validateCreate(input);
  const approval = await approve({
    toolName: "create_scheduled_job",
    action: "create",
    jobName: fields.name,
    title: `Create scheduled job “${fields.name}”?`,
    lines: createLines(fields, env, workspace.name),
    approveLabel: "Create",
  });
  if (!approval.approved) return declined(approval, "no job was created");
  // The approval may have waited minutes: the workspace must still take jobs from this caller.
  scope.createWorkspace(args);
  const job = deps.scheduler.createJob(input);
  const note = schedulerNote(deps.scheduler.status());
  return jsonResult({ status: "created", job: scopedJobView(scope, job, env, false), ...(note ? { note } : {}) });
}

async function updateJob(
  deps: ScheduledJobToolDeps, scope: JobScope, args: Record<string, unknown>, env: Env, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, scope, jobId);
  const patch = pickFields(args);
  if (Object.keys(patch).length === 0) throw new ToolError("INVALID_ARGUMENT", "pass at least one field to change");
  const changed = deps.scheduler.validateUpdate(job.id, patch);
  const keys = Object.keys(changed);
  if (keys.length === 0) return jsonResult({ status: "unchanged", job: scopedJobView(scope, job, env, false) });
  // Pausing only reduces what runs unattended, so it needs no approval.
  const pauseOnly = keys.length === 1 && changed.enabled === false;
  if (!pauseOnly) {
    const approval = await approve({
      toolName: "update_scheduled_job",
      action: "update",
      jobName: job.name,
      title: `Change scheduled job “${job.name}”?`,
      lines: [...scope.workspaceLines(job), ...updateLines(job, changed, env)],
      approveLabel: "Save changes",
    });
    if (!approval.approved) return declined(approval, "the job was not changed");
    // The approval may have waited minutes: the job must still be ours.
    ownJob(deps, scope, jobId);
  }
  const updated = deps.scheduler.updateJob(job.id, changed);
  return jsonResult({ status: pauseOnly ? "paused" : "updated", job: scopedJobView(scope, updated, env, false) });
}

async function runJob(
  deps: ScheduledJobToolDeps, scope: JobScope, args: Record<string, unknown>, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, scope, jobId);
  if (job.activeRunId) throw new ScheduledJobConflictError("This job is already running");
  const approval = await approve({
    toolName: "run_scheduled_job",
    action: "run",
    jobName: job.name,
    title: `Run scheduled job “${job.name}” now?`,
    lines: [...scope.workspaceLines(job), ...runLines(job)],
    approveLabel: "Run now",
  });
  if (!approval.approved) return declined(approval, "nothing was started");
  ownJob(deps, scope, jobId);
  const run = await deps.scheduler.runNow(jobId);
  return jsonResult({
    status: "started",
    runId: run.id,
    next: "The run opens its own thread in the job's workspace. Call list_scheduled_jobs with this jobId later to see its result; do not wait in a loop.",
  });
}

async function deleteJob(
  deps: ScheduledJobToolDeps, scope: JobScope, args: Record<string, unknown>, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, scope, jobId);
  const approval = await approve({
    toolName: "delete_scheduled_job",
    action: "delete",
    jobName: job.name,
    title: `Delete scheduled job “${job.name}”?`,
    lines: [...scope.workspaceLines(job), ...DELETE_LINES],
    approveLabel: "Delete",
  });
  if (!approval.approved) return declined(approval, "the job was not deleted");
  ownJob(deps, scope, jobId);
  deps.scheduler.deleteJob(jobId);
  return jsonResult({ status: "deleted", jobId });
}

// ── Approvers ────────────────────────────────────────────────────────────────

const DECLINE_LABEL = "Cancel";

type AskUser = (questions: Array<{
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}>) => Promise<Record<string, string> | null>;

/**
 * Approval through the runtime's Michi-owned ask_user channel (Kiro, Claude,
 * Codex, Crew). Only the exact approve option counts; any other answer,
 * including a typed one, is a decline passed back as the user's note.
 */
export function askUserScheduledJobApprover(askUser: AskUser | undefined): ScheduledJobApprover {
  return async (request) => {
    if (!askUser) return { approved: false, reason: "unavailable" };
    const question = `${request.title}\n${request.lines.join("\n")}`;
    const answers = await askUser([{
      question,
      header: "Schedule",
      options: [
        { label: request.approveLabel, description: "Allow this one change. Agents never get standing permission for scheduled jobs." },
        { label: DECLINE_LABEL, description: "Nothing changes; the agent is told you declined." },
      ],
      multiSelect: false,
    }]);
    if (!answers) return { approved: false, reason: "no_answer" };
    const answer = (answers[question] ?? Object.values(answers)[0] ?? "").trim();
    if (answer === request.approveLabel) return { approved: true };
    if (!answer || answer === DECLINE_LABEL) return { approved: false, reason: "declined" };
    return { approved: false, reason: "declined", note: answer.slice(0, 500) };
  };
}

/** Title and detail for single-use permission prompts (Pi). */
export function scheduledJobApprovalPrompt(request: ScheduledJobApprovalRequest): { title: string; detail: string } {
  return { title: request.title, detail: request.lines.join("\n") };
}
