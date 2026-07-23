import { NormalizedEvent, SubagentInfo } from '../../services/chatEvents';
import { ClaudeEnvelope } from './claudeEnvelopeParser';
import { getClaudeModelEntry } from './claudeModelCatalog';
import { DEFAULT_MODELS } from '../agentConfig';

interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function computeContextPct(usage: UsageShape, modelName: string): number {
  const { entry } = getClaudeModelEntry(modelName);
  const used =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return Math.min(100, (used / entry.contextWindow) * 100);
}

function computeCost(usage: UsageShape, modelName: string): number {
  const { entry } = getClaudeModelEntry(modelName);
  const r = entry.rates;
  return (
    ((usage.input_tokens ?? 0) / 1e6) * r.input +
    ((usage.output_tokens ?? 0) / 1e6) * r.output +
    ((usage.cache_creation_input_tokens ?? 0) / 1e6) * r.cacheCreation +
    ((usage.cache_read_input_tokens ?? 0) / 1e6) * r.cacheRead
  );
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

function extractPurpose(toolName: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.__tool_use_purpose === 'string') return input.__tool_use_purpose;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.file_path === 'string') return `${toolName}: ${input.file_path}`;
  if (typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `grep: ${input.pattern}${path}`;
  }
  return undefined;
}

export interface TranslatorHandle {
  feed: (env: ClaudeEnvelope) => void;
  startTurn: () => void;
  getSessionId: () => string | null;
  getAccumulatedUsage: () => UsageShape;
}

export function createTranslator(emit: (ev: NormalizedEvent) => void): TranslatorHandle {
  let claudeSessionId: string | null = null;
  let turnStartMs: number = Date.now();
  let modelName: string = DEFAULT_MODELS.claude;
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

  // In-session subagent (Task) tracking. With --forward-subagent-text the CLI
  // forwards each subagent's assistant/user messages as top-level envelopes
  // carrying `parent_tool_use_id` = the parent `Task` tool_use id. We rebuild a
  // live roster (subagent_list_update) + per-agent tool activity
  // (subagent_tool_activity) — mirroring the Kiro runtime, whose downstream
  // (SSE → reducer → SubagentStatus panel) already consumes these — instead of
  // folding subagent output into the parent transcript. Keyed by Task id.
  const subagents = new Map<string, SubagentInfo>();

  function emitRoster(): void {
    emit({ kind: 'subagent_list_update', subagents: [...subagents.values()] });
  }

  function snippet(text: string, max = 140): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  /**
   * Get-or-create a roster entry. Emits subagent_list_update on first sight (so
   * a later subagent_tool_activity has a roster to attach to — the reducer
   * drops activity for unknown sessions) and when late metadata backfills a
   * lazily-created entry.
   */
  function ensureSubagent(id: string, seed?: Partial<SubagentInfo>): SubagentInfo {
    const existing = subagents.get(id);
    if (!existing) {
      const entry: SubagentInfo = {
        sessionId: id,
        sessionName: seed?.sessionName ?? seed?.agentName ?? 'subagent',
        agentName: seed?.agentName ?? 'subagent',
        initialQuery: seed?.initialQuery ?? '',
        status: 'working',
        group: '',
        dependsOn: [],
      };
      subagents.set(id, entry);
      emitRoster();
      return entry;
    }
    if (seed) {
      let changed = false;
      if (seed.agentName && existing.agentName === 'subagent') {
        existing.agentName = seed.agentName;
        changed = true;
      }
      if (seed.sessionName && existing.sessionName === 'subagent') {
        existing.sessionName = seed.sessionName;
        changed = true;
      }
      if (seed.initialQuery && !existing.initialQuery) {
        existing.initialQuery = seed.initialQuery;
        changed = true;
      }
      if (changed) emitRoster();
    }
    return existing;
  }

  /**
   * Route a subagent's forwarded envelope (parent_tool_use_id set) to the
   * roster/activity surfaces instead of the parent transcript. Tool_use blocks
   * become activity; text blocks update the agent's status line. Inner
   * tool_result (`user`) and partial stream_event frames are intentionally
   * dropped — currentTool already reflects the in-flight tool.
   */
  function handleSubagentEnvelope(type: string | undefined, env: ClaudeEnvelope, parentId: string): void {
    const entry = ensureSubagent(parentId);
    if (entry.status === 'terminated') return; // late frames after Task completed

    if (type !== 'assistant') return;
    const message = env['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      const btype = b['type'] as string | undefined;
      if (btype === 'tool_use') {
        const name = (b['name'] as string | undefined) ?? '';
        const input = (b['input'] ?? {}) as Record<string, unknown>;
        const title = extractPurpose(name, input) ?? name;
        emit({
          kind: 'subagent_tool_activity',
          subagentSessionId: parentId,
          title,
          status: 'in_progress',
        });
      } else if (btype === 'text') {
        const s = snippet((b['text'] as string | undefined) ?? '');
        if (s && entry.statusMessage !== s) {
          entry.statusMessage = s;
          emitRoster();
        }
      }
    }
  }

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
        `[claudeEventTranslator] Unknown model "${name}" — using Opus-tier fallback rates. ` +
          'Update claudeModelCatalog.ts to add this model.',
      );
    }
  }

  function startTurn(): void {
    turnStartMs = Date.now();
    // Reset the subagent roster so a new turn doesn't inherit the previous
    // turn's (terminated) agents. The first subagent_list_update of this turn
    // repopulates it; if there are no subagents, the frontend clears on its
    // own turn boundary.
    subagents.clear();
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
      handleSubagentEnvelope(type, env, parentToolUseId);
      return;
    }

    // system envelope
    if (type === 'system') {
      const subtype = env['subtype'] as string | undefined;

      if (subtype === 'init') {
        claudeSessionId = (env['session_id'] as string | null) ?? null;
        // No emit — callers listen via getSessionId()
        return;
      }

      if (subtype === 'api_retry') {
        const error = (env['error'] as string | undefined) ?? 'retry';
        emit({ kind: 'mcp_server_error', serverName: 'anthropic-api', error });
        return;
      }

      return;
    }

    // assistant envelope
    if (type === 'assistant') {
      const message = env['message'] as Record<string, unknown> | undefined;
      if (!message) return;

      // capture model name for cost/context calculations
      if (typeof message['model'] === 'string') {
        modelName = message['model'];
        checkUnknownModel(modelName);
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
          const detail = extractPurpose(name, input)
            ?? Array.from(JSON.stringify(input)).slice(0, 200).join('');
          const inputJson = truncatePayload(input);

          // A parent-level `Task` tool_use spawns an in-session subagent. Seed
          // the roster from its input (subagent_type / description / prompt) so
          // forwarded subagent frames — which arrive next — have somewhere to
          // land. The Task chip itself still renders inline (below) marking the
          // spawn point in the parent transcript.
          if (id && name === 'Task') {
            const subagentType =
              typeof input['subagent_type'] === 'string' ? (input['subagent_type'] as string) : undefined;
            const description =
              typeof input['description'] === 'string' ? (input['description'] as string) : undefined;
            const prompt = typeof input['prompt'] === 'string' ? (input['prompt'] as string) : '';
            const initialQuery = description || (prompt ? snippet(prompt.split('\n')[0], 200) : '');
            ensureSubagent(id, {
              agentName: subagentType,
              sessionName: subagentType,
              initialQuery,
            });
          }
          if (streamedToolUseIds.has(id)) {
            emit({
              kind: 'tool_call_update',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              detail,
              inputJson,
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

          // Parent-level tool_result for a Task = its subagent has finished.
          const entry = subagents.get(toolUseId);
          if (entry && entry.status !== 'terminated') {
            entry.status = 'terminated';
            emitRoster();
          }
        }
      }

      return;
    }

    // result envelope — end of turn
    if (type === 'result') {
      const subtype = (env['subtype'] as string | undefined) ?? '';
      const usage = (env['usage'] as UsageShape | undefined) ?? emptyUsage();
      if (usage) mergeUsage(usage);

      // Safety: never leave the subagent panel pinned on "working" past the
      // turn (e.g. a missed Task tool_result). Emit before turn_end.
      let terminatedAny = false;
      for (const entry of subagents.values()) {
        if (entry.status === 'working') {
          entry.status = 'terminated';
          terminatedAny = true;
        }
      }
      if (terminatedAny) emitRoster();

      if (subtype === 'success') {
        const turnDurationMs = Date.now() - turnStartMs;
        const contextUsagePercentage = computeContextPct(usage, modelName);
        const totalCredits = computeCost(usage, modelName);

        emit({ kind: 'usage_summary', contextUsagePercentage, totalCredits, turnDurationMs });
        emit({ kind: 'turn_end', stopReason: 'end_turn' });
      } else {
        // error_* subtypes
        const message = (env['result'] as string | undefined) ?? 'error';
        emit({ kind: 'mcp_server_error', serverName: 'claude-cli', error: message });
        emit({ kind: 'turn_end', stopReason: subtype });
      }

      return;
    }
  }

  return {
    feed,
    startTurn,
    getSessionId: () => claudeSessionId,
    getAccumulatedUsage: () => ({ ...accumulatedUsage }),
  };
}
