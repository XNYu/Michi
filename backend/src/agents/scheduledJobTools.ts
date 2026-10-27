/**
 * Agent tools for the calling workspace's Scheduled Jobs: list, create,
 * update, run now and delete. Registered for chat threads on every runtime
 * (MCP for Kiro/Claude/Codex/Crew, built-in tools for Pi).
 *
 * Boundaries enforced here, independent of runtime permission modes:
 *  - The workspace comes from the session binding, never from tool
 *    arguments, and a job in another workspace is reported as not found.
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
  | "validateUpdate" | "updateJob" | "runNow" | "deleteJob">;

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

interface ResolvedCaller {
  workspaceId: string;
  nodeId: string;
}

function resolveCaller(caller: ScheduledJobToolCaller, deps: ScheduledJobToolDeps): ResolvedCaller {
  if (caller.isAgentRun) {
    throw new ToolError("UNSUPPORTED", "scheduled jobs can be managed only from chat threads, not Agent Runs");
  }
  if (!caller.nodeId || !caller.workspaceId) {
    throw new ToolError("SOURCE_UNAVAILABLE", "this session is not yet bound to a chat thread in a workspace");
  }
  if (deps.isScheduledRunNode(caller.nodeId)) {
    throw new ToolError("UNSUPPORTED", "scheduled jobs cannot be managed from inside a scheduled run");
  }
  return { workspaceId: caller.workspaceId, nodeId: caller.nodeId };
}

/** A job in another workspace is indistinguishable from a missing one. */
function ownJob(deps: ScheduledJobToolDeps, workspaceId: string, jobId: string): ScheduledJobDto {
  const job = deps.scheduler.getJob(jobId);
  if (job.workspaceId !== workspaceId) throw new ScheduledJobNotFoundError("Scheduled job not found");
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
  if (!deps) return errorResult("UNAVAILABLE", "scheduled jobs are not available on this server");
  const args = asRecord(rawArgs);
  const env: Env = { now: (deps.clock ?? Date.now)(), timeZone: (deps.timeZone ?? systemTimeZone)() };
  try {
    const owner = resolveCaller(caller, deps);
    switch (name) {
      case "list_scheduled_jobs": return listJobs(deps, owner, args, env);
      case "create_scheduled_job": return await createJob(deps, owner, args, env, approve);
      case "update_scheduled_job": return await updateJob(deps, owner, args, env, approve);
      case "run_scheduled_job": return await runJob(deps, owner, args, approve);
      case "delete_scheduled_job": return await deleteJob(deps, owner, args, approve);
    }
  } catch (error) {
    return toolError(error);
  }
}

function listJobs(deps: ScheduledJobToolDeps, owner: ResolvedCaller, args: Record<string, unknown>, env: Env): ScheduledJobToolResult {
  const status = deps.scheduler.status();
  const note = schedulerNote(status);
  if (typeof args.jobId === "string" && args.jobId.trim()) {
    const job = ownJob(deps, owner.workspaceId, args.jobId.trim());
    const runs = deps.scheduler.listRuns(job.id).slice(0, 10).map((run) => runView(run, env));
    return jsonResult({ job: jobView(job, env, true), recentRuns: runs, ...(note ? { note } : {}) });
  }
  const jobs = deps.scheduler.listJobs().filter((job) => job.workspaceId === owner.workspaceId);
  return jsonResult({
    timeZone: env.timeZone,
    count: jobs.length,
    jobs: jobs.map((job) => jobView(job, env, false)),
    ...(note ? { note } : {}),
    next: jobs.length > 0 ? "Pass jobId to see one job's full prompt and recent runs." : undefined,
  });
}

async function createJob(
  deps: ScheduledJobToolDeps, owner: ResolvedCaller, args: Record<string, unknown>, env: Env, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const input = { ...pickFields(args), workspaceId: owner.workspaceId };
  // Validate first so the user is never asked to approve something invalid,
  // and so the card shows the saved values (defaults applied).
  const fields = deps.scheduler.validateCreate(input);
  const approval = await approve({
    toolName: "create_scheduled_job",
    action: "create",
    jobName: fields.name,
    title: `Create scheduled job “${fields.name}”?`,
    lines: createLines(fields, env, deps.workspaceName?.(owner.workspaceId) ?? null),
    approveLabel: "Create",
  });
  if (!approval.approved) return declined(approval, "no job was created");
  const job = deps.scheduler.createJob(input);
  const note = schedulerNote(deps.scheduler.status());
  return jsonResult({ status: "created", job: jobView(job, env, false), ...(note ? { note } : {}) });
}

async function updateJob(
  deps: ScheduledJobToolDeps, owner: ResolvedCaller, args: Record<string, unknown>, env: Env, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, owner.workspaceId, jobId);
  const patch = pickFields(args);
  if (Object.keys(patch).length === 0) throw new ToolError("INVALID_ARGUMENT", "pass at least one field to change");
  const changed = deps.scheduler.validateUpdate(job.id, patch);
  const keys = Object.keys(changed);
  if (keys.length === 0) return jsonResult({ status: "unchanged", job: jobView(job, env, false) });
  // Pausing only reduces what runs unattended, so it needs no approval.
  const pauseOnly = keys.length === 1 && changed.enabled === false;
  if (!pauseOnly) {
    const approval = await approve({
      toolName: "update_scheduled_job",
      action: "update",
      jobName: job.name,
      title: `Change scheduled job “${job.name}”?`,
      lines: updateLines(job, changed, env),
      approveLabel: "Save changes",
    });
    if (!approval.approved) return declined(approval, "the job was not changed");
    // The approval may have waited minutes: the job must still be ours.
    ownJob(deps, owner.workspaceId, jobId);
  }
  const updated = deps.scheduler.updateJob(job.id, changed);
  return jsonResult({ status: pauseOnly ? "paused" : "updated", job: jobView(updated, env, false) });
}

async function runJob(
  deps: ScheduledJobToolDeps, owner: ResolvedCaller, args: Record<string, unknown>, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, owner.workspaceId, jobId);
  if (job.activeRunId) throw new ScheduledJobConflictError("This job is already running");
  const approval = await approve({
    toolName: "run_scheduled_job",
    action: "run",
    jobName: job.name,
    title: `Run scheduled job “${job.name}” now?`,
    lines: runLines(job),
    approveLabel: "Run now",
  });
  if (!approval.approved) return declined(approval, "nothing was started");
  ownJob(deps, owner.workspaceId, jobId);
  const run = await deps.scheduler.runNow(jobId);
  return jsonResult({
    status: "started",
    runId: run.id,
    next: "The run opens its own thread in this workspace. Call list_scheduled_jobs with this jobId later to see its result; do not wait in a loop.",
  });
}

async function deleteJob(
  deps: ScheduledJobToolDeps, owner: ResolvedCaller, args: Record<string, unknown>, approve: ScheduledJobApprover,
): Promise<ScheduledJobToolResult> {
  const jobId = requireJobId(args);
  const job = ownJob(deps, owner.workspaceId, jobId);
  const approval = await approve({
    toolName: "delete_scheduled_job",
    action: "delete",
    jobName: job.name,
    title: `Delete scheduled job “${job.name}”?`,
    lines: DELETE_LINES,
    approveLabel: "Delete",
  });
  if (!approval.approved) return declined(approval, "the job was not deleted");
  ownJob(deps, owner.workspaceId, jobId);
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
