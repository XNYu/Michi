import { extractToolUsePurpose, type SubagentInfo } from 'michi-shared';
import { NormalizedEvent } from '../../contract/events';
import { ClaudeEnvelope } from './claudeEnvelopeParser';
import { getClaudeModelEntry } from './claudeModelCatalog';
import { createClaudeSubagentTracker } from './claudeSubagentTracker';
import { claudeToolIdentity } from './claudeMcpConfig';

/** The model a turn's context share is measured against until the CLI names its own. */
export const CLAUDE_FALLBACK_MODEL = 'claude-sonnet-4-6-20250514';

interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function computeContextPct(usage: UsageShape, modelName: string, contextWindow?: number): number {
  const { entry } = getClaudeModelEntry(modelName);
  const used =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return Math.min(100, (used / (contextWindow ?? entry.contextWindow)) * 100);
}

/** A message's usage is one API call; result.usage sums every call in the turn. */
function messageUsage(value: unknown): UsageShape | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const usage: UsageShape = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) usage[key] = n;
  }
  // Output-only deltas cannot tell us the size of the input context.
  return usage.input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
    || usage.cache_read_input_tokens !== undefined ? usage : undefined;
}

function reportedContextWindow(env: ClaudeEnvelope, modelName: string): number | undefined {
  const models = env['modelUsage'];
  if (!models || typeof models !== 'object') return undefined;
  const modelKey = (id: string) => id.toLowerCase().replace(/^.*(?=claude-)/, '').replace(/\[\d+m\]$/, '');
  for (const [id, value] of Object.entries(models)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (id !== modelName && modelKey(id) !== modelKey(modelName)
      && entry.canonicalModel !== modelName) continue;
    const window = entry.contextWindow;
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) return window;
  }
  return undefined;
}

/** A turn's token counts, in the usage_summary fields Codex also reports. */
interface TurnTokens {
  totalTokens: number;
  /** Every input token the turn's calls read: uncached, cache reads and cache writes. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Thinking tokens, already counted in outputTokens. */
  reasoningOutputTokens?: number;
}

/**
 * The token counts of a result's `usage`: the main agent loop of that turn
 * only (subagents report their own totals on the roster). The CLI's cost
 * figures are list-price estimates (`costBasis: 'list'`), so no cost is
 * derived from them or from a local price table.
 */
function resultTokens(value: unknown): TurnTokens | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
  const input = count(raw.input_tokens);
  const cacheRead = count(raw.cache_read_input_tokens);
  const cacheCreation = count(raw.cache_creation_input_tokens);
  const output = count(raw.output_tokens);
  if (input === undefined && cacheRead === undefined && cacheCreation === undefined && output === undefined) return undefined;
  const details = raw.output_tokens_details;
  const thinking = details && typeof details === 'object' ? count((details as Record<string, unknown>).thinking_tokens) : undefined;
  const inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return {
    totalTokens: inputTokens + (output ?? 0),
    inputTokens,
    cachedInputTokens: cacheRead ?? 0,
    outputTokens: output ?? 0,
    ...(thinking !== undefined ? { reasoningOutputTokens: thinking } : {}),
  };
}

function addTokens(a: TurnTokens | undefined, b: TurnTokens | undefined): TurnTokens | undefined {
  if (!a || !b) return a ?? b;
  const reasoning = a.reasoningOutputTokens === undefined && b.reasoningOutputTokens === undefined
    ? undefined : (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0);
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

/** What the last native compaction reported (system status + compact_boundary). */
export interface ClaudeCompaction {
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  result?: 'success' | 'failed';
  error?: string;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

const MAX_TOOL_PAYLOAD = 16 * 1024;

function truncatePayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return undefined;
  return str.length > MAX_TOOL_PAYLOAD ? str.slice(0, MAX_TOOL_PAYLOAD) : str;
}

export interface TranslatorHandle {
  feed: (env: ClaudeEnvelope) => void;
  startTurn: () => void;
  getSessionId: () => string | null;
  /** Last persisted parent assistant envelope in this complete Michi turn. */
  getForkAnchor: () => string | null;
  getAccumulatedUsage: () => UsageShape;
  /** See ClaudeSubagentTracker.hasBackgroundWork. */
  hasBackgroundSubagents: () => boolean;
  /** See ClaudeSubagentTracker.pendingBackground. */
  pendingBackgroundSubagents: () => SubagentInfo[];
  /** The compaction reported since the last call, if any; clears it. */
  takeCompaction: () => ClaudeCompaction | null;
  /**
   * End a host turn whose last result was held (TranslatorOptions.holdTurnEnd)
   * when no further CLI turn follows: its summary and turn_end, as that
   * result would have emitted them.
   */
  releaseHeldTurn: () => void;
}

export interface TranslatorOptions {
  /** See ClaudeSubagentTrackerOptions.onBackgroundChange. */
  onBackgroundSubagents?: (sessionIds: string[]) => void;
  /**
   * Asked at each successful `result`. True: the CLI runs another turn for
   * input the host sent during this one (a steer that was not folded in), so
   * this result is not the end of the host's turn. Its tokens are carried
   * into the summary of the result that ends it, and no turn_end is emitted.
   */
  holdTurnEnd?: () => boolean;
}

export function createTranslator(emit: (ev: NormalizedEvent) => void, options: TranslatorOptions = {}): TranslatorHandle {
  let claudeSessionId: string | null = null;
  let forkAnchor: string | null = null;
  let turnStartMs: number = Date.now();
  let modelName: string = CLAUDE_FALLBACK_MODEL;
  let latestUsage: UsageShape | undefined;
  /** Tokens of held results (see TranslatorOptions.holdTurnEnd) in this host turn. */
  let carriedTokens: TurnTokens | undefined;
  let compacting = false;
  let compaction: ClaudeCompaction | null = null;
  const contextWindows = new Map<string, number>();
  const contextPct = (usage: UsageShape) => computeContextPct(usage, modelName, contextWindows.get(modelName));
  const seenUnknownModels = new Set<string>();

  // Track which content-block index produced the last text/thinking delta so
  // that when the assistant emits multiple text (or thinking) blocks in one
  // turn — separated by tool_use blocks — we can insert a paragraph break
  // between them. Without this, the trailing "." of block N collides with the
  // leading word of block N+1 in the rendered transcript.
  //
  // Pi/Kiro use the same chunk/thought string-concat path on the frontend but
  // don't need this fix: a Pi turn closes after each LLM call so multi-text
  // splits never share an assistantId, and Kiro's agent_message_chunk carries
  // one block at a time without an intra-message index to collide on. Only
  // Claude packs "text → tool_use → text" into a single assistant message.
  let lastTextIndex: number | null = null;
  let lastThinkingIndex: number | null = null;

  // Tool-use blocks that have already been emitted from stream_event
  // content_block_start. The trailing `assistant` envelope re-iterates the
  // full content[] including these blocks; without this set we would emit
  // each tool_call twice and (worse) record textOffset = end-of-message for
  // the late copy, causing chips to pool at the bottom of the transcript.
  const streamedToolUseIds = new Set<string>();

  // In-session subagents (the Agent/Task tool). With --forward-subagent-text
  // the CLI forwards each subagent's messages as top-level envelopes carrying
  // `parent_tool_use_id`; the tracker turns those, the parent tool input, the
  // system task_* lifecycle and the structured hand-back into a roster plus
  // per-agent activity instead of folding subagent output into the parent.
  const subagents = createClaudeSubagentTracker(emit, Date.now, { onBackgroundChange: options.onBackgroundSubagents });

  let accumulatedUsage: UsageShape = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  function emptyUsage(): UsageShape {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  function mergeUsage(u: UsageShape): void {
    accumulatedUsage = {
      input_tokens: (accumulatedUsage.input_tokens ?? 0) + (u.input_tokens ?? 0),
      output_tokens: (accumulatedUsage.output_tokens ?? 0) + (u.output_tokens ?? 0),
      cache_creation_input_tokens:
        (accumulatedUsage.cache_creation_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens:
        (accumulatedUsage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    };
  }

  function checkUnknownModel(name: string): void {
    const { isFallback } = getClaudeModelEntry(name);
    if (isFallback && !seenUnknownModels.has(name)) {
      seenUnknownModels.add(name);
      console.warn(
        `[claudeEventTranslator] Unknown model "${name}" — using fallback context window. ` +
          'Update claudeModelCatalog.ts to add this model.',
      );
    }
  }

  function startTurn(): void {
    turnStartMs = Date.now();
    latestUsage = undefined;
    carriedTokens = undefined;
    forkAnchor = null;
    // A new turn must not inherit the previous turn's agents; the roster is
    // durable per assistant message, not per session.
    subagents.startTurn();
  }

  /** The host turn's summary (tokens of its held results included) and its end. */
  function endTurnSummary(lastTokens: TurnTokens | undefined): void {
    const tokens = addTokens(carriedTokens, lastTokens);
    carriedTokens = undefined;
    // Token counts are the CLI's own. No cost is reported: see resultTokens.
    emit({ kind: 'usage_summary', contextUsagePercentage: latestUsage ? contextPct(latestUsage) : undefined,
      source: tokens ? 'native' : 'unverifiable', turnDurationMs: Date.now() - turnStartMs, ...tokens });
    emit({ kind: 'turn_end', stopReason: 'end_turn' });
  }

  function releaseHeldTurn(): void {
    subagents.endTurn();
    endTurnSummary(undefined);
  }

  function feed(env: ClaudeEnvelope): void {
    const type = env['type'] as string | undefined;

    // Subagent inner turns: the CLI stamps every forwarded subagent message
    // (and its partial stream_event frames) with parent_tool_use_id = the
    // parent Task tool_use id. Route these to the roster/activity surfaces so
    // subagent text/thinking/tool calls never leak into the parent transcript
    // or the parent's tool-call chip list. Must run before the assistant/user/
    // stream_event handlers below.
    const parentToolUseId = (env['parent_tool_use_id'] as string | null | undefined) ?? null;
    if (parentToolUseId) {
      subagents.onChildEnvelope(env, parentToolUseId);
      return;
    }

    // system envelope
    if (type === 'system') {
      const subtype = env['subtype'] as string | undefined;

      if (subagents.onSystem(env)) return;

      if (subtype === 'init') {
        // The CLI emits init at the start of every turn. Outside a
        // foreground turn this is a self-initiated one (e.g. after a
        // background task finished): give it a fresh roster and its own clock.
        if (!subagents.isInTurn()) turnStartMs = Date.now();
        subagents.beginTurnIfIdle();
        claudeSessionId = (env['session_id'] as string | null) ?? null;
        if (typeof env['model'] === 'string') modelName = env['model'];
        // No emit — callers listen via getSessionId()
        return;
      }

      if (subtype === 'api_retry') {
        const error = (env['error'] as string | undefined) ?? 'retry';
        emit({ kind: 'warning', source: 'anthropic-api', category: 'provider', message: error });
        return;
      }

      // Native compaction, manual (/compact) or automatic: status
      // 'compacting', then a status carrying compact_result, then (on
      // success) compact_boundary with the context size before and after.
      if (subtype === 'status') {
        const result = env['compact_result'];
        if (env['status'] === 'compacting') {
          if (!compacting) {
            compacting = true;
            compaction = {};
            emit({ kind: 'compaction_start', detail: 'Claude Code is compacting the conversation' });
          }
          return;
        }
        if (compacting && (result === 'success' || result === 'failed' || env['status'] == null)) {
          compacting = false;
          const error = typeof env['compact_error'] === 'string' && env['compact_error'] ? env['compact_error'] : undefined;
          compaction = { ...compaction, ...(result === 'success' || result === 'failed' ? { result } : {}), ...(error ? { error } : {}) };
          emit({ kind: 'compaction_end', ...(result === 'failed' ? { detail: error ? `Compaction failed: ${error}` : 'Compaction failed' } : {}) });
        }
        return;
      }

      if (subtype === 'compact_boundary') {
        const meta = env['compact_metadata'] && typeof env['compact_metadata'] === 'object'
          ? env['compact_metadata'] as Record<string, unknown> : {};
        const tokens = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
        const preTokens = tokens(meta.pre_tokens);
        const postTokens = tokens(meta.post_tokens);
        compaction = {
          ...compaction,
          ...(meta.trigger === 'manual' || meta.trigger === 'auto' ? { trigger: meta.trigger } : {}),
          ...(preTokens !== undefined ? { preTokens } : {}),
          ...(postTokens !== undefined ? { postTokens } : {}),
        };
        // The compacted context is what the next call sends.
        if (postTokens !== undefined) {
          latestUsage = { input_tokens: postTokens };
          emit({ kind: 'context_usage', contextUsagePercentage: contextPct(latestUsage) });
        }
        return;
      }

      if (subtype === 'informational') {
        const content = env['content'];
        // The SDK uses these banners for visible runtime warnings, including
        // model restrictions. Preserve their text without inferring model state.
        if (env['level'] === 'warning' && env['isMeta'] !== true
          && typeof content === 'string' && content.trim()) {
          emit({ kind: 'warning', source: 'claude-cli', category: 'runtime', code: subtype, message: content });
        }
        return;
      }

      return;
    }

    // assistant envelope
    if (type === 'assistant') {
      const message = env['message'] as Record<string, unknown> | undefined;
      if (!message) return;
      // stream_event UUIDs are transient; only the complete parent envelope
      // names a persisted transcript position. A tool cycle may emit several
      // such messages, so retain the final one rather than the first text.
      if (!env['isSidechain'] && !env['parent_agent_id'] && !env['agent_id']) {
        forkAnchor = typeof env['uuid'] === 'string' && env['uuid'] ? env['uuid'] : null;
      }

      // capture model name for cost/context calculations
      if (typeof message['model'] === 'string') {
        modelName = message['model'];
        checkUnknownModel(modelName);
      }

      const usage = messageUsage(message['usage']);
      if (usage) {
        latestUsage = usage;
        emit({ kind: 'context_usage', contextUsagePercentage: contextPct(usage) });
      }

      const content = message['content'];
      if (!Array.isArray(content)) return;

      for (const block of content) {
        const b = block as Record<string, unknown>;
        const btype = b['type'] as string | undefined;

        // text and thinking blocks are already streamed via stream_event
        // content_block_delta envelopes; emitting them again here would
        // duplicate every assistant message in the transcript.
        if (btype === 'tool_use') {
          const id = (b['id'] as string | undefined) ?? '';
          const name = (b['name'] as string | undefined) ?? '';
          const input = (b['input'] ?? {}) as Record<string, unknown>;
          const detail = extractToolUsePurpose(input)
            ?? Array.from(JSON.stringify(input)).slice(0, 200).join('');
          const inputJson = truncatePayload(input);

          // A parent-level `Task` (newer CLI: `Agent`) spawns a subagent. Seed
          // the roster from its input (subagent_type / description / prompt) so
          // forwarded subagent frames — which arrive next — have somewhere to
          // land. The Task chip itself still renders inline (below) marking the
          // spawn point in the parent transcript.
          subagents.onParentToolUse(id, name, input);
          if (streamedToolUseIds.has(id)) {
            emit({
              kind: 'tool_call_update',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              detail,
              inputJson,
              ...claudeToolIdentity(name),
            });
          } else {
            emit({
              kind: 'tool_call',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              detail,
              inputJson,
              ...claudeToolIdentity(name),
            });
          }
        }
      }

      return;
    }

    // stream_event envelope (partial streaming deltas)
    if (type === 'stream_event') {
      const event = env['event'] as Record<string, unknown> | undefined;
      if (!event) return;

      const evtype = event['type'] as string | undefined;
      if (evtype === 'message_start') {
        const message = event['message'] as Record<string, unknown> | undefined;
        if (typeof message?.['model'] === 'string') modelName = message['model'];
        latestUsage = messageUsage(message?.['usage']);
        if (latestUsage) emit({ kind: 'context_usage', contextUsagePercentage: contextPct(latestUsage) });
        // A new turn is starting. Reset the per-turn block-index trackers so
        // the first text/thinking block in the new turn doesn't accidentally
        // share an index with the previous turn (Claude restarts indices at
        // 0 each turn). Without this, two consecutive turns whose text is
        // both at idx=1 produce no \n\n between them, and weaveToolCalls
        // can't find a safe boundary to slice — every tool chip from the
        // previous turn snaps forward to end-of-message.
        if (lastTextIndex !== null) {
          // The previous turn produced text. Insert a paragraph break so the
          // next turn's text doesn't visually run into it AND so chip-weaver
          // has a boundary to slice at.
          emit({ kind: 'chunk', text: '\n\n' });
        }
        lastTextIndex = null;
        lastThinkingIndex = null;
        return;
      }
      if (evtype === 'message_delta' && latestUsage) {
        const usage = event['usage'] as Record<string, unknown> | undefined;
        const output = usage?.['output_tokens'];
        if (typeof output === 'number' && Number.isFinite(output) && output >= 0) {
          latestUsage = { ...latestUsage, output_tokens: output };
          emit({ kind: 'context_usage', contextUsagePercentage: contextPct(latestUsage) });
        }
        return;
      }
      if (evtype === 'content_block_start') {
        // Claude CLI emits this the moment the model commits to a new
        // content block. For tool_use we use it as the inline emit point so
        // the chip lands at the offset where the model actually decided to
        // call a tool — without this, every chip pools at end-of-message
        // because the trailing `assistant` envelope arrives after all text
        // has streamed.
        const block = event['content_block'] as Record<string, unknown> | undefined;
        if (block && block['type'] === 'tool_use') {
          const id = (block['id'] as string | undefined) ?? '';
          const name = (block['name'] as string | undefined) ?? '';
          if (id) {
            streamedToolUseIds.add(id);
            emit({
              kind: 'tool_call',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              // input is empty here — partial JSON streams in via
              // input_json_delta and the final assistant envelope backfills
              // the full input as `detail` via tool_call_update.
              detail: '',
              ...claudeToolIdentity(name),
            });
          }
        }
        return;
      }

      if (evtype === 'content_block_delta') {
        const delta = event['delta'] as Record<string, unknown> | undefined;
        if (!delta) return;

        const blockIndex =
          typeof event['index'] === 'number' ? (event['index'] as number) : null;

        const dtype = delta['type'] as string | undefined;
        if (dtype === 'text_delta') {
          const text = (delta['text'] as string | undefined) ?? '';
          if (text) {
            if (
              blockIndex !== null &&
              lastTextIndex !== null &&
              blockIndex !== lastTextIndex
            ) {
              emit({ kind: 'chunk', text: '\n\n' });
            }
            lastTextIndex = blockIndex;
            emit({ kind: 'chunk', text });
          }
        } else if (dtype === 'thinking_delta') {
          const thinking = (delta['thinking'] as string | undefined) ?? '';
          if (thinking) {
            if (
              blockIndex !== null &&
              lastThinkingIndex !== null &&
              blockIndex !== lastThinkingIndex
            ) {
              emit({ kind: 'thought', text: '\n\n' });
            }
            lastThinkingIndex = blockIndex;
            emit({ kind: 'thought', text: thinking });
          }
        }
      }

      return;
    }

    // user envelope — tool_result correlation
    if (type === 'user') {
      const message = env['message'] as Record<string, unknown> | undefined;
      if (!message) return;

      const content = message['content'];
      if (!Array.isArray(content)) return;

      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result') {
          const toolUseId = (b['tool_use_id'] as string | undefined) ?? '';
          const resultContent = b['content'] ?? '';
          emit({
            kind: 'tool_call_update',
            toolCallId: toolUseId,
            title: '',
            status: b['is_error'] ? 'failed' : 'completed',
            kindType: 'tool',
            output: truncatePayload(resultContent),
          });

          // Parent-level tool_result for an Agent call = its hand-back.
          subagents.onParentToolResult(b, env);
        }
      }

      return;
    }

    // result envelope — end of turn
    if (type === 'result') {
      const subtype = (env['subtype'] as string | undefined) ?? '';
      const contextWindow = reportedContextWindow(env, modelName);
      if (contextWindow !== undefined) contextWindows.set(modelName, contextWindow);
      const usage = (env['usage'] as UsageShape | undefined) ?? emptyUsage();
      if (usage) mergeUsage(usage);

      // The CLI runs a queued steer as its own turn right after this one:
      // the host's turn goes on (see TranslatorOptions.holdTurnEnd).
      if (subtype === 'success' && options.holdTurnEnd?.()) {
        carriedTokens = addTokens(carriedTokens, resultTokens(env['usage']));
        return;
      }

      // Safety: never leave a subagent pinned on "working" past the turn
      // (e.g. a missed hand-back). Emit before turn_end.
      subagents.endTurn();

      if (subtype === 'success') {
        endTurnSummary(resultTokens(env['usage']));
      } else {
        carriedTokens = undefined;
        // error_* subtypes
        const message = (env['result'] as string | undefined) ?? 'error';
        emit({ kind: 'warning', source: 'claude-cli', category: 'runtime', code: subtype, message });
        emit({ kind: 'turn_end', stopReason: 'error' });
      }

      return;
    }
  }

  return {
    feed,
    startTurn,
    getSessionId: () => claudeSessionId,
    getForkAnchor: () => forkAnchor,
    getAccumulatedUsage: () => ({ ...accumulatedUsage }),
    hasBackgroundSubagents: () => subagents.hasBackgroundWork(),
    pendingBackgroundSubagents: () => subagents.pendingBackground(),
    takeCompaction: () => { const taken = compaction; compaction = null; return taken; },
    releaseHeldTurn,
  };
}
