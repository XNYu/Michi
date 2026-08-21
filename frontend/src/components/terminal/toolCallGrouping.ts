import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'pending']);
const FAILED_STATUSES = new Set(['error', 'failed']);
const SUBAGENT_TOOL_TITLES = new Set(['agent', 'task', 'subagent']);

/**
 * Internal metadata tools that Michi injects for structured data extraction
 * (title, follow-ups, branch overview). These are invisible plumbing — the
 * user sees their *effects* (a title appears, follow-up buttons render) but
 * should never see a "Running set_branch_overview" banner or a chip in the
 * tool group. Matches both raw MCP names and the prefixed variants from
 * different runtimes (mcp__michi-tools__*, mcp____michi_internal____*).
 */
const HIDDEN_INTERNAL_TOOLS = new Set([
  'set_branch_overview',
  'set_title',
  'set_follow_ups',
  'validate_follow_ups',
  'validate_turn_metadata',
]);

export function isHiddenInternalTool(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  // Direct match (Kiro ACP reports the bare tool name)
  if (HIDDEN_INTERNAL_TOOLS.has(normalized)) return true;
  // Claude prefixed: mcp____michi_internal____<tool>
  // Kiro MCP prefixed: mcp__michi-tools__<tool> or @michi/<tool>
  const stripped = prettifyToolTitle(normalized);
  if (HIDDEN_INTERNAL_TOOLS.has(stripped)) return true;
  // Codex App Server can report the MCP server and tool as one title without
  // the leading `mcp__`, e.g. `michi_internal____set_branch_overview`.
  // Accept only a real namespace separator so similarly-named user tools do
  // not get hidden accidentally.
  for (const tool of HIDDEN_INTERNAL_TOOLS) {
    if (!normalized.endsWith(tool)) continue;
    const prefix = normalized.slice(0, -tool.length);
    if (/(?:[/.:]|_{2,})$/.test(prefix)) return true;
  }
  // @server/tool format (some runtimes)
  const slashIdx = normalized.lastIndexOf('/');
  if (slashIdx >= 0 && HIDDEN_INTERNAL_TOOLS.has(normalized.slice(slashIdx + 1))) return true;
  return false;
}

export function isRunningStatus(status: string | undefined): boolean {
  if (!status) return true;
  return RUNNING_STATUSES.has(status);
}

export function isTerminalStatus(status: string | undefined): boolean {
  return !isRunningStatus(status);
}

export function isFailedStatus(status: string | undefined): boolean {
  if (!status) return false;
  return FAILED_STATUSES.has(status);
}

export type BucketKey = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'unknown';

interface BucketDef {
  verb: string;          // "Read", "Edited", "Ran"
  noun: string;          // "file", "command"
}

export interface SubagentToolInfo {
  agentType?: string;
  description?: string;
  prompt?: string;
  model?: string;
}

const BUCKETS: Record<BucketKey, BucketDef> = {
  read:    { verb: 'read',     noun: 'file' },
  edit:    { verb: 'edited',   noun: 'file' },
  write:   { verb: 'created',  noun: 'file' },
  bash:    { verb: 'ran',      noun: 'command' },
  grep:    { verb: 'searched', noun: 'pattern' },
  glob:    { verb: 'listed',   noun: 'path' },
  unknown: { verb: 'used',     noun: 'tool' },
};

export function toolBucketKey(tool: ToolCallState): BucketKey {
  // Try kind first, but fall through to the title when the kind is a value
  // outside our bucket set — Claude runtime reports kind 'tool' for
  // everything, kiro ACP uses kinds like 'execute'. Without the fallback a
  // Bash/Read title lands in 'unknown' and loses its icon + verb.
  const kind = (tool.kind || '').toLowerCase();
  if (kind in BUCKETS) return kind as BucketKey;
  const first = (tool.title.split(/\s+/)[0] || '').toLowerCase();
  if (first in BUCKETS) return first as BucketKey;
  if (kind === 'execute') return 'bash';
  return 'unknown';
}

function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  return `${noun}s`;
}

function compactWhitespace(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim();
  return compact || undefined;
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  const compact = compactWhitespace(value?.replace(/[_-]+/g, ' '));
  if (!compact) return undefined;
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

function objectStringField(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return compactWhitespace(value);
  }
  return undefined;
}

function decodeJsonStringFragment(fragment: string): string {
  try {
    return JSON.parse(`"${fragment}"`);
  } catch {
    return fragment
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function regexStringField(detail: string | undefined, keys: string[]): string | undefined {
  if (!detail) return undefined;
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = detail.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) return compactWhitespace(decodeJsonStringFragment(match[1]));
  }
  return undefined;
}

function parseDetailObject(detail: string | undefined): Record<string, unknown> | null {
  if (!detail?.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function detailField(
  detail: string | undefined,
  obj: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  return objectStringField(obj, keys) ?? regexStringField(detail, keys);
}

export function subagentToolInfo(tool: ToolCallState): SubagentToolInfo | null {
  const title = tool.title.trim().toLowerCase();
  const kind = tool.kind?.trim().toLowerCase();
  const detail = tool.detail;
  const detailObject = parseDetailObject(detail);
  // Only explicit subagent-type keys count. A bare `type` key must NOT be
  // treated as a subagent signal: a completed tool's `detail` is overwritten
  // with its result content (e.g. `[{"type":"text",...}]` for MCP tools), and
  // matching that `"type":"text"` would mislabel every MCP tool as
  // "SubAgent · Text".
  const rawAgentType = detailField(detail, detailObject, [
    'subagent_type',
    'subagentType',
    'agent_type',
    'agentType',
  ]);
  const hasSignal =
    SUBAGENT_TOOL_TITLES.has(title) ||
    kind === 'subagent' ||
    !!rawAgentType ||
    /"subagent_type"\s*:/.test(detail ?? '');

  if (!hasSignal) return null;

  return {
    agentType: humanizeIdentifier(rawAgentType),
    description: detailField(detail, detailObject, ['description', 'summary', 'goal', 'task']),
    prompt: detailField(detail, detailObject, ['prompt', 'query', 'instructions']),
    model: detailField(detail, detailObject, ['model']),
  };
}

export function subagentHeading(info: SubagentToolInfo): string {
  return info.agentType ? `SubAgent · ${info.agentType}` : 'SubAgent';
}

export function subagentStatusLabel(status: string | undefined): string {
  if (isFailedStatus(status)) return 'failed';
  if (isRunningStatus(status)) return 'working';
  return 'completed';
}

/**
 * Returns true if `tool` is a SubAgent tool-call (parent-session) that
 * plausibly corresponds to `subagent`. Match is best-effort: agentType
 * equality OR text overlap between the tool's description/prompt and the
 * subagent's `initialQuery`. False for non-subagent tools.
 */
export function subagentTitleMatches(tool: ToolCallState, subagent: SubagentInfo): boolean {
  const info = subagentToolInfo(tool);
  if (!info) return false;

  const agentTypeNorm = info.agentType?.toLowerCase().trim();
  const subAgentName = subagent.agentName?.toLowerCase().trim();
  if (agentTypeNorm && subAgentName && agentTypeNorm === subAgentName) return true;

  const initial = subagent.initialQuery?.trim();
  if (!initial) return false;

  const description = info.description?.trim();
  const prompt = info.prompt?.trim();

  return description === initial || prompt === initial;
}

export function findOwningSubagent(
  tool: ToolCallState,
  subagents: readonly SubagentInfo[] | undefined,
): SubagentInfo | undefined {
  if (!subagents || subagents.length === 0) return undefined;
  if (!subagentToolInfo(tool)) return undefined;
  return subagents.find((s) => subagentTitleMatches(tool, s));
}

/**
 * Drops parent-session tool-calls that conceptually belong to an active
 * subagent (Bash/Glob/Read forwarded for visibility). SubAgent tool-calls
 * themselves are always kept — they ARE the card.
 *
 * The filter applies ONLY while at least one subagent is actively working:
 * once every subagent has terminated, all tool-calls render normally. The
 * node-level `subagents` roster outlives the turn (cleared on the next
 * user send), and the main agent's own tool-calls (michi tools, reads made
 * after the subagents finished) must not be hidden by a stale roster.
 *
 * If `subagents` is empty/undefined the input is returned as-is, so this
 * is safe to call unconditionally on every tool group.
 */
export function filterSubagentRelayedTools(
  tools: readonly ToolCallState[],
  subagents: readonly SubagentInfo[] | undefined,
): ToolCallState[] {
  if (!subagents || subagents.length === 0) return [...tools];
  const anyWorking = subagents.some((s) => s.status === 'working');
  if (!anyWorking) return [...tools];
  return tools.filter((tool) => {
    // Always keep SubAgent tool-calls; they ARE the card.
    if (subagentToolInfo(tool)) return true;
    // Drop everything else while a subagent is working. The peer rows
    // are forwarded subagent activity surfaced via the card's Now: line.
    return false;
  });
}

/** Priority order for the one-line argument shown beside a tool name.
 *  Matches what each bucket's primary argument is (command for bash,
 *  file_path for read/edit, pattern for grep, …). */
const ROW_DETAIL_KEYS = [
  'command',
  'pattern',
  'file_path',
  'filePath',
  'path',
  'query',
  'url',
  'prompt',
  'description',
];

const ROW_DETAIL_MAX = 200;

function clampLine(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One-line human-readable argument for a tool row ("npm test", a file path,
 * a grep pattern). Sources, in order:
 *   1. the structured input (`inputJson`) — the primary argument key;
 *   2. `detail` when it's a plain purpose string (kiro's __tool_use_purpose);
 *   3. `detail` parsed as JSON — Claude runtime backfills detail with a raw
 *      input dump, and completed MCP tools overwrite it with result content,
 *      so a raw `detail` is only trusted after extraction, never verbatim.
 */
export function toolRowDetail(tool: ToolCallState): string | undefined {
  const input = tool.inputJson;
  if (input?.trim().startsWith('{')) {
    const fromInput = detailField(input, parseDetailObject(input), ROW_DETAIL_KEYS);
    if (fromInput) return clampLine(fromInput, ROW_DETAIL_MAX);
  }
  const detail = compactWhitespace(tool.detail);
  if (detail && !/^[[{]/.test(detail)) return clampLine(detail, ROW_DETAIL_MAX);
  if (detail?.startsWith('{')) {
    const fromDetail = detailField(tool.detail, parseDetailObject(tool.detail), ROW_DETAIL_KEYS);
    if (fromDetail) return clampLine(fromDetail, ROW_DETAIL_MAX);
  }
  return undefined;
}

/**
 * Short MCP tool names for chips.
 * Claude: `mcp__michi-tools__list_threads` → `list_threads`
 * Cursor: `michi-list_threads: list_threads` → `list_threads`
 * Grok / bare: `michi__list_threads` or `michi-list_threads` → `list_threads`
 * Non-MCP titles pass through.
 */
export function prettifyToolTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return title;

  const cursorPrefixed = trimmed.match(/^michi[-_][\w.-]+:\s*([\w.-]+)$/i);
  if (cursorPrefixed) return cursorPrefixed[1];

  if (trimmed.startsWith('mcp__')) {
    const parts = trimmed.split('__');
    if (parts.length >= 3) return parts.slice(2).join('__');
  }

  const michiPrefixed = trimmed.match(/^michi(?:__|-)(.+)$/i);
  if (michiPrefixed) return michiPrefixed[1];

  return trimmed;
}

export function failedToolCount(tools: readonly ToolCallState[]): number {
  return tools.reduce((n, t) => n + (isFailedStatus(t.status) ? 1 : 0), 0);
}

/**
 * Duration of a single tool call, from projection-stamped timestamps.
 * Undefined for turns persisted before timestamps existed.
 */
export function toolDurationMs(tool: ToolCallState): number | undefined {
  if (tool.startedAt == null || tool.endedAt == null) return undefined;
  const d = tool.endedAt - tool.startedAt;
  return d >= 0 ? d : undefined;
}

/**
 * Wall-clock span of a group: earliest startedAt → latest endedAt across
 * tools that carry timestamps. Undefined when none do.
 */
export function toolSpanMs(tools: readonly ToolCallState[]): number | undefined {
  let min: number | undefined;
  let max: number | undefined;
  for (const t of tools) {
    if (t.startedAt != null) min = min == null ? t.startedAt : Math.min(min, t.startedAt);
    if (t.endedAt != null) max = max == null ? t.endedAt : Math.max(max, t.endedAt);
  }
  if (min == null || max == null || max < min) return undefined;
  return max - min;
}

/** "0.3s" below 10s, "12s" below 1m, "1m 12s" beyond. */
export function formatDurationMs(ms: number): string {
  if (ms < 10_000) return `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Base summary without the failed-count suffix, so renderers can color the
 * failure fragment independently (color marks state, never whole rows).
 */
export function summarizeToolsBase(tools: ToolCallState[]): string {
  if (tools.length === 0) return '';

  const subagentInfos = tools.map(subagentToolInfo);
  if (tools.length === 1 && subagentInfos[0]) {
    return `${subagentHeading(subagentInfos[0])} · ${subagentStatusLabel(tools[0].status)}`;
  }
  if (tools.length > 1 && subagentInfos.every(Boolean)) {
    const running = tools.filter((t) => isRunningStatus(t.status)).length;
    const failed = failedToolCount(tools);
    if (running > 0) return `${tools.length} SubAgents · ${running} working`;
    if (failed > 0) return `${tools.length} SubAgents`;
    return `${tools.length} SubAgents · completed`;
  }

  if (tools.length === 1) {
    return prettifyToolTitle(tools[0].title) || BUCKETS[toolBucketKey(tools[0])].verb;
  }

  const counts = new Map<BucketKey, number>();
  for (const tool of tools) {
    const key = toolBucketKey(tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Single bucket → "read 3 files"
  if (counts.size === 1) {
    const [key, count] = counts.entries().next().value as [BucketKey, number];
    const def = BUCKETS[key];
    return `${def.verb} ${count} ${pluralize(def.noun, count)}`;
  }

  // Multi-bucket → "read 2 files, ran 1 command"
  const phrases: string[] = [];
  for (const [key, count] of counts.entries()) {
    const def = BUCKETS[key];
    phrases.push(`${def.verb} ${count} ${pluralize(def.noun, count)}`);
  }
  return phrases.join(', ');
}

export function summarizeTools(tools: ToolCallState[]): string {
  if (tools.length === 0) return '';
  const base = summarizeToolsBase(tools);
  const failed = failedToolCount(tools);
  if (failed === 0) return base;
  if (tools.length === 1) {
    // A single SubAgent's base already carries its status label ("· failed").
    return subagentToolInfo(tools[0]) ? base : `${base} · failed`;
  }
  return `${base} · ${failed} failed`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanJsonValues(obj: unknown): unknown {
  if (typeof obj === 'string' && /<[a-z][\s\S]*>/i.test(obj)) {
    return stripHtml(obj);
  }
  if (Array.isArray(obj)) return obj.map(cleanJsonValues);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = cleanJsonValues(v);
    }
    return out;
  }
  return obj;
}

/** Pretty-print a tool payload: JSON re-indented with HTML-bearing string
 *  values stripped to text; non-JSON passes through verbatim. */
export function formatToolPayload(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const cleaned = cleanJsonValues(parsed);
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return raw;
  }
}
