import type { NormalizedEvent } from '../../services/chatEvents';

// Wire notification method names — inlined to avoid importing codexProtocol
// (parallel tasks may not have created it yet). Will be consolidated later.
const N = {
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeOutputDelta: 'item/fileChange/outputDelta',
  mcpToolCallProgress: 'item/mcpToolCall/progress',
  planDelta: 'item/plan/delta',
  turnPlanUpdated: 'turn/plan/updated',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  compactStarted: 'thread/compact/start',
  compactCompleted: 'thread/compact/completed',
  error: 'error',
  mcpStartupStatus: 'mcpServer/startupStatus/updated',
} as const;

const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);

/**
 * Grapheme-safe 200-character cap on a detail string.
 * Array.from() correctly segments Unicode surrogate pairs and combining marks.
 */
function cap(detail: unknown): string {
  return Array.from(String(detail)).slice(0, 200).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  const message = stringField(value, 'message');
  const details = stringField(value, 'additionalDetails');
  if (message && details && details !== message) return `${message}: ${details}`;
  return message ?? details;
}

const MAX_TOOL_PAYLOAD = 16 * 1024;

function truncatePayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  const str = typeof value === 'string' ? value : safeJson(value);
  if (!str) return undefined;
  return str.length > MAX_TOOL_PAYLOAD ? str.slice(0, MAX_TOOL_PAYLOAD) : str;
}

function extractCodexPurpose(item: Record<string, unknown>): string | undefined {
  const itemType = stringField(item, 'type') ?? '';
  if (itemType === 'commandExecution') {
    const cmd = stringField(item, 'command');
    if (cmd) return cmd;
  }
  if (itemType === 'webSearch') {
    const query = stringField(item, 'query');
    if (query) return `Search: ${query}`;
  }
  return undefined;
}

function pathBasename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1];
}

function pathParentBasename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function readablePathTarget(path: string | undefined, fallback: string | undefined): string | undefined {
  const base = pathBasename(path) ?? fallback;
  if (base?.toLowerCase() === 'skill.md') {
    return pathParentBasename(path) ?? base;
  }
  return fallback && fallback.toLowerCase() !== 'skill.md' ? fallback : base;
}

interface ToolPresentation {
  title: string;
  kindType: string;
  detail: string;
}

function commandActionPresentation(action: Record<string, unknown>): Pick<ToolPresentation, 'title' | 'kindType'> | null {
  const actionType = stringField(action, 'type');
  if (actionType === 'read') {
    const target = readablePathTarget(stringField(action, 'path'), stringField(action, 'name'));
    return { title: target ? `Read ${target}` : 'Read file', kindType: 'read' };
  }
  if (actionType === 'listFiles') {
    const target = pathBasename(stringField(action, 'path'));
    return { title: target ? `List ${target}` : 'List files', kindType: 'glob' };
  }
  if (actionType === 'search') {
    const query = stringField(action, 'query');
    return { title: query ? `Search ${query}` : 'Search files', kindType: 'grep' };
  }
  if (actionType === 'unknown') {
    return { title: 'Shell', kindType: 'bash' };
  }
  return null;
}

function firstCommandAction(item: Record<string, unknown>): Record<string, unknown> | null {
  const actions = item['commandActions'];
  if (!Array.isArray(actions)) return null;
  const first = actions.find(isRecord);
  return first ?? null;
}

function fileChangeTitle(item: Record<string, unknown>): string {
  const changes = item['changes'];
  if (!Array.isArray(changes) || changes.length === 0) return 'Edit files';
  const first = changes.find(isRecord);
  const path = first ? stringField(first, 'path') : undefined;
  const target = pathBasename(path);
  if (changes.length === 1 && target) return `Edit ${target}`;
  return `Edit ${changes.length} files`;
}

function webSearchTitle(item: Record<string, unknown>): string {
  const query = stringField(item, 'query');
  if (query) return `Search ${query}`;
  const action = item['action'];
  if (isRecord(action)) {
    const actionQuery = stringField(action, 'query');
    if (actionQuery) return `Search ${actionQuery}`;
    const url = stringField(action, 'url');
    if (url) return `Open ${url}`;
  }
  return 'Web search';
}

function toolPresentation(item: Record<string, unknown>): ToolPresentation {
  const itemType = stringField(item, 'type') ?? 'tool';
  if (itemType === 'commandExecution') {
    const action = firstCommandAction(item);
    const presentation = action ? commandActionPresentation(action) : null;
    return {
      title: presentation?.title ?? 'Shell',
      kindType: presentation?.kindType ?? 'bash',
      detail: item['command'] !== undefined ? cap(item['command']) : '',
    };
  }
  if (itemType === 'fileChange') {
    return {
      title: fileChangeTitle(item),
      kindType: 'edit',
      detail: item['changes'] !== undefined ? cap(safeJson(item['changes'])) : '',
    };
  }
  if (itemType === 'mcpToolCall') {
    return {
      title: stringField(item, 'tool') ?? 'MCP tool',
      kindType: 'tool',
      detail: item['arguments'] !== undefined
        ? cap(safeJson(item['arguments']))
        : item['args'] !== undefined
          ? cap(safeJson(item['args']))
          : '',
    };
  }
  if (itemType === 'dynamicToolCall') {
    const tool = stringField(item, 'tool') ?? 'Tool';
    const namespace = stringField(item, 'namespace');
    return {
      title: namespace ? `${namespace}.${tool}` : tool,
      kindType: 'tool',
      detail: item['arguments'] !== undefined ? cap(safeJson(item['arguments'])) : '',
    };
  }
  if (itemType === 'webSearch') {
    return {
      title: webSearchTitle(item),
      kindType: 'tool',
      detail: item['query'] !== undefined ? cap(item['query']) : '',
    };
  }
  return { title: itemType, kindType: 'tool', detail: '' };
}

export interface CodexTranslatorHandle {
  feed: (method: string, params: Record<string, unknown>) => void;
  startTurn: () => void;
}

/**
 * Creates a stateful translator that converts codex app-server wire
 * notifications into Michi NormalizedEvents.
 *
 * Pure in terms of side-effects: the only observable output is through `emit`.
 * No I/O; state is limited to a turn-start timestamp.
 */
export function createCodexTranslator(emit: (ev: NormalizedEvent) => void): CodexTranslatorHandle {
  let turnStartMs: number = Date.now();
  let lastRuntimeError: string | undefined;
  let lastReasoningSummaryPartKey: string | undefined;
  // Last context-window fill % observed from tokenUsageUpdated this turn, so
  // the turn-end usage_summary can report it instead of a hardcoded 0
  // (matches claudeEventTranslator). Persists across turns because the
  // context window is cumulative — a turn with no token update should still
  // report the last known fill.
  let lastContextUsagePercentage = 0;
  const outputBuffers = new Map<string, string>();
  const toolPresentations = new Map<string, ToolPresentation>();

  function startTurn(): void {
    turnStartMs = Date.now();
    lastRuntimeError = undefined;
    lastReasoningSummaryPartKey = undefined;
    outputBuffers.clear();
    toolPresentations.clear();
  }

  function appendOutput(itemId: string, delta: string): string {
    const prev = outputBuffers.get(itemId) ?? '';
    const next = prev + delta;
    outputBuffers.set(itemId, next);
    return cap(next.length > 200 ? next.slice(-200) : next);
  }

  function feed(method: string, params: Record<string, unknown>): void {
    // Guard: always treat params as a plain object, never throw on missing keys.
    const p = params ?? {};

    switch (method) {
      // ── Text streaming ──────────────────────────────────────────────────────

      case N.agentMessageDelta: {
        const text = typeof p['delta'] === 'string' ? p['delta'] : '';
        if (text) emit({ kind: 'chunk', text });
        break;
      }

      case N.reasoningSummaryTextDelta: {
        const text = typeof p['delta'] === 'string' ? p['delta'] : '';
        if (!text) break;

        // summaryIndex is scoped to a reasoning item and commonly resets to 0
        // after a tool call. The item + index pair identifies the real summary
        // part boundary, including transitions between separate reasoning items.
        const itemId = typeof p['itemId'] === 'string' ? p['itemId'] : '';
        const summaryIndex = typeof p['summaryIndex'] === 'number' ? p['summaryIndex'] : 0;
        const partKey = `${itemId}:${summaryIndex}`;
        if (lastReasoningSummaryPartKey !== undefined && lastReasoningSummaryPartKey !== partKey) {
          emit({ kind: 'thought', text: '\n' });
        }
        lastReasoningSummaryPartKey = partKey;
        emit({ kind: 'thought', text });
        break;
      }

      case N.reasoningTextDelta: {
        const text = typeof p['delta'] === 'string' ? p['delta'] : '';
        if (text) emit({ kind: 'thought', text });
        break;
      }

      // ── Item lifecycle ──────────────────────────────────────────────────────

      case N.itemStarted: {
        const item = (p['item'] ?? p) as Record<string, unknown>;
        const itemType = typeof item['type'] === 'string' ? item['type'] : '';
        if (itemType === 'compaction' || itemType === 'context_compaction') {
          emit({ kind: 'compaction_start', detail: itemType });
          break;
        }
        if (!TOOL_ITEM_TYPES.has(itemType)) {
          // Streamed items (agentMessage, reasoning) — deltas arrive separately
          break;
        }
        const id = typeof item['id'] === 'string' ? item['id'] : '';
        const presentation = toolPresentation(item);
        if (id) toolPresentations.set(id, presentation);
        emit({
          kind: 'tool_call',
          toolCallId: id,
          title: presentation.title,
          status: 'in_progress',
          kindType: presentation.kindType,
          detail: extractCodexPurpose(item) ?? presentation.detail,
          inputJson: truncatePayload(item),
        });
        break;
      }

      case N.itemCompleted: {
        const item = (p['item'] ?? p) as Record<string, unknown>;
        const itemType = typeof item['type'] === 'string' ? item['type'] : '';
        if (itemType === 'compaction' || itemType === 'context_compaction') {
          emit({ kind: 'compaction_end', detail: itemType });
          break;
        }
        if (!TOOL_ITEM_TYPES.has(itemType)) break;
        const id = typeof item['id'] === 'string' ? item['id'] : '';
        const status = item['status'] === 'failed' ? 'failed' : 'completed';
        const presentation = toolPresentation(item);
        if (id) toolPresentations.set(id, presentation);
        const rawOutput = item['aggregatedOutput'] ?? item['output'] ?? item['result'] ?? item['error'];
        const detail = rawOutput !== undefined ? cap(rawOutput) : '';
        emit({
          kind: 'tool_call_update',
          toolCallId: id,
          title: presentation.title,
          status,
          kindType: presentation.kindType,
          detail,
          output: truncatePayload(rawOutput),
        });
        break;
      }

      // ── Output deltas ───────────────────────────────────────────────────────

      case N.mcpToolCallProgress: {
        const itemId = typeof p['itemId'] === 'string' ? p['itemId'] : '';
        const message = typeof p['message'] === 'string' ? p['message'] : '';
        if (!message) break;
        const detail = appendOutput(itemId, message);
        emit({
          kind: 'tool_call_update',
          toolCallId: itemId,
          title: '',
          status: 'in_progress',
          kindType: toolPresentations.get(itemId)?.kindType,
          detail,
        });
        break;
      }

      case N.commandOutputDelta:
      case N.fileChangeOutputDelta: {
        const itemId = typeof p['itemId'] === 'string' ? p['itemId'] : '';
        const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
        if (!delta) break;
        const detail = appendOutput(itemId, delta);
        emit({
          kind: 'tool_call_update',
          toolCallId: itemId,
          title: '',
          status: 'in_progress',
          kindType: toolPresentations.get(itemId)?.kindType,
          detail,
        });
        break;
      }

      // ── Token / context usage ───────────────────────────────────────────────

      case N.tokenUsageUpdated: {
        const total = (p['total'] ?? p) as Record<string, unknown>;
        const window = p['modelContextWindow'];
        const modelContextWindow = typeof window === 'number' ? window : 0;
        if (modelContextWindow > 0) {
          const totalTokens =
            typeof total['totalTokens'] === 'number' ? total['totalTokens'] : 0;
          const contextUsagePercentage = (totalTokens / modelContextWindow) * 100;
          lastContextUsagePercentage = contextUsagePercentage;
          emit({ kind: 'context_usage', contextUsagePercentage });
        }
        break;
      }

      // ── Turn lifecycle ──────────────────────────────────────────────────────

      case N.turnStarted: {
        // Reset turn timer; nothing emitted outward.
        startTurn();
        break;
      }

      case N.turnCompleted: {
        const turnDurationMs = Date.now() - turnStartMs;
        const turn = (p['turn'] ?? p) as Record<string, unknown>;
        const stopReason = typeof turn['status'] === 'string' ? turn['status'] : undefined;
        emit({
          kind: 'usage_summary',
          contextUsagePercentage: lastContextUsagePercentage,
          totalCredits: 0,
          turnDurationMs,
          source: 'native',
        });
        if (stopReason === 'failed') {
          emit({
            kind: 'runtime_error',
            error: errorMessage(turn['error']) ?? lastRuntimeError ?? 'Codex turn failed',
          });
          lastRuntimeError = undefined;
          break;
        }
        emit({ kind: 'turn_end', stopReason: stopReason === 'interrupted' ? 'interrupted' : stopReason });
        lastRuntimeError = undefined;
        break;
      }

      case N.compactStarted: {
        emit({ kind: 'compaction_start', detail: 'thread/compact/start' });
        break;
      }

      case N.compactCompleted: {
        emit({ kind: 'compaction_end', detail: 'thread/compact/completed' });
        break;
      }

      // ── Error notifications ─────────────────────────────────────────────────

      case N.error: {
        // Codex reports turn/runtime failures as `{ error: TurnError, willRetry }`.
        // Keep the latest detail and let turn/completed decide whether the turn
        // actually failed; retryable notifications must not create a false MCP
        // banner or terminate a turn that later succeeds.
        lastRuntimeError = errorMessage(p['error']) ?? errorMessage(p) ?? 'Codex runtime error';
        break;
      }

      case N.mcpStartupStatus: {
        // Only surface failures; successful startups are informational.
        if (p['status'] === 'failed') {
          const serverName = typeof p['name'] === 'string' ? p['name'] : 'unknown';
          const error = typeof p['error'] === 'string' ? p['error'] : String(p['error'] ?? 'mcp startup failed');
          emit({ kind: 'mcp_server_error', serverName, error });
        }
        break;
      }

      // ── Forward-compat: ignore unrecognised methods ─────────────────────────
      default:
        break;
    }
  }

  return { feed, startTurn };
}
