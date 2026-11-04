/**
 * Turn trust: whether a chat turn consumed untrusted content — web pages,
 * shell output, results of an MCP server other than Michi's own — so that
 * work that must not follow instructions planted in such content (a memory
 * write the model starts, memory extraction) can tell.
 *
 * Sources are recorded per (nodeId, turnId) in `turn_trust` (migration
 * 0060) and kept after the turn ends; they go with the node (a purge or a
 * hard delete removes them). They come from two places:
 *
 * - chatHub passes every runtime event of a turn to observeTurnTrust. The
 *   tool_call / tool_call_update events every runtime (Pi included) sends
 *   name the tool (NormalizedEvent toolName / mcpServer / hostTool, which
 *   the adapters set); classifyToolTrust judges them. A subagent's tool
 *   activity counts for the turn that runs the subagent.
 * - A tool executor that fetches outside content itself (fetch_content)
 *   calls recordUntrustedSource with what it read.
 *
 * Tool executors find the running turn of their chat with
 * activeTurnTrust(nodeId). The MCP server's handlers get the node from the
 * slot binding (`resolveSlotBinding(slot).nodeId`, null for an Agent Run),
 * Pi's from the session owner (`chatNodeOf(opts.owner)` in buildPiTools).
 *
 * Trust is per turn: content a previous turn of the chat read is still in
 * the model's context, but does not make the next turn untrusted.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { NormalizedEvent } from './chatEvents';
import { getDb, openDbOrNull } from './db';
import { log } from './logger';
import { PAGE_TOOL_NAMES } from '../agents/pageToolNames';
import { SCHEDULED_JOB_TOOL_NAMES } from '../agents/scheduledJobToolNames';
import { MEMORY_TOOL_NAMES } from '../agents/memoryToolNames';
import { AGENT_RUN_TOOL_NAMES } from 'michi-runtime/internal/contract/tools';

export interface TurnRef { nodeId: string; turnId: string }
/** `tool`: the tool's name; `detail`: what it read, or the MCP server it came from (`mcp:<server>`). */
export type TrustSource = { tool: string; runtimeId: string; detail?: string };
export type ToolTrust = 'trusted' | 'untrusted';

export interface ToolTrustInput {
  runtimeId: string;
  /** The tool's own name (NormalizedEvent toolName); '' when the runtime gives none. */
  toolName: string;
  /** The MCP server the tool belongs to, when it is an MCP tool. */
  mcpServer?: string | null;
  /** true: one of Michi's own tools; false: another MCP server's. Absent: unknown, judged by name. */
  hostTool?: boolean;
  /** The call's ACP tool kind (read, execute, fetch, ...), judged when the name is missing or unknown. */
  kind?: string;
}

// ---------------------------------------------------------------------------
// Classification (v1)
// ---------------------------------------------------------------------------

/**
 * Tools whose output is outside content, whoever runs them: web search and
 * fetch, shell and code execution, cloud APIs, and MCP resources. Checked
 * first, so Michi's own web_search / fetch_content and Pi's bash count too.
 */
const UNTRUSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Michi (Pi in process, or any runtime through Michi's MCP server).
  'web_search', 'fetch_content', 'bash',
  // Claude Code.
  'WebFetch', 'WebSearch', 'WebBrowser', 'Bash', 'BashOutput', 'TaskOutput', 'KillShell', 'PowerShell', 'REPL',
  'Monitor', 'RemoteTrigger', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  // codex (the translator's names for its call kinds).
  'shell',
  // Kiro v2 / v3 and Kiro Crew.
  'execute_bash', 'run_command', 'web_fetch', 'use_aws',
  // ACP tool kinds, as subagent activity reports them.
  'execute', 'fetch',
]);

/**
 * Runtime built-ins that read or change the workspace, plan, ask the user or
 * run a subagent (whose own tools are judged from its activity).
 */
const TRUSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Michi's file tools (Pi).
  'read', 'ls', 'grep', 'find', 'write', 'edit',
  // Claude Code.
  'Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'TodoWrite', 'Task', 'Agent', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ListAgents',
  'SendMessage', 'SendUserMessage', 'TeamCreate', 'TeamDelete', 'Workflow', 'ReportFindings', 'Brief',
  'StructuredOutput', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Sleep', 'PushNotification',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Config', 'Skill',
  'SlashCommand', 'ToolSearch',
  // codex: parsed read-only commands, patches, collaboration.
  'apply_patch', 'spawnAgent', 'wait', 'sendInput', 'closeAgent', 'resumeAgent',
  // Kiro v2 / v3.
  'fs_read', 'fs_write', 'glob', 'todo_list', 'thinking', 'delegate', 'use_subagent', 'subagent', 'summary',
  // Antigravity.
  'view_file', 'read_file', 'list_dir', 'find_by_name', 'grep_search', 'write_file', 'replace_file_content',
  'multi_replace_file_content',
  // ACP tool kinds, as subagent activity reports them.
  'delete', 'move', 'search', 'think', 'switch_mode',
]);

/**
 * Michi's own tools by bare name, for a runtime that reports a host tool
 * without its server. Exported for the drift test against Michi's catalogs.
 */
export const MICHI_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PAGE_TOOL_NAMES, ...SCHEDULED_JOB_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...AGENT_RUN_TOOL_NAMES,
  'open_url', 'michi_docs', 'spawn_branches', 'save_artifact', 'update_artifact', 'show_image',
  'list_threads', 'search_messages', 'read_node', 'read_node_overview', 'read_conversation_updates',
  'report_conversation_no_change', 'inspect_pane', 'read_pane_output', 'list_panes', 'wait_pane', 'send_to_thread',
  'ask_user', 'set_follow_ups', 'set_branch_overview', 'set_title', 'validate_follow_ups', 'validate_turn_metadata',
  'submit_agent_result',
]);

/** Michi's MCP server as the runtimes name it: Claude and codex `__michi_internal__`, ACP agents `michi`. */
const MICHI_MCP_SERVERS: ReadonlySet<string> = new Set(['__michi_internal__', 'michi']);

/** ACP tool kinds that stay in the workspace; `execute`, `fetch` and `other` do not. */
const LOCAL_ACP_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'think', 'switch_mode']);
const ACP_KINDS: ReadonlySet<string> = new Set([...LOCAL_ACP_KINDS, 'execute', 'fetch', 'other']);

/** A raw MCP tool name, for a caller that passes one without its server. */
function mcpServerOfName(name: string): string | undefined {
  if (name.startsWith('mcp____michi_internal____')) return '__michi_internal__';
  if (name.startsWith('mcp_michi_')) return 'michi';
  return /^mcp__(.+?)__./.exec(name)?.[1] ?? /^@([^/\s]+)\/./.exec(name)?.[1] ?? /^mcp_([^_]+)_./.exec(name)?.[1];
}

/**
 * Whether a tool's output can carry instructions nobody in this chat wrote.
 * v1 rules, in order:
 * 1. web search / fetch, shell and code execution, cloud API tools: untrusted
 *    (Michi's own web_search and fetch_content too);
 * 2. any other tool of Michi's (its MCP server's, or Pi's in-process tools): trusted;
 * 3. a tool of any other MCP server: untrusted;
 * 4. known runtime built-ins that read or edit workspace files, plan, ask
 *    the user or run a subagent: trusted;
 * 5. any other name, and a call without one, by its ACP kind: read / edit /
 *    delete / move / search / think / switch_mode are trusted; execute,
 *    fetch, other, no kind or a runtime's own kind (Claude's `tool`) are
 *    untrusted. So a tool Michi does not know is judged as outside content
 *    unless its runtime reports it as a workspace operation; the lists above
 *    keep ordinary coding turns trusted.
 */
export function classifyToolTrust(input: ToolTrustInput): ToolTrust {
  const name = typeof input.toolName === 'string' ? input.toolName.trim() : '';
  const byKind: ToolTrust = input.kind && LOCAL_ACP_KINDS.has(input.kind) ? 'trusted' : 'untrusted';
  if (!name) return byKind;
  if (UNTRUSTED_TOOL_NAMES.has(name)) return 'untrusted';
  const server = input.mcpServer || (input.hostTool === undefined ? mcpServerOfName(name) : undefined);
  const host = input.hostTool ?? (server ? MICHI_MCP_SERVERS.has(server) : MICHI_TOOL_NAMES.has(name));
  if (host) return 'trusted';
  if (server || input.hostTool === false) return 'untrusted';
  return TRUSTED_TOOL_NAMES.has(name) ? 'trusted' : byKind;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Distinct sources kept per turn; one is enough to make it untrusted. */
const MAX_SOURCES_PER_TURN = 50;
const MAX_FIELD_CHARS = 500;
/** Turns whose judged tool calls and recorded sources this process remembers. */
const MAX_TRACKED_TURNS = 256;
const MAX_CALLS_PER_TURN = 4096;

interface TrackedTurn {
  /** Tool calls already judged. */
  calls: Set<string>;
  /** Sources already recorded (keys). */
  recorded: Set<string>;
  /** Sources that did not reach the database (none open, or the write failed): still reported by getTurnTrust. */
  unsaved: Map<string, TrustSource>;
}
const tracked = new Map<string, TrackedTurn>();

const turnKey = (ref: TurnRef): string => `${ref.nodeId}\u0000${ref.turnId}`;
const sourceKey = (source: TrustSource): string => JSON.stringify([source.tool, source.runtimeId, source.detail ?? null]);

function trackedTurn(ref: TurnRef): TrackedTurn {
  const key = turnKey(ref);
  let turn = tracked.get(key);
  if (!turn) {
    turn = { calls: new Set(), recorded: new Set(), unsaved: new Map() };
    tracked.set(key, turn);
    if (tracked.size > MAX_TRACKED_TURNS) tracked.delete(tracked.keys().next().value!);
  }
  return turn;
}

function clip(value: string): string {
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function validRef(ref: TurnRef): boolean {
  return typeof ref?.nodeId === 'string' && ref.nodeId.length > 0 && typeof ref.turnId === 'string' && ref.turnId.length > 0;
}

function normalizeSource(source: TrustSource): TrustSource {
  const detail = typeof source.detail === 'string' && source.detail.trim() ? clip(source.detail.trim()) : undefined;
  return {
    tool: clip(String(source.tool ?? '').trim() || 'unknown'),
    runtimeId: clip(String(source.runtimeId ?? '').trim() || 'unknown'),
    ...(detail ? { detail } : {}),
  };
}

const INSERT_SOURCE = `INSERT OR IGNORE INTO turn_trust (node_id, turn_id, source_key, tool, runtime_id, detail, recorded_at)
  SELECT ?, ?, ?, ?, ?, ?, ?
  WHERE (SELECT COUNT(*) FROM turn_trust WHERE node_id = ? AND turn_id = ?) < ?`;

function insertSource(db: DatabaseSync, ref: TurnRef, key: string, source: TrustSource): void {
  db.prepare(INSERT_SOURCE).run(ref.nodeId, ref.turnId, key, source.tool, source.runtimeId, source.detail ?? null,
    Date.now(), ref.nodeId, ref.turnId, MAX_SOURCES_PER_TURN);
}

/** Records the source once per turn; `db` null keeps it in memory only. Throws when the write fails. */
function record(db: DatabaseSync | null, ref: TurnRef, source: TrustSource): void {
  const normalized = normalizeSource(source);
  const key = sourceKey(normalized);
  const turn = trackedTurn(ref);
  if (turn.recorded.has(key)) return;
  // Past the cap the database's own limit applies; memory stays bounded.
  if (turn.recorded.size < MAX_CALLS_PER_TURN) turn.recorded.add(key);
  const keep = () => { if (turn.unsaved.size < MAX_SOURCES_PER_TURN) turn.unsaved.set(key, normalized); };
  if (!db) return keep();
  try {
    insertSource(db, ref, key, normalized);
  } catch (err) {
    // This process still reports the source; the error is the caller's.
    keep();
    throw err;
  }
}

/** Records that the turn consumed untrusted content. Repeats of a source are ignored. Throws when the write fails. */
export function recordUntrustedSource(ref: TurnRef, source: TrustSource): void {
  if (!validRef(ref)) throw new Error('recordUntrustedSource needs a nodeId and a turnId');
  record(getDb(), ref, source);
}

/** The untrusted sources a turn consumed, during the turn and after it. */
export function getTurnTrust(ref: TurnRef): { untrusted: boolean; sources: TrustSource[] } {
  if (!validRef(ref)) return { untrusted: false, sources: [] };
  const rows = getDb().prepare(
    'SELECT source_key, tool, runtime_id, detail FROM turn_trust WHERE node_id = ? AND turn_id = ? ORDER BY recorded_at, rowid',
  ).all(ref.nodeId, ref.turnId) as Array<{ source_key: string; tool: string; runtime_id: string; detail: string | null }>;
  const sources = new Map<string, TrustSource>();
  for (const row of rows) {
    sources.set(row.source_key, { tool: row.tool, runtimeId: row.runtime_id, ...(row.detail ? { detail: row.detail } : {}) });
  }
  for (const [key, source] of tracked.get(turnKey(ref))?.unsaved ?? []) {
    if (!sources.has(key)) sources.set(key, source);
  }
  const list = [...sources.values()];
  return { untrusted: list.length > 0, sources: list };
}

/**
 * The chat's running turn and what it consumed so far; null when the chat
 * has no running turn (or the node is not a chat). A caller that must not
 * act on untrusted input treats null as untrusted (agents/memoryTools.ts).
 */
export function activeTurnTrust(nodeId: string): { turnId: string; untrusted: boolean; sources: TrustSource[] } | null {
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const row = getDb().prepare(
    "SELECT turn_id FROM turns WHERE node_id = ? AND status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).get(nodeId) as { turn_id: string } | undefined;
  if (!row) return null;
  return { turnId: row.turn_id, ...getTurnTrust({ nodeId, turnId: row.turn_id }) };
}

// ---------------------------------------------------------------------------
// Runtime events (chatHub)
// ---------------------------------------------------------------------------

/** A title that names the web, for a call with neither name nor web kind. */
const WEB_TITLE = /\b(web|https?:\/\/|url|fetch|browse|internet)\b/i;

interface ObservedCall { id: string; input: Omit<ToolTrustInput, 'runtimeId'>; source: Omit<TrustSource, 'runtimeId'> }

function observedCall(ev: NormalizedEvent): ObservedCall | null {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_call_update') {
    const toolName = ev.toolName?.trim() ?? '';
    const title = typeof ev.title === 'string' ? ev.title : '';
    // An ACP kind whose title names the web is a fetch, whatever the agent called it.
    const kind = ev.kindType && ACP_KINDS.has(ev.kindType) && WEB_TITLE.test(title) ? 'fetch' : ev.kindType;
    if (toolName) {
      return {
        id: ev.toolCallId,
        input: { toolName, mcpServer: ev.mcpServer ?? null, ...(ev.hostTool !== undefined ? { hostTool: ev.hostTool } : {}), ...(kind ? { kind } : {}) },
        source: { tool: toolName, ...(ev.mcpServer ? { detail: `mcp:${ev.mcpServer}` } : {}) },
      };
    }
    // No name: an ACP kind is all there is. Anything else (a later update
    // of a call already judged, a delta) has nothing to judge.
    if (!kind || !ACP_KINDS.has(ev.kindType ?? '')) return null;
    return { id: ev.toolCallId, input: { toolName: '', kind }, source: { tool: kind, ...(title ? { detail: title } : {}) } };
  }
  if (ev.kind === 'subagent_tool_activity') {
    const toolName = ev.toolKind?.trim();
    if (!toolName || ev.activityKind === 'message') return null;
    return {
      id: `subagent\u0000${ev.subagentSessionId}\u0000${ev.toolCallId ?? toolName}`,
      input: { toolName },
      source: { tool: toolName, detail: `subagent:${ev.subagentSessionId}` },
    };
  }
  return null;
}

function nodeRuntimeId(db: DatabaseSync, nodeId: string): string {
  const row = db.prepare('SELECT runtime_id FROM nodes WHERE id = ?').get(nodeId) as { runtime_id: string | null } | undefined;
  return row?.runtime_id || 'unknown';
}

/**
 * chatHub's hook: judges a runtime event of the turn and records an
 * untrusted tool. Each tool call is judged once, when the event first names
 * it. Writes only into an already open database (never opens one) and never
 * throws: trust bookkeeping must not fail a turn.
 */
export function observeTurnTrust(ref: TurnRef, runtimeId: string | undefined, ev: NormalizedEvent): void {
  try {
    const call = observedCall(ev);
    if (!call || !validRef(ref)) return;
    const turn = trackedTurn(ref);
    if (call.id && turn.calls.has(call.id)) return;
    const verdict = classifyToolTrust({ runtimeId: runtimeId ?? 'unknown', ...call.input });
    // A nameless call judged trusted by its kind is judged again once an update names it.
    if (call.id && (call.input.toolName || verdict === 'untrusted') && turn.calls.size < MAX_CALLS_PER_TURN) turn.calls.add(call.id);
    if (verdict === 'trusted') return;
    const db = openDbOrNull();
    const source = { ...call.source, runtimeId: runtimeId ?? (db ? nodeRuntimeId(db, ref.nodeId) : 'unknown') };
    if (db) recordUntrustedSource(ref, source);
    else record(null, ref, source);
  } catch (err) {
    log.warn('chat', 'turn trust record failed', {
      nodeId: ref?.nodeId, turnId: ref?.turnId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
