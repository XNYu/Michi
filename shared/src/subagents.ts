/**
 * Subagent roster contract and its single fold.
 *
 * Runtime adapters emit roster entries (`subagent_list_update`) and activity
 * (`subagent_tool_activity`). The durable turn projection and the frontend
 * reducer both fold those events through the functions below, so a roster
 * rebuilt from a live stream, a replayed log or a hydrated message is the
 * same value.
 *
 * Merge semantics: a list update is a patch (`SubagentPatch`). Entries are
 * matched by `sessionId`; absent or empty fields — including `status` — keep
 * their earlier value and entries never disappear, so a runtime may send
 * just the fields that changed. First-seen timestamps win.
 */

export type SubagentStatus = "working" | "terminated";
export type SubagentOutcome = "completed" | "failed" | "cancelled";
export type SubagentSource = "claude" | "kiro" | "codex" | "crew" | "pi";
export type SubagentActivityKind = "tool" | "message";

export interface SubagentUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface SubagentActivity {
  /** Native tool-call id, or a producer-assigned id for narration. */
  id: string;
  kind: SubagentActivityKind;
  /** Tool label ("Read src/a.ts") or narration text. */
  title: string;
  /** Tool status: in_progress | completed | failed | interrupted. */
  status?: string;
  /** Native tool name/kind (read, Bash, …). */
  toolKind?: string;
  /** One-line input summary (path, command, pattern). */
  detail?: string;
  /** Truncated tool result. */
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface SubagentInfo {
  sessionId: string;
  sessionName: string;
  agentName: string;
  /** Short task summary shown in compact rows. */
  initialQuery: string;
  status: SubagentStatus;
  statusMessage?: string;
  group: string;
  dependsOn: string[];
  /** Parent tool call that spawned this subagent (exact chip link). */
  parentToolCallId?: string;
  /** Full delegated instructions, truncated to SUBAGENT_LIMITS.prompt. */
  prompt?: string;
  /** Delegation description/goal when the runtime separates it from the prompt. */
  description?: string;
  model?: string;
  /** Set once the subagent finished in a known way. */
  outcome?: SubagentOutcome;
  error?: string;
  /** Final report the parent received, truncated to SUBAGENT_LIMITS.result. */
  result?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: SubagentUsage;
  /** Latest in-flight tool title, derived from activity. */
  currentTool?: string;
  /** Most recent activity, oldest first, bounded by SUBAGENT_LIMITS.activity. */
  activity?: SubagentActivity[];
  /** Activity entries dropped from the front to respect the bound. */
  activityDropped?: number;
  source?: SubagentSource;
  /**
   * Keeps running after its parent's turn (Claude `run_in_background`, a
   * Codex child the parent never waited for). Its spawning message records
   * it as "in background"; the completion arrives in a later turn.
   */
  background?: boolean;
}

/** Wire form of a roster update: only `sessionId` is required. */
export type SubagentPatch = Partial<SubagentInfo> & { sessionId: string };

/** `subagent_tool_activity` payload. Only `subagentSessionId` is required. */
export interface SubagentActivityPayload {
  subagentSessionId: string;
  title: string;
  status: string;
  toolCallId?: string;
  /** Native tool name/kind. Not `kind`: that is the event discriminator. */
  toolKind?: string;
  detail?: string;
  output?: string;
  activityKind?: SubagentActivityKind;
  /** Producer timestamp; consumers fall back to their clock. */
  at?: number;
}

export const SUBAGENT_LIMITS = {
  prompt: 8_000,
  result: 8_000,
  error: 2_000,
  activity: 60,
  title: 400,
  detail: 400,
  output: 2_000,
  statusMessage: 400,
} as const;

const RUNNING = new Set(["running", "in_progress", "pending"]);

export function isRunningSubagentActivityStatus(status: string | undefined): boolean {
  return !status || RUNNING.has(status);
}

/**
 * Why a background agent without an outcome is shown as interrupted when
 * no live agent process tracks it any more (see BackgroundSubagentsUpdateV1).
 */
export const SUBAGENT_UNTRACKED_ERROR =
  "Interrupted: the agent session that ran it ended before it reported back, so Michi no longer knows how it finished.";

/** A background agent awaiting an outcome (it runs, or its report is pending). */
export function isBackgroundSubagentPending(info: Pick<SubagentInfo, "background" | "outcome" | "status">): boolean {
  return info.background === true && !info.outcome && (info.status === "working" || info.status === "terminated");
}

/**
 * How a pending background agent reads once no live process tracks it:
 * stopped, with SUBAGENT_UNTRACKED_ERROR unless it already has an error.
 * Its endedAt is dropped: for a background entry it is when the launch turn
 * ended, not when the agent stopped, which nobody knows. Presentation only;
 * the stored entry is left as it is.
 */
export function untrackedSubagent(info: SubagentInfo): SubagentInfo {
  const { currentTool: _currentTool, endedAt: _endedAt, ...rest } = info;
  return { ...rest, status: "terminated", outcome: "cancelled", error: info.error || SUBAGENT_UNTRACKED_ERROR };
}

/**
 * Why a background agent was recorded as stopped when the agent session
 * that ran it ended (Stop, model switch, crash, session release) before it
 * reported back. Same words as the live presentation (SUBAGENT_UNTRACKED_ERROR).
 */
export const SUBAGENT_SESSION_ENDED_ERROR = SUBAGENT_UNTRACKED_ERROR;

/** Why a background agent was recorded as stopped at startup: no agent process survives a restart. */
export const SUBAGENT_RESTARTED_ERROR =
  "Interrupted: Michi restarted before it reported back, so Michi no longer knows how it finished.";

/**
 * How a background agent ended when no turn will report it: its process
 * ended first (it is stopped, `cancelled`), or it finished while idle and
 * the turn that would have reported it never came (its known outcome).
 */
export interface SubagentEnd {
  sessionId: string;
  outcome: SubagentOutcome;
  /** Absent: unknown (it ended while the backend was down), so a copy keeps no end time. */
  endedAt?: number;
  error?: string;
  result?: string;
  usage?: SubagentUsage;
}

/** Wire bound for one `SubagentEnd` list and its ids. */
export const SUBAGENT_END_LIMITS = { ends: 100, idLength: 200 } as const;

/**
 * Record each end on every copy that still waits for it: entries with its
 * sessionId that are background without an outcome
 * (isBackgroundSubagentPending). Such a copy becomes terminated with the
 * end's outcome and endedAt, or none when the end time is unknown (a
 * background copy's own endedAt is when its turn ended, not the agent); the
 * end's result and usage replace the copy's, its error fills an empty one,
 * and steps still running close (interrupted unless it completed). Copies
 * with an outcome are final and left alone, so applying an end twice
 * changes nothing. Returns `roster` itself when no entry changed.
 */
export function endBackgroundSubagents<T extends SubagentInfo>(roster: T[], ends: readonly SubagentEnd[]): T[] {
  if (roster.length === 0 || ends.length === 0) return roster;
  const byId = new Map(ends.map((end) => [end.sessionId, end]));
  let changed = false;
  const next = roster.map((entry) => {
    const end = entry && typeof entry === "object" && typeof entry.sessionId === "string" ? byId.get(entry.sessionId) : undefined;
    if (!end || !isBackgroundSubagentPending(entry)) return entry;
    changed = true;
    const { currentTool: _currentTool, endedAt: _endedAt, ...rest } = entry;
    const toolStatus = end.outcome === "completed" ? "completed" : "interrupted";
    const ended: T = {
      ...(rest as T),
      status: "terminated",
      outcome: end.outcome,
      ...(end.endedAt !== undefined ? { endedAt: end.endedAt } : {}),
    };
    const error = entry.error || clampSubagentText(end.error, SUBAGENT_LIMITS.error);
    if (error) ended.error = error;
    const result = clampSubagentText(end.result, SUBAGENT_LIMITS.result);
    if (result) ended.result = result;
    const usage = mergeUsage(entry.usage, end.usage);
    if (usage) ended.usage = usage;
    const running = (item: SubagentActivity) => item.kind === "tool" && isRunningSubagentActivityStatus(item.status);
    if (entry.activity?.some(running)) {
      ended.activity = entry.activity.map((item) => {
        if (!running(item)) return item;
        const closed: SubagentActivity = { ...item, status: toolStatus };
        const endedAt = item.endedAt ?? end.endedAt;
        if (endedAt !== undefined) closed.endedAt = endedAt;
        return closed;
      });
    }
    return ended;
  });
  return changed ? next : roster;
}

/**
 * How a background agent no turn will report ended: the outcome it already
 * has (it finished while idle), else stopped (`cancelled`) with `error` as
 * the reason, at `endedAt` (omit when unknown).
 */
export function subagentEndOf(
  entry: Pick<SubagentInfo, "sessionId"> & Partial<Pick<SubagentInfo, "outcome" | "status" | "endedAt" | "error" | "result" | "usage">>,
  error: string,
  endedAt?: number,
): SubagentEnd {
  if (entry.outcome && entry.status === "terminated") {
    const at = entry.endedAt ?? endedAt;
    return {
      sessionId: entry.sessionId,
      outcome: entry.outcome,
      ...(at !== undefined ? { endedAt: at } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
    };
  }
  return { sessionId: entry.sessionId, outcome: "cancelled", ...(endedAt !== undefined ? { endedAt } : {}), error };
}

/**
 * The end an untrusted (stored) roster copy already records: terminated
 * with a known outcome gives that outcome with its end time, error, result
 * and usage (subagentEndOf), for the agent's other copies still waiting
 * for one. Null for a copy that is pending, still working or malformed.
 */
export function knownSubagentEnd(entry: unknown): SubagentEnd | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const sessionId = str(raw.sessionId);
  if (!sessionId || raw.status !== "terminated" || !OUTCOMES.has(raw.outcome as SubagentOutcome)) return null;
  const endedAt = num(raw.endedAt);
  const usage = parseUsage(raw.usage);
  return subagentEndOf({
    sessionId,
    status: "terminated",
    outcome: raw.outcome as SubagentOutcome,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(str(raw.error) ? { error: str(raw.error) } : {}),
    ...(str(raw.result) ? { result: str(raw.result) } : {}),
    ...(usage ? { usage } : {}),
  }, "");
}

export function clampSubagentText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mergeUsage(prev: SubagentUsage | undefined, next: SubagentUsage | undefined): SubagentUsage | undefined {
  if (!next) return prev;
  const merged: SubagentUsage = { ...prev };
  if (next.totalTokens !== undefined) merged.totalTokens = next.totalTokens;
  if (next.toolUses !== undefined) merged.toolUses = next.toolUses;
  if (next.durationMs !== undefined) merged.durationMs = next.durationMs;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function deriveCurrentTool(activity: readonly SubagentActivity[] | undefined): string | undefined {
  if (!activity) return undefined;
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const entry = activity[index];
    if (entry.kind === "tool" && isRunningSubagentActivityStatus(entry.status)) return entry.title || entry.toolKind;
  }
  return undefined;
}

function mergeActivityEntry(prev: SubagentActivity | undefined, next: SubagentActivity, now: number): SubagentActivity {
  const merged: SubagentActivity = prev ? { ...prev } : { id: next.id, kind: next.kind, title: "", startedAt: next.startedAt ?? now };
  if (next.title) merged.title = next.title;
  if (next.status) merged.status = next.status;
  if (next.toolKind) merged.toolKind = next.toolKind;
  if (next.detail) merged.detail = next.detail;
  if (next.output) merged.output = next.output;
  if (merged.kind === "tool" && !merged.endedAt && !isRunningSubagentActivityStatus(merged.status)) {
    merged.endedAt = next.endedAt ?? now;
  }
  return merged;
}

/**
 * Keep the newest SUBAGENT_LIMITS.activity entries; what goes from the front
 * is added to `dropped` (the entries dropped before).
 */
export function boundActivity(
  activity: SubagentActivity[],
  dropped: number | undefined,
): { activity: SubagentActivity[]; activityDropped?: number } {
  const overflow = activity.length - SUBAGENT_LIMITS.activity;
  if (overflow <= 0) return { activity, ...(dropped ? { activityDropped: dropped } : {}) };
  return { activity: activity.slice(overflow), activityDropped: (dropped ?? 0) + overflow };
}

/**
 * `prev` in its order, each `next` entry merged onto the entry with its id
 * or appended. Unbounded; `now` stamps times an entry lacks.
 */
export function mergeActivityLists(
  prev: readonly SubagentActivity[] | undefined,
  next: readonly SubagentActivity[],
  now: number,
): SubagentActivity[] {
  const result = [...(prev ?? [])];
  for (const entry of next) {
    const index = result.findIndex((item) => item.id === entry.id);
    if (index >= 0) result[index] = mergeActivityEntry(result[index], entry, now);
    else result.push(mergeActivityEntry(undefined, entry, now));
  }
  return result;
}

/** Merge one incoming roster entry onto the previous value (or create it). */
export function mergeSubagentEntry(prev: SubagentInfo | undefined, next: SubagentPatch, now = Date.now()): SubagentInfo {
  if (!prev) {
    const created: SubagentInfo = {
      ...next,
      status: next.status ?? "working",
      sessionName: next.sessionName ?? "",
      agentName: next.agentName ?? "",
      initialQuery: next.initialQuery ?? "",
      group: next.group ?? "",
      dependsOn: Array.isArray(next.dependsOn) ? [...next.dependsOn] : [],
    };
    if (next.activity?.length) {
      Object.assign(created, boundActivity(mergeActivityLists(undefined, next.activity, now), next.activityDropped));
      created.currentTool = next.currentTool ?? deriveCurrentTool(created.activity);
    }
    if (created.status === "terminated" && created.endedAt === undefined && created.outcome) created.endedAt = now;
    return created;
  }
  // A known outcome is final; a later "working" frame (late roster replay)
  // must not resurrect the subagent.
  const status: SubagentStatus = prev.status === "terminated" && prev.outcome && next.status === "working"
    ? "terminated"
    : next.status ?? prev.status;
  const merged: SubagentInfo = {
    ...prev,
    status,
    sessionName: nonEmpty(next.sessionName) ?? prev.sessionName,
    agentName: next.agentName && next.agentName !== "subagent" ? next.agentName : prev.agentName || next.agentName || "",
    initialQuery: nonEmpty(next.initialQuery) ?? prev.initialQuery,
    group: nonEmpty(next.group) ?? prev.group,
    dependsOn: next.dependsOn?.length ? [...next.dependsOn] : prev.dependsOn,
  };
  const optionalStrings = [
    "statusMessage", "parentToolCallId", "prompt", "description", "model", "error", "result",
  ] as const;
  for (const key of optionalStrings) {
    const value = nonEmpty(next[key]);
    if (value !== undefined) merged[key] = value;
  }
  if (next.outcome && !prev.outcome) merged.outcome = next.outcome;
  if (next.source) merged.source = next.source;
  if (next.background) merged.background = true;
  if (next.startedAt !== undefined && prev.startedAt === undefined) merged.startedAt = next.startedAt;
  // A resurrected entry (ended without an outcome, then working again) is
  // still open; otherwise the first end time wins so repeated terminal
  // patches don't move it.
  if (status === "working") delete merged.endedAt;
  else if (merged.endedAt === undefined) merged.endedAt = next.endedAt ?? now;
  const usage = mergeUsage(prev.usage, next.usage);
  if (usage) merged.usage = usage;
  if (next.activity?.length) {
    Object.assign(merged, boundActivity(mergeActivityLists(prev.activity, next.activity, now), merged.activityDropped));
  }
  merged.currentTool = status === "working"
    ? deriveCurrentTool(merged.activity) ?? nonEmpty(next.currentTool) ?? prev.currentTool
    : undefined;
  return merged;
}

/** Fold a `subagent_list_update` patch into the roster. Order is first-seen. */
export function mergeSubagentRoster(
  prev: readonly SubagentInfo[] | undefined,
  incoming: readonly SubagentPatch[],
  now = Date.now(),
): SubagentInfo[] {
  const roster = [...(prev ?? [])];
  for (const entry of incoming) {
    if (!entry || typeof entry.sessionId !== "string" || !entry.sessionId) continue;
    const index = roster.findIndex((item) => item.sessionId === entry.sessionId);
    if (index >= 0) roster[index] = mergeSubagentEntry(roster[index], entry, now);
    else roster.push(mergeSubagentEntry(undefined, entry, now));
  }
  return roster;
}

/**
 * Fold one `subagent_tool_activity` event. Unknown subagents and replayed
 * duplicates are ignored and return `prev` itself, so callers can skip work
 * by reference.
 */
export function applySubagentActivity(
  prev: readonly SubagentInfo[] | undefined,
  payload: SubagentActivityPayload,
  now = Date.now(),
): SubagentInfo[] | undefined {
  const unchanged = prev as SubagentInfo[] | undefined;
  if (!prev?.length) return unchanged;
  const index = prev.findIndex((entry) => entry.sessionId === payload.subagentSessionId);
  if (index < 0) return unchanged;
  const subagent = prev[index];
  const kind: SubagentActivityKind = payload.activityKind === "message" ? "message" : "tool";
  const title = clampSubagentText(payload.title, SUBAGENT_LIMITS.title) ?? "";
  const activity = [...(subagent.activity ?? [])];
  let id = payload.toolCallId;
  if (!id) {
    if (kind === "message") {
      // Narration without an id: a replayed duplicate repeats the last line.
      const last = activity[activity.length - 1];
      if (last?.kind === "message" && last.title === title) return unchanged;
      id = `m-${(subagent.activityDropped ?? 0) + activity.length}`;
    } else {
      // Legacy runtimes send title/status only. Pair a terminal update with
      // the latest running entry of the same title.
      const match = [...activity].reverse().find((entry) =>
        entry.kind === "tool" && entry.title === title && isRunningSubagentActivityStatus(entry.status));
      id = match?.id ?? `t-${(subagent.activityDropped ?? 0) + activity.length}`;
    }
  }
  const entry: SubagentActivity = {
    id,
    kind,
    title,
    ...(kind === "tool" ? { status: payload.status || "in_progress" } : {}),
    ...(payload.toolKind ? { toolKind: payload.toolKind } : {}),
    ...(payload.detail ? { detail: clampSubagentText(payload.detail, SUBAGENT_LIMITS.detail) } : {}),
    ...(payload.output ? { output: clampSubagentText(payload.output, SUBAGENT_LIMITS.output) } : {}),
    ...(payload.at !== undefined ? { startedAt: payload.at } : {}),
  };
  const merged = boundActivity(mergeActivityLists(activity, [entry], payload.at ?? now), subagent.activityDropped);
  const next: SubagentInfo = {
    ...subagent,
    ...merged,
    ...(kind === "message" && title
      ? { statusMessage: clampSubagentText(title, SUBAGENT_LIMITS.statusMessage) }
      : {}),
  };
  next.currentTool = next.status === "working" ? deriveCurrentTool(next.activity) : undefined;
  const roster = [...prev];
  roster[index] = next;
  return roster;
}

/**
 * Close the roster at the end of its turn. Still-working subagents become
 * terminated; a cancelled/failed turn marks them cancelled and their
 * in-flight tools interrupted (mirrors tool-call finalization).
 */
export function finalizeSubagentRoster(
  roster: readonly SubagentInfo[] | undefined,
  interrupted: boolean,
  now = Date.now(),
): SubagentInfo[] | undefined {
  if (!roster?.length) return roster ? [...roster] : undefined;
  let changed = false;
  const finalized = roster.map((entry) => {
    const runningTools = entry.activity?.some((item) => item.kind === "tool" && isRunningSubagentActivityStatus(item.status));
    if (entry.status !== "working" && !runningTools) return entry;
    changed = true;
    const toolStatus = interrupted ? "interrupted" : "completed";
    return {
      ...entry,
      status: "terminated" as const,
      ...(interrupted && !entry.outcome ? { outcome: "cancelled" as const } : {}),
      endedAt: entry.endedAt ?? now,
      currentTool: undefined,
      ...(entry.activity ? {
        activity: entry.activity.map((item) => item.kind === "tool" && isRunningSubagentActivityStatus(item.status)
          ? { ...item, status: toolStatus, endedAt: item.endedAt ?? now }
          : item),
      } : {}),
    };
  });
  return changed ? finalized : [...roster];
}

// ---- Wire parsing --------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): SubagentUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: SubagentUsage = {
    ...(num(raw.totalTokens) !== undefined ? { totalTokens: num(raw.totalTokens) } : {}),
    ...(num(raw.toolUses) !== undefined ? { toolUses: num(raw.toolUses) } : {}),
    ...(num(raw.durationMs) !== undefined ? { durationMs: num(raw.durationMs) } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseActivity(value: unknown): SubagentActivity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.flatMap((item): SubagentActivity[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const id = str(raw.id);
    if (!id) return [];
    const kind: SubagentActivityKind = raw.kind === "message" ? "message" : "tool";
    return [{
      id,
      kind,
      title: clampSubagentText(str(raw.title), SUBAGENT_LIMITS.title) ?? "",
      ...(str(raw.status) ? { status: str(raw.status) } : {}),
      ...(str(raw.toolKind) ? { toolKind: str(raw.toolKind) } : {}),
      ...(str(raw.detail) ? { detail: clampSubagentText(str(raw.detail), SUBAGENT_LIMITS.detail) } : {}),
      ...(str(raw.output) ? { output: clampSubagentText(str(raw.output), SUBAGENT_LIMITS.output) } : {}),
      ...(num(raw.startedAt) !== undefined ? { startedAt: num(raw.startedAt) } : {}),
      ...(num(raw.endedAt) !== undefined ? { endedAt: num(raw.endedAt) } : {}),
    }];
  });
  return list.length > 0 ? list.slice(-SUBAGENT_LIMITS.activity) : undefined;
}

const OUTCOMES = new Set<SubagentOutcome>(["completed", "failed", "cancelled"]);
const SOURCES = new Set<SubagentSource>(["claude", "kiro", "codex", "crew", "pi"]);

/**
 * Validate one untrusted roster patch; returns null when unusable. Absent
 * fields stay absent (a patch keeps the earlier value for them).
 */
export function parseSubagentPatch(value: unknown): SubagentPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionId = str(raw.sessionId);
  if (!sessionId) return null;
  const entry: SubagentPatch = { sessionId };
  if (raw.status === "working" || raw.status === "terminated") entry.status = raw.status;
  for (const key of ["sessionName", "agentName", "initialQuery", "group"] as const) {
    if (str(raw[key]) !== undefined) entry[key] = str(raw[key]);
  }
  if (Array.isArray(raw.dependsOn)) entry.dependsOn = raw.dependsOn.filter((item): item is string => typeof item === "string");
  const statusMessage = clampSubagentText(str(raw.statusMessage), SUBAGENT_LIMITS.statusMessage);
  if (statusMessage) entry.statusMessage = statusMessage;
  if (str(raw.parentToolCallId)) entry.parentToolCallId = str(raw.parentToolCallId);
  const prompt = clampSubagentText(str(raw.prompt), SUBAGENT_LIMITS.prompt);
  if (prompt) entry.prompt = prompt;
  const description = clampSubagentText(str(raw.description), SUBAGENT_LIMITS.title);
  if (description) entry.description = description;
  if (str(raw.model)) entry.model = str(raw.model);
  if (OUTCOMES.has(raw.outcome as SubagentOutcome)) entry.outcome = raw.outcome as SubagentOutcome;
  const error = clampSubagentText(str(raw.error), SUBAGENT_LIMITS.error);
  if (error) entry.error = error;
  const result = clampSubagentText(str(raw.result), SUBAGENT_LIMITS.result);
  if (result) entry.result = result;
  if (num(raw.startedAt) !== undefined) entry.startedAt = num(raw.startedAt);
  if (num(raw.endedAt) !== undefined) entry.endedAt = num(raw.endedAt);
  const usage = parseUsage(raw.usage);
  if (usage) entry.usage = usage;
  if (str(raw.currentTool)) entry.currentTool = str(raw.currentTool);
  const activity = parseActivity(raw.activity);
  if (activity) entry.activity = activity;
  if (num(raw.activityDropped)) entry.activityDropped = num(raw.activityDropped);
  if (SOURCES.has(raw.source as SubagentSource)) entry.source = raw.source as SubagentSource;
  if (raw.background === true) entry.background = true;
  return entry;
}

/** Validate one stored roster entry (a complete record, not a patch). */
export function parseSubagentInfo(value: unknown): SubagentInfo | null {
  const patch = parseSubagentPatch(value);
  if (!patch) return null;
  return {
    ...patch,
    sessionName: patch.sessionName ?? "",
    agentName: patch.agentName ?? "",
    initialQuery: patch.initialQuery ?? "",
    status: patch.status ?? "terminated",
    group: patch.group ?? "",
    dependsOn: patch.dependsOn ?? [],
  };
}

function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  let raw = value;
  if (typeof raw === "string" && raw.trim()) {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = parse(item);
    return entry ? [entry] : [];
  });
}

/** Validate one untrusted SubagentEnd; null when unusable. */
export function parseSubagentEnd(value: unknown): SubagentEnd | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionId = str(raw.sessionId);
  const endedAt = num(raw.endedAt);
  if (!sessionId || sessionId.length > SUBAGENT_END_LIMITS.idLength) return null;
  if (!OUTCOMES.has(raw.outcome as SubagentOutcome)) return null;
  const end: SubagentEnd = { sessionId, outcome: raw.outcome as SubagentOutcome };
  if (endedAt !== undefined) end.endedAt = endedAt;
  const error = clampSubagentText(str(raw.error), SUBAGENT_LIMITS.error);
  if (error) end.error = error;
  const result = clampSubagentText(str(raw.result), SUBAGENT_LIMITS.result);
  if (result) end.result = result;
  const usage = parseUsage(raw.usage);
  if (usage) end.usage = usage;
  return end;
}

/** A SubagentEnd list, bounded by SUBAGENT_END_LIMITS; malformed entries are dropped. */
export function parseSubagentEnds(value: unknown): SubagentEnd[] {
  return parseList(value, parseSubagentEnd).slice(0, SUBAGENT_END_LIMITS.ends);
}

/** Stored roster (message metadata). */
export function parseSubagentRoster(value: unknown): SubagentInfo[] {
  return parseList(value, parseSubagentInfo);
}

/** `subagent_list_update` payload. */
export function parseSubagentPatches(value: unknown): SubagentPatch[] {
  return parseList(value, parseSubagentPatch);
}

export function parseSubagentActivityPayload(value: Record<string, unknown>): SubagentActivityPayload {
  const toolKind = str(value.toolKind);
  const toolCallId = str(value.toolCallId);
  const detail = str(value.detail);
  const output = str(value.output);
  const at = num(value.at);
  return {
    subagentSessionId: str(value.subagentSessionId) ?? "",
    title: str(value.title) ?? "",
    status: str(value.status) ?? "",
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolKind ? { toolKind } : {}),
    ...(detail ? { detail: clampSubagentText(detail, SUBAGENT_LIMITS.detail) } : {}),
    ...(output ? { output: clampSubagentText(output, SUBAGENT_LIMITS.output) } : {}),
    ...(value.activityKind === "message" ? { activityKind: "message" as const } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}
