/**
 * Agent tools for Michi Memory: memory_search, memory_save, memory_update
 * (a correction: supersedeMemory) and memory_delete. Registered for chat
 * threads on every runtime (MCP for Kiro/Claude/Codex/Crew, built-in tools
 * for Pi); never for Agent Runs, the Michi assistant or background
 * maintenance.
 *
 * Boundaries enforced here, independent of runtime permission modes:
 *  - The owner and the workspace come from the session binding, never from
 *    tool arguments. The arguments only say what a memory is (kind) and whom
 *    it applies to: `everywhere` (the user scope) or `this_workspace` (the
 *    thread's own workspace). When the model cannot tell, memory_save writes
 *    nothing and answers `needs_scope`, telling it to ask the user once.
 *  - update and delete reach only the user-scope memories and the current
 *    workspace's: another owner's, or another workspace's, reads as not found.
 *  - A save or correction made while the thread's running turn has read
 *    untrusted content (web pages, shell output, another MCP server's
 *    results: services/turnTrust.ts), or when Michi cannot find the running
 *    turn, is stored pending, with sourceRisk untrusted, until the user
 *    confirms it in Settings → Memory. The result reports the stored status.
 *  - With memory turned off the tools neither read nor write.
 *
 * Every change is announced by memoryService (memoryEvents 'changed'); this
 * module sends no notifications of its own. Ask-mode approval is the
 * runtimes' ordinary permission path (agents/permissionPolicy.ts):
 * search, save and update run without a prompt, delete asks.
 */

import {
  MEMORY_BODY_MAX_CHARS,
  isMemoryKind,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource,
} from "michi-shared";
import { log } from "../services/logger";
import {
  MemoryError,
  createMemory,
  deleteMemory,
  getMemory,
  getMemorySettings,
  searchMemories,
  supersedeMemory,
  type MemoryCaller,
} from "../services/memory/memoryService";
import { memoryOwnerId } from "../services/memory/memoryOwner";
import { activeTurnTrust } from "../services/turnTrust";
import type { MemoryToolName } from "./memoryToolNames";

export { MEMORY_TOOL_NAMES, isMemoryToolName, type MemoryToolName } from "./memoryToolNames";

/** Session-bound identity of the calling thread. Never sourced from tool arguments. */
export interface MemoryToolCaller {
  /** The session's user; ignored on the desktop, where every memory is the local user's. */
  ownerUserId: string | null;
  workspaceId: string | null;
  nodeId: string | null;
  isAgentRun: boolean;
}

export interface MemoryToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

/** Whom a memory applies to, as the model says it; the scope follows from the session. */
const APPLIES_TO = ["everywhere", "this_workspace", "unsure"] as const;
type AppliesTo = typeof APPLIES_TO[number];

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 20;

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorResult(code: string, message: string): MemoryToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

function jsonResult(value: Record<string, unknown>): MemoryToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function memoryOff(): MemoryToolResult {
  return errorResult("MEMORY_OFF",
    "Michi Memory is turned off (Settings → Memory), so nothing was read or saved. Do not retry; "
    + "if the user asked you to remember something, tell them memory is off.");
}

function toolError(error: unknown): MemoryToolResult {
  if (error instanceof ToolError) return errorResult(error.code, error.message);
  if (error instanceof MemoryError) {
    switch (error.code) {
      case "memory_disabled": return memoryOff();
      case "not_found": return errorResult("NOT_FOUND", error.message);
      case "invalid_argument": return errorResult("INVALID_ARGUMENT", error.message);
      case "invalid_state": return errorResult("INVALID_STATE", error.message);
      case "version_conflict": return errorResult("CONFLICT", `${error.message}. Search again and use the current memory.`);
    }
  }
  throw error;
}

// ── Session ──────────────────────────────────────────────────────────────────

interface MemorySession {
  caller: MemoryCaller;
  workspaceId: string | null;
  nodeId: string;
}

function session(caller: MemoryToolCaller): MemorySession {
  if (caller.isAgentRun) throw new ToolError("UNSUPPORTED", "memory tools are available only in chat threads, not Agent Runs");
  if (!caller.nodeId) throw new ToolError("SOURCE_UNAVAILABLE", "this session is not yet bound to a chat thread");
  // The owner Settings → Memory and the change feed use (services/memory/memoryOwner.ts).
  const ownerUserId = memoryOwnerId(caller.ownerUserId);
  if (!ownerUserId) throw new ToolError("UNAVAILABLE", "this session has no signed-in user");
  return { caller: { ownerUserId }, workspaceId: caller.workspaceId, nodeId: caller.nodeId };
}

/** A memory this thread may change: the user's own, or its own workspace's. Anything else reads as missing. */
function visibleMemory(s: MemorySession, id: string): MemoryRecord {
  const record = getMemory(s.caller, id);
  if (record.scope.kind === "workspace" && record.scope.workspaceId !== s.workspaceId) {
    throw new ToolError("NOT_FOUND", "Memory not found");
  }
  return record;
}

// ── Turn trust ───────────────────────────────────────────────────────────────

interface WriteGate {
  status: "active" | "pending";
  sourceRisk: "untrusted" | null;
  source: MemorySource;
  /** Why the write waits for the user; null when it is active. */
  reason: "untrusted" | "unverified" | null;
}

/** active only when the thread's running turn is known and read nothing untrusted; otherwise pending. */
function writeGate(nodeId: string): WriteGate {
  let trust: ReturnType<typeof activeTurnTrust> = null;
  try {
    trust = activeTurnTrust(nodeId);
  } catch (error) {
    log.warn("chat", "memory tool could not read turn trust", { nodeId, error: (error as Error).message });
  }
  const source: MemorySource = { nodeId, ...(trust ? { turnId: trust.turnId } : {}) };
  if (trust && !trust.untrusted) return { status: "active", sourceRisk: null, source, reason: null };
  return { status: "pending", sourceRisk: "untrusted", source, reason: trust ? "untrusted" : "unverified" };
}

function pendingNote(reason: WriteGate["reason"], what: string): string {
  const why = reason === "unverified"
    ? "Michi could not confirm what this turn read"
    : "this turn read content from outside this conversation (such as web pages, command output or another MCP server's tools)";
  return `${what} waits for the user's confirmation: ${why}. Tell the user it is pending in Settings → Memory, where they can approve or reject it; do not save it again.`;
}

// ── Arguments ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolError("INVALID_ARGUMENT", "body must be a non-empty string");
  const body = value.trim();
  if (body.length > MEMORY_BODY_MAX_CHARS) {
    throw new ToolError("INVALID_ARGUMENT", `body must be at most ${MEMORY_BODY_MAX_CHARS} characters; save one short statement`);
  }
  return body;
}

function requireKind(value: unknown): MemoryKind {
  if (!isMemoryKind(value)) throw new ToolError("INVALID_ARGUMENT", "kind must be preference, fact, decision or convention");
  return value;
}

function requireId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new ToolError("INVALID_ARGUMENT", "id is required: a memory id from memory_search");
  return id;
}

function requireAppliesTo(value: unknown): AppliesTo {
  if (typeof value !== "string" || !(APPLIES_TO as readonly string[]).includes(value)) {
    throw new ToolError("INVALID_ARGUMENT", "appliesTo must be everywhere, this_workspace or unsure");
  }
  return value as AppliesTo;
}

function searchLimit(value: unknown): number {
  if (value === undefined || value === null) return SEARCH_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SEARCH_MAX_LIMIT) {
    throw new ToolError("INVALID_ARGUMENT", `limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
  }
  return value;
}

// ── Views ────────────────────────────────────────────────────────────────────

function appliesToOf(scope: MemoryScope): Exclude<AppliesTo, "unsure"> {
  return scope.kind === "user" ? "everywhere" : "this_workspace";
}

function memoryView(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    appliesTo: appliesToOf(record.scope),
    kind: record.kind,
    body: record.body,
    status: record.status,
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

const NEEDS_SCOPE_NEXT =
  "Nothing was saved. Ask the user once, with ask_user, whether this applies to all their work or only to this "
  + "workspace (for example the options \"All my work\" and \"This workspace only\"), then call memory_save again "
  + "with appliesTo everywhere or this_workspace. If they do not answer, do not save it.";

// ── Tool entry point ─────────────────────────────────────────────────────────

/** Runs one memory tool call for the calling thread. Unexpected failures (the database) throw. */
export function memoryTool(name: MemoryToolName, caller: MemoryToolCaller, rawArgs: unknown): MemoryToolResult {
  const args = asRecord(rawArgs);
  try {
    const s = session(caller);
    if (getMemorySettings(s.caller.ownerUserId).mode === "off") return memoryOff();
    switch (name) {
      case "memory_search": return searchTool(s, args);
      case "memory_save": return saveTool(s, args);
      case "memory_update": return updateTool(s, args);
      case "memory_delete": return deleteTool(s, args);
    }
  } catch (error) {
    return toolError(error);
  }
}

function searchTool(s: MemorySession, args: Record<string, unknown>): MemoryToolResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new ToolError("INVALID_ARGUMENT", "query must be a few keywords separated by spaces");
  const limit = searchLimit(args.limit);
  const records = searchMemories(s.caller, { query, workspaceId: s.workspaceId, includeUser: true, limit });
  return jsonResult({
    count: records.length,
    memories: records.map(memoryView),
    ...(records.length === 0
      ? { next: "Nothing matched. Try fewer, shorter or different keywords (single words; 2-4 characters for Chinese) before concluding there is no memory." }
      : { note: "Memories are notes the user saved and can edit in Settings → Memory. The user's current request takes precedence over them." }),
  });
}

function saveTool(s: MemorySession, args: Record<string, unknown>): MemoryToolResult {
  const body = requireBody(args.body);
  const kind = requireKind(args.kind);
  const appliesTo = requireAppliesTo(args.appliesTo);
  if (appliesTo === "unsure") return jsonResult({ status: "needs_scope", saved: false, next: NEEDS_SCOPE_NEXT });
  let scope: MemoryScope = { kind: "user" };
  if (appliesTo === "this_workspace") {
    if (!s.workspaceId) throw new ToolError("SOURCE_UNAVAILABLE", "this thread has no workspace; save it with appliesTo everywhere only if the user wants it in all their work");
    scope = { kind: "workspace", workspaceId: s.workspaceId };
  }
  const gate = writeGate(s.nodeId);
  const record = createMemory(s.caller, {
    scope, kind, body, source: gate.source, status: gate.status, origin: "explicit", sourceRisk: gate.sourceRisk,
  });
  if (record.status === "active") {
    return jsonResult({
      status: "saved",
      memory: memoryView(record),
      note: "Saved to Michi Memory. The user can see, edit or delete it in Settings → Memory.",
    });
  }
  return jsonResult({ status: "pending_confirmation", memory: memoryView(record), note: pendingNote(gate.reason, "The memory") });
}

function updateTool(s: MemorySession, args: Record<string, unknown>): MemoryToolResult {
  const id = requireId(args.id);
  const body = requireBody(args.body);
  const kind = args.kind === undefined || args.kind === null ? undefined : requireKind(args.kind);
  const old = visibleMemory(s, id);
  if (old.status === "superseded") {
    throw new ToolError("INVALID_STATE", "that memory was already corrected; search again and correct its current version");
  }
  if (body === old.body && (kind ?? old.kind) === old.kind) {
    return jsonResult({ status: "unchanged", memory: memoryView(old) });
  }
  const gate = writeGate(s.nodeId);
  const record = supersedeMemory(s.caller, old.id, {
    body, kind, source: gate.source, status: gate.status, origin: "explicit", sourceRisk: gate.sourceRisk,
  });
  if (record.status === "active") {
    return jsonResult({
      status: "updated",
      memory: memoryView(record),
      replaces: old.id,
      note: "The correction replaced the old memory, which Michi keeps as history. The user can see or change it in Settings → Memory.",
    });
  }
  return jsonResult({
    status: "pending_confirmation",
    memory: memoryView(record),
    replaces: old.id,
    note: `${pendingNote(gate.reason, "The correction")} Until then the old memory stays in effect.`,
  });
}

function deleteTool(s: MemorySession, args: Record<string, unknown>): MemoryToolResult {
  const id = requireId(args.id);
  const record = visibleMemory(s, id);
  if (record.status === "superseded") {
    throw new ToolError("INVALID_STATE", "that memory was replaced by a correction; search again and delete its current version");
  }
  deleteMemory(s.caller, record.id);
  return jsonResult({ status: "deleted", id: record.id, body: record.body, note: "Deleted from Michi Memory. This cannot be undone." });
}
