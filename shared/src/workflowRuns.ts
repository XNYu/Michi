/**
 * Workflow runs: long-running, multi-agent workflows an agent launches in the
 * background (Claude Code dynamic Workflows, Kiro CLI `_kiro/workflow/*`).
 *
 * They never enter the chat turn queue. The backend folds each runtime's
 * native events into one `WorkflowRunDtoV1` snapshot, persists it and pushes
 * the whole snapshot on every change (`revision` orders them), so clients
 * keep the newest revision and need no event replay.
 */

import { parseSubagentEnds, type SubagentEnd } from "./subagents";

export type WorkflowRuntime = "claude" | "kiro";
export type WorkflowRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type WorkflowNodeStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "skipped";
/** phase/agent: Claude. step/parallel/loop/…: Kiro node types. */
export type WorkflowNodeKind = "phase" | "agent" | "step" | "parallel" | "loop" | "branch" | "group";
export type WorkflowAction = "stop" | "pause" | "resume" | "retry";

export interface WorkflowUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface WorkflowNodeDto {
  id: string;
  /** Containing node (Claude phase, Kiro parallel/loop). */
  parentId?: string;
  kind: WorkflowNodeKind;
  title: string;
  status: WorkflowNodeStatus;
  agentName?: string;
  model?: string;
  iteration?: number;
  attempt?: number;
  /** What the node's agent was asked (preview). */
  prompt?: string;
  /** Latest in-flight tool or step message. */
  currentTool?: string;
  /** Latest progress line (Kiro step send_message). */
  statusMessage?: string;
  /** What the node returned (captured output / result preview). */
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: WorkflowUsage;
  /** Tool calls the node's agent made, when the runtime reports them. */
  toolCount?: number;
}

/** A tool approval a workflow step is waiting on. */
export interface WorkflowApprovalOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface WorkflowApprovalDto {
  id: string;
  /** The step/agent that asked, when the runtime says. */
  nodeId?: string;
  /**
   * `session`: the runtime does not say who asked (Claude background work
   * while the chat is idle). The request shows on every running workflow of
   * the chat; answering it on one answers it on all.
   */
  scope?: 'session';
  title: string;
  detail?: string;
  options: WorkflowApprovalOption[];
  requestedAt: number;
}

export interface WorkflowLogEntry {
  at: number;
  text: string;
  nodeId?: string;
  severity?: "info" | "success" | "warning" | "error";
}

export interface WorkflowRunDtoV1 {
  version: 1;
  /** Michi id: stable per runtime + native id. */
  id: string;
  runtime: WorkflowRuntime;
  /** Claude task id / Kiro workflow id. */
  nativeId: string;
  workspaceId: string;
  /** Chat node whose agent launched the run. */
  nodeId: string | null;
  /** The launching tool call (Claude `Workflow`, Kiro `Run Workflow`). */
  parentToolCallId: string | null;
  name: string;
  description?: string;
  /** Claude workflow script / Kiro inputs (JSON), truncated. */
  definition?: string;
  status: WorkflowRunStatus;
  /** Pause reason, failure reason or the runtime's own status line. */
  statusDetail?: string;
  /** The run's final report. */
  result?: string;
  nodes: WorkflowNodeDto[];
  /** Step messages and notable transitions, newest last. */
  log: WorkflowLogEntry[];
  usage?: WorkflowUsage;
  /** Controls the runtime accepts for this run right now. */
  actions: WorkflowAction[];
  /** Tool approvals steps are waiting on; answered through the run. */
  approvals?: WorkflowApprovalDto[];
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  /** Increments on every change; clients keep the highest. */
  revision: number;
  /**
   * Detail was trimmed for a bulk snapshot; `GET /workflow-runs/:id` has the
   * full run at the same revision, which clients prefer.
   */
  partial?: true;
}

/**
 * Background subagents a live agent process still tracks, per chat node:
 * running after their turn ended, or finished and not yet reported by a
 * turn. A persisted background entry without an outcome that is missing
 * here ran in a process that has ended (restart, Stop, model switch,
 * crash, session release), so its completion will never arrive.
 */
export interface BackgroundSubagentsUpdateV1 {
  /**
   * The subscription's first update: `nodes` lists every node that has
   * any; nodes it omits have none. Later updates change only the nodes
   * they name.
   */
  snapshot: boolean;
  /** Node id → subagent session ids; an empty list means none. */
  nodes: Record<string, string[]>;
}

export const BACKGROUND_SUBAGENT_LIMITS = {
  nodes: 500,
  idsPerNode: 100,
  idLength: 200,
} as const;

/**
 * Background subagents of one chat node that ended without a turn
 * reporting them: the agent process that ran them ended first, or they
 * finished while idle and that process ended before a turn reported it.
 * The backend has already recorded each end on the node's stored rosters
 * (endBackgroundSubagents); clients apply the same to the node they hold.
 */
export interface BackgroundSubagentsEndedV1 {
  nodeId: string;
  subagents: SubagentEnd[];
}

/**
 * The workflow-runs feed also carries `background_subagents` and
 * `background_subagents_ended` (backends from before them never send
 * them; old clients ignore them).
 */
export interface WorkflowRunSseEnvelopeV1 {
  version: 1;
  event: "workflow_run" | "heartbeat" | "background_subagents" | "background_subagents_ended";
  run: WorkflowRunDtoV1 | null;
  backgroundSubagents?: BackgroundSubagentsUpdateV1;
  backgroundSubagentsEnded?: BackgroundSubagentsEndedV1;
  emittedAt: number;
}

export const WORKFLOW_LIMITS = {
  nodes: 200,
  log: 80,
  definition: 12_000,
  prompt: 4_000,
  result: 8_000,
  error: 2_000,
  title: 300,
  line: 400,
  approvals: 20,
  /** Serialized snapshot budget; larger runs drop node detail first. */
  snapshotBytes: 256_000,
} as const;

export const WORKFLOW_TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(["completed", "failed", "cancelled"]);

export function isWorkflowRunTerminal(status: WorkflowRunStatus): boolean {
  return WORKFLOW_TERMINAL_STATUSES.has(status);
}

/** Still driven by a runtime (running or paused): it may wait on the user. */
export function isWorkflowRunOpen(run: Pick<WorkflowRunDtoV1, "status">): boolean {
  return !isWorkflowRunTerminal(run.status);
}

export function clampWorkflowText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

// ---- Parsing (untrusted JSON from the network or the database) ----------

const RUN_STATUSES = new Set<WorkflowRunStatus>(["running", "paused", "completed", "failed", "cancelled"]);
const NODE_STATUSES = new Set<WorkflowNodeStatus>(["queued", "running", "paused", "completed", "failed", "cancelled", "skipped"]);
const NODE_KINDS = new Set<WorkflowNodeKind>(["phase", "agent", "step", "parallel", "loop", "branch", "group"]);
const ACTIONS = new Set<WorkflowAction>(["stop", "pause", "resume", "retry"]);
const SEVERITIES = new Set(["info", "success", "warning", "error"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): WorkflowUsage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const usage: WorkflowUsage = {};
  if (num(raw.totalTokens) !== undefined) usage.totalTokens = num(raw.totalTokens);
  if (num(raw.toolUses) !== undefined) usage.toolUses = num(raw.toolUses);
  if (num(raw.durationMs) !== undefined) usage.durationMs = num(raw.durationMs);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseNode(value: unknown): WorkflowNodeDto | null {
  const raw = record(value);
  const id = str(raw?.id);
  if (!raw || !id) return null;
  const node: WorkflowNodeDto = {
    id,
    kind: NODE_KINDS.has(raw.kind as WorkflowNodeKind) ? raw.kind as WorkflowNodeKind : "step",
    title: clampWorkflowText(raw.title, WORKFLOW_LIMITS.title) ?? id,
    status: NODE_STATUSES.has(raw.status as WorkflowNodeStatus) ? raw.status as WorkflowNodeStatus : "queued",
  };
  if (str(raw.parentId)) node.parentId = str(raw.parentId);
  for (const key of ["agentName", "model"] as const) {
    const text = clampWorkflowText(raw[key], WORKFLOW_LIMITS.title);
    if (text) node[key] = text;
  }
  for (const key of ["currentTool", "statusMessage"] as const) {
    const text = clampWorkflowText(raw[key], WORKFLOW_LIMITS.line);
    if (text) node[key] = text;
  }
  const prompt = clampWorkflowText(raw.prompt, WORKFLOW_LIMITS.prompt);
  if (prompt) node.prompt = prompt;
  const result = clampWorkflowText(raw.result, WORKFLOW_LIMITS.result);
  if (result) node.result = result;
  const error = clampWorkflowText(raw.error, WORKFLOW_LIMITS.error);
  if (error) node.error = error;
  for (const key of ["iteration", "attempt", "startedAt", "endedAt", "toolCount"] as const) {
    if (num(raw[key]) !== undefined) node[key] = num(raw[key]);
  }
  const usage = parseUsage(raw.usage);
  if (usage) node.usage = usage;
  return node;
}

function parseLog(value: unknown): WorkflowLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkflowLogEntry[] => {
    const raw = record(item);
    const text = clampWorkflowText(raw?.text, WORKFLOW_LIMITS.line);
    const at = num(raw?.at);
    if (!raw || !text || at === undefined) return [];
    return [{
      at,
      text,
      ...(str(raw.nodeId) ? { nodeId: str(raw.nodeId) } : {}),
      ...(SEVERITIES.has(raw.severity as string) ? { severity: raw.severity as WorkflowLogEntry["severity"] } : {}),
    }];
  }).slice(-WORKFLOW_LIMITS.log);
}

function parseApprovals(value: unknown): WorkflowApprovalDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkflowApprovalDto[] => {
    const raw = record(item);
    const id = str(raw?.id);
    const requestedAt = num(raw?.requestedAt);
    if (!raw || !id || requestedAt === undefined || !Array.isArray(raw.options)) return [];
    const options = raw.options.flatMap((option): WorkflowApprovalOption[] => {
      const o = record(option);
      const optionId = str(o?.optionId);
      if (!o || !optionId) return [];
      return [{ optionId, name: clampWorkflowText(o.name, WORKFLOW_LIMITS.title) ?? optionId, ...(str(o.kind) ? { kind: str(o.kind) } : {}) }];
    });
    if (options.length === 0) return [];
    return [{
      id,
      title: clampWorkflowText(raw.title, WORKFLOW_LIMITS.title) ?? 'Approve tool use?',
      options,
      requestedAt,
      ...(str(raw.nodeId) ? { nodeId: str(raw.nodeId) } : {}),
      ...(raw.scope === 'session' ? { scope: 'session' as const } : {}),
      ...(clampWorkflowText(raw.detail, WORKFLOW_LIMITS.prompt) ? { detail: clampWorkflowText(raw.detail, WORKFLOW_LIMITS.prompt) } : {}),
    }];
  }).slice(0, WORKFLOW_LIMITS.approvals);
}

/** Validate an untrusted run snapshot; null when unusable. */
export function parseWorkflowRunDto(value: unknown): WorkflowRunDtoV1 | null {
  const raw = record(value);
  if (!raw || raw.version !== 1) return null;
  const id = str(raw.id);
  const nativeId = str(raw.nativeId);
  const workspaceId = str(raw.workspaceId);
  const runtime = raw.runtime === "claude" || raw.runtime === "kiro" ? raw.runtime : null;
  const startedAt = num(raw.startedAt);
  if (!id || !nativeId || !workspaceId || !runtime || startedAt === undefined) return null;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.flatMap((item) => { const node = parseNode(item); return node ? [node] : []; }).slice(0, WORKFLOW_LIMITS.nodes)
    : [];
  const run: WorkflowRunDtoV1 = {
    version: 1,
    id,
    runtime,
    nativeId,
    workspaceId,
    nodeId: str(raw.nodeId) ?? null,
    parentToolCallId: str(raw.parentToolCallId) ?? null,
    name: clampWorkflowText(raw.name, WORKFLOW_LIMITS.title) ?? "Workflow",
    status: RUN_STATUSES.has(raw.status as WorkflowRunStatus) ? raw.status as WorkflowRunStatus : "running",
    nodes,
    log: parseLog(raw.log),
    actions: Array.isArray(raw.actions) ? raw.actions.filter((action): action is WorkflowAction => ACTIONS.has(action as WorkflowAction)) : [],
    startedAt,
    updatedAt: num(raw.updatedAt) ?? startedAt,
    revision: num(raw.revision) ?? 0,
  };
  const description = clampWorkflowText(raw.description, WORKFLOW_LIMITS.line);
  if (description) run.description = description;
  const definition = clampWorkflowText(raw.definition, WORKFLOW_LIMITS.definition);
  if (definition) run.definition = definition;
  const statusDetail = clampWorkflowText(raw.statusDetail, WORKFLOW_LIMITS.line);
  if (statusDetail) run.statusDetail = statusDetail;
  const result = clampWorkflowText(raw.result, WORKFLOW_LIMITS.result);
  if (result) run.result = result;
  const usage = parseUsage(raw.usage);
  if (usage) run.usage = usage;
  if (num(raw.endedAt) !== undefined) run.endedAt = num(raw.endedAt);
  const approvals = parseApprovals(raw.approvals);
  if (approvals.length > 0) run.approvals = approvals;
  if (raw.partial === true) run.partial = true;
  return run;
}

/** Null when malformed; ids and nodes beyond BACKGROUND_SUBAGENT_LIMITS are dropped. */
export function parseBackgroundSubagentsUpdate(value: unknown): BackgroundSubagentsUpdateV1 | null {
  const raw = record(value);
  const nodes = record(raw?.nodes);
  if (!raw || !nodes || typeof raw.snapshot !== "boolean") return null;
  const valid = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= BACKGROUND_SUBAGENT_LIMITS.idLength;
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const [nodeId, ids] of Object.entries(nodes)) {
    if (count >= BACKGROUND_SUBAGENT_LIMITS.nodes) break;
    if (!valid(nodeId) || !Array.isArray(ids)) continue;
    out[nodeId] = [...new Set(ids.filter(valid))].slice(0, BACKGROUND_SUBAGENT_LIMITS.idsPerNode);
    count += 1;
  }
  return { snapshot: raw.snapshot, nodes: out };
}

/** Null when malformed or empty; ends beyond SUBAGENT_END_LIMITS are dropped. */
export function parseBackgroundSubagentsEnded(value: unknown): BackgroundSubagentsEndedV1 | null {
  const raw = record(value);
  const nodeId = str(raw?.nodeId);
  if (!raw || !nodeId || nodeId.length > BACKGROUND_SUBAGENT_LIMITS.idLength) return null;
  const subagents = Array.isArray(raw.subagents) ? parseSubagentEnds(raw.subagents) : [];
  return subagents.length > 0 ? { nodeId, subagents } : null;
}

export function parseWorkflowRunSseEnvelope(value: unknown): WorkflowRunSseEnvelopeV1 | null {
  const raw = record(value);
  if (!raw || raw.version !== 1) return null;
  if (raw.event === "heartbeat") return { version: 1, event: "heartbeat", run: null, emittedAt: num(raw.emittedAt) ?? Date.now() };
  if (raw.event === "background_subagents") {
    const backgroundSubagents = parseBackgroundSubagentsUpdate(raw.backgroundSubagents);
    return backgroundSubagents
      ? { version: 1, event: "background_subagents", run: null, backgroundSubagents, emittedAt: num(raw.emittedAt) ?? Date.now() }
      : null;
  }
  if (raw.event === "background_subagents_ended") {
    const backgroundSubagentsEnded = parseBackgroundSubagentsEnded(raw.backgroundSubagentsEnded);
    return backgroundSubagentsEnded
      ? { version: 1, event: "background_subagents_ended", run: null, backgroundSubagentsEnded, emittedAt: num(raw.emittedAt) ?? Date.now() }
      : null;
  }
  if (raw.event !== "workflow_run") return null;
  const run = parseWorkflowRunDto(raw.run);
  return run ? { version: 1, event: "workflow_run", run, emittedAt: num(raw.emittedAt) ?? Date.now() } : null;
}

function clampOptional(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : clampWorkflowText(value, max);
}

/** One trimming pass: every text field clamped to `max`, the log cut to `logEntries`. */
function trimWorkflowRun(run: WorkflowRunDtoV1, max: number, logEntries: number): WorkflowRunDtoV1 {
  const clampNode = (node: WorkflowNodeDto): WorkflowNodeDto => {
    const out: WorkflowNodeDto = { ...node, title: clampWorkflowText(node.title, Math.max(max, 80)) ?? node.id };
    for (const key of ["prompt", "currentTool", "statusMessage", "result", "error"] as const) {
      const value = max === 0 ? undefined : clampOptional(node[key], max);
      if (value === undefined) delete out[key];
      else out[key] = value;
    }
    return out;
  };
  const out: WorkflowRunDtoV1 = {
    ...run,
    nodes: run.nodes.map(clampNode),
    log: logEntries === 0 ? [] : run.log.slice(-logEntries).map((entry) => ({ ...entry, text: clampWorkflowText(entry.text, Math.max(max, 80)) ?? "" })),
  };
  const setText = (key: "definition" | "statusDetail" | "result", value: string | undefined) => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  setText("definition", max === 0 ? undefined : clampOptional(run.definition, max * 2));
  setText("statusDetail", clampOptional(run.statusDetail, Math.max(max, WORKFLOW_LIMITS.line)));
  setText("result", clampOptional(run.result, Math.max(max * 4, 400)));
  // Approvals are never trimmed: the user must see the whole request they
  // allow. They are already bounded (WORKFLOW_LIMITS.approvals × prompt).
  return out;
}

/**
 * Keep a snapshot near `maxBytes` (WORKFLOW_LIMITS.snapshotBytes by
 * default, counted in UTF-16 units) so one huge run cannot flood a stream.
 * Text detail is trimmed in steps, then dropped; nodes, statuses and
 * pending approvals (whole) are always kept, so progress, controls and what
 * the user is asked to allow stay correct. A run whose skeleton alone is
 * larger is returned as that skeleton. Returns `run` itself when it fits.
 */
export function boundWorkflowRun(
  run: WorkflowRunDtoV1,
  maxBytes: number = WORKFLOW_LIMITS.snapshotBytes,
  /** Size of a snapshot; UTF-16 units by default (pass a byte count for wire budgets). */
  measure: (run: WorkflowRunDtoV1) => number = (value) => JSON.stringify(value).length,
): WorkflowRunDtoV1 {
  if (measure(run) <= maxBytes) return run;
  let trimmed = run;
  for (const [max, logEntries] of [[1_000, 20], [200, 10], [60, 3], [0, 0]] as const) {
    trimmed = trimWorkflowRun(trimmed, max, logEntries);
    if (measure(trimmed) <= maxBytes) return trimmed;
  }
  // Only node skeletons are left; that is the smallest correct snapshot.
  return trimmed;
}

/** Progress counts over the leaf nodes that do work (agents/steps). */
export function workflowProgress(run: Pick<WorkflowRunDtoV1, "nodes">): { done: number; total: number; running: number; failed: number } {
  const leaves = run.nodes.filter((node) => node.kind === "agent" || node.kind === "step");
  return {
    total: leaves.length,
    done: leaves.filter((node) => node.status === "completed" || node.status === "skipped").length,
    running: leaves.filter((node) => node.status === "running").length,
    failed: leaves.filter((node) => node.status === "failed").length,
  };
}
