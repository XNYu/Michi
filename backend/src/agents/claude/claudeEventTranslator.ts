import { NormalizedEvent } from '../../services/chatEvents';
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
  }

  function feed(env: ClaudeEnvelope): void {
    const type = env['type'] as string | undefined;

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
          const input = b['input'] ?? {};
          const detail = Array.from(JSON.stringify(input)).slice(0, 200).join('');
          if (streamedToolUseIds.has(id)) {
            // Already announced inline via content_block_start; backfill the
            // detail (which only the assistant envelope carries) without
            // moving textOffset.
            emit({
              kind: 'tool_call_update',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              detail,
            });
          } else {
            // No partial start was seen — tool_use without a streaming
            // entrypoint. Emit a full tool_call so the chip still renders
            // (textOffset will land at end-of-text, same as before).
            emit({
              kind: 'tool_call',
              toolCallId: id,
              title: name,
              status: 'in_progress',
              kindType: 'tool',
              detail,
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
            detail: Array.from(stringifyContent(resultContent)).slice(0, 200).join(''),
          });
        }
      }

      return;
    }

    // result envelope — end of turn
    if (type === 'result') {
      const subtype = (env['subtype'] as string | undefined) ?? '';
      const usage = (env['usage'] as UsageShape | undefined) ?? emptyUsage();
      if (usage) mergeUsage(usage);

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
