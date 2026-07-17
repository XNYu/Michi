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

type BucketKey = 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'unknown';

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
  read:    { verb: 'Read',    noun: 'file' },
  edit:    { verb: 'Edited',  noun: 'file' },
  write:   { verb: 'Created', noun: 'file' },
  bash:    { verb: 'Ran',     noun: 'command' },
  grep:    { verb: 'Searched', noun: 'pattern' },
  glob:    { verb: 'Listed',  noun: 'path' },
  unknown: { verb: 'Used',    noun: 'tool' },
};

function bucketKeyForTool(tool: ToolCallState): BucketKey {
  const candidate = (tool.kind || tool.title.split(/\s+/)[0] || '').toLowerCase();
  if (candidate in BUCKETS) return candidate as BucketKey;
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
 * If `subagents` is empty/undefined the input is returned as-is, so this
 * is safe to call unconditionally on every tool group.
 */
export function filterSubagentRelayedTools(
  tools: readonly ToolCallState[],
  subagents: readonly SubagentInfo[] | undefined,
): ToolCallState[] {
  if (!subagents || subagents.length === 0) return [...tools];
  return tools.filter((tool) => {
    // Always keep SubAgent tool-calls; they ARE the card.
    if (subagentToolInfo(tool)) return true;
    // Drop everything else when ANY subagent is active. The peer rows
    // are forwarded subagent activity surfaced via the card's Now: line.
    return false;
  });
}

/**
 * Strips the `mcp__<server>__` prefix that Claude CLI prepends to MCP tool
 * names so a chip reads `list_threads` instead of
 * `mcp__michi-tools__list_threads`. Server names may contain hyphens; the
 * segment separator is always `__`, and tool names use single underscores, so
 * splitting on `__` keeps the tool segment intact. Non-MCP titles pass through.
 */
export function prettifyToolTitle(title: string): string {
  if (!title.startsWith('mcp__')) return title;
  const parts = title.split('__');
  if (parts.length < 3) return title;
  return parts.slice(2).join('__');
}

export function summarizeTools(tools: ToolCallState[]): string {
  if (tools.length === 0) return '';
  const failed = tools.filter((t) => isFailedStatus(t.status)).length;

  const subagentInfos = tools.map(subagentToolInfo);
  if (tools.length === 1 && subagentInfos[0]) {
    return `${subagentHeading(subagentInfos[0])} · ${subagentStatusLabel(tools[0].status)}`;
  }
  if (tools.length > 1 && subagentInfos.every(Boolean)) {
    const running = tools.filter((t) => isRunningStatus(t.status)).length;
    if (running > 0) return `${tools.length} SubAgents · ${running} working`;
    if (failed > 0) return `${tools.length} SubAgents · ${failed} failed`;
    return `${tools.length} SubAgents · completed`;
  }

  if (tools.length === 1) {
    const failedSuffix = failed > 0 ? ' · failed' : '';
    const title = prettifyToolTitle(tools[0].title) || BUCKETS[bucketKeyForTool(tools[0])].verb;
    return `${title}${failedSuffix}`;
  }

  const failedSuffix = failed > 0 ? ` · ${failed} failed` : '';

  const counts = new Map<BucketKey, number>();
  for (const tool of tools) {
    const key = bucketKeyForTool(tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // Single bucket → "Read 3 files"
  if (counts.size === 1) {
    const [key, count] = counts.entries().next().value as [BucketKey, number];
    const def = BUCKETS[key];
    return `${def.verb} ${count} ${pluralize(def.noun, count)}${failedSuffix}`;
  }

  // Multi-bucket → "Read 2 files, ran 1 command"
  // First bucket capitalized, subsequent lowercased.
  const phrases: string[] = [];
  let first = true;
  for (const [key, count] of counts.entries()) {
    const def = BUCKETS[key];
    const verb = first ? def.verb : def.verb.toLowerCase();
    phrases.push(`${verb} ${count} ${pluralize(def.noun, count)}`);
    first = false;
  }
  return `${phrases.join(', ')}${failedSuffix}`;
}
