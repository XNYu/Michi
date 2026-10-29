/**
 * Tests for claudeEventTranslator.ts
 *
 * Uses fixture-style: feed concrete envelope sequences and assert emitted NormalizedEvents.
 *
 * KNOWN DEFECT (as-never slop): the result.subtype error path in the implementation uses
 *   emit({ kind: 'error' as never, message } as never)
 * NormalizedEvent does NOT have an 'error' kind, so TypeScript is bypassed with `as never`.
 * The test for that case explicitly checks what is ACTUALLY emitted and fails if the object
 * is malformed, rather than papering over the defect.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySubagentActivity,
  mergeSubagentRoster,
  type SubagentActivityPayload,
  type SubagentInfo,
} from 'michi-shared';
import { CLAUDE_FALLBACK_MODEL, createTranslator } from 'michi-runtime/internal/adapters/claude/claudeEventTranslator';
import { getClaudeModelEntry } from 'michi-runtime/internal/adapters/claude/claudeModelCatalog';
import { DEFAULT_MODELS } from '../src/agents/agentConfig';
import { NormalizedEvent } from '../src/services/chatEvents';
import { applyTurnEvent, createDurableTurn, parseChatStreamEvent } from 'michi-shared';
import { toChatStreamEvent } from '../src/routes/chatStreamEvents';

// ── helpers ────────────────────────────────────────────────────────────────

function makeTranslator(): {
  emitted: NormalizedEvent[];
  feed: (env: Record<string, unknown>) => void;
  startTurn: () => void;
  getSessionId: () => string | null;
  hasBackgroundSubagents: () => boolean;
} {
  const emitted: NormalizedEvent[] = [];
  const { feed, startTurn, getSessionId, hasBackgroundSubagents } = createTranslator((ev) => emitted.push(ev));
  return { emitted, feed, startTurn, getSessionId, hasBackgroundSubagents };
}

describe('claudeEventTranslator', () => {
  test("falls back to the app's default Claude model before the CLI names one", () => {
    assert.equal(CLAUDE_FALLBACK_MODEL, DEFAULT_MODELS.claude);
  });

  test('retains only the final persisted parent assistant position across tool cycles', () => {
    const emitted: NormalizedEvent[] = [];
    const translator = createTranslator((event) => emitted.push(event));
    translator.startTurn();
    translator.feed({ type: 'assistant', uuid: 'parent-tool', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: {} },
    ] } });
    assert.equal(translator.getForkAnchor(), 'parent-tool');
    translator.feed({ type: 'user', uuid: 'tool-result', message: { content: [] } });
    translator.feed({ type: 'stream_event', uuid: 'ephemeral-stream', event: { type: 'message_stop' } });
    translator.feed({ type: 'assistant', uuid: 'child', parent_tool_use_id: 'agent', message: { content: [] } });
    assert.equal(translator.getForkAnchor(), 'parent-tool');
    translator.feed({ type: 'assistant', uuid: 'final-answer', message: { content: [{ type: 'text', text: 'answer' }] } });
    translator.feed({ type: 'result', subtype: 'success', uuid: 'result-frame' });
    assert.equal(translator.getForkAnchor(), 'final-answer');
    assert.equal(emitted.some((event) => JSON.stringify(event).includes('final-answer')), false,
      'native positions must not enter renderer events');
    translator.startTurn();
    assert.equal(translator.getForkAnchor(), null, 'a new turn must not inherit the previous anchor');
  });

  test('an assistant envelope without a persisted UUID invalidates an earlier boundary', () => {
    const translator = createTranslator(() => {});
    translator.feed({ type: 'assistant', uuid: 'earlier', message: { content: [] } });
    translator.feed({ type: 'assistant', message: { content: [] } });
    assert.equal(translator.getForkAnchor(), null);
  });

  test('sidechain and nested-agent UUIDs never replace the parent boundary', () => {
    const translator = createTranslator(() => {});
    translator.feed({ type: 'assistant', uuid: 'parent', message: { content: [] } });
    for (const context of [{ isSidechain: true }, { parent_agent_id: 'parent-agent' }, { agent_id: 'child-agent' }]) {
      translator.feed({ type: 'assistant', uuid: 'child', ...context, message: { content: [] } });
    }
    assert.equal(translator.getForkAnchor(), 'parent');
  });

  for (const name of ['Task', 'Agent']) {
    test(`${name} seeds the same native subagent roster before forwarded output`, () => {
      const { emitted, feed } = makeTranslator();
      feed({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'agent-1', name,
          input: { subagent_type: 'Explore', description: 'Find the implementation', prompt: 'Search the code' } },
      ] } });
      const roster = emitted.find((event) => event.kind === 'subagent_list_update');
      assert.equal(roster?.kind, 'subagent_list_update');
      if (roster?.kind !== 'subagent_list_update') return;
      assert.equal(roster.subagents[0].sessionId, 'agent-1');
      assert.equal(roster.subagents[0].agentName, 'Explore');
      assert.equal(roster.subagents[0].initialQuery, 'Find the implementation');
      feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }] } });
      const finalRoster = emitted.filter((event) => event.kind === 'subagent_list_update').at(-1);
      assert.equal(finalRoster?.kind === 'subagent_list_update' && finalRoster.subagents[0].status, 'terminated');
    });
  }

  // ── Case 1: system.init captures session id, emits nothing ───────────────

  test('system.init envelope does not emit any event and getSessionId returns captured id', () => {
    const { emitted, feed, getSessionId } = makeTranslator();

    feed({ type: 'system', subtype: 'init', session_id: 'sess-abc-123' });

    assert.equal(emitted.length, 0, 'system.init must not emit any NormalizedEvent');
    assert.equal(getSessionId(), 'sess-abc-123');
  });

  // ── Case 7b: user envelope with is_error tool_result → status failed ───────

  test('user envelope with is_error:true tool_result emits tool_call_update with status failed', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_02XYZ',
            is_error: true,
            content: 'Permission denied',
          },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    type ToolCallUpdateEv = { kind: string; toolCallId: string; status: string; kindType?: string };
    const ev = emitted[0] as unknown as ToolCallUpdateEv;
    assert.equal(ev.kind, 'tool_call_update');
    assert.equal(ev.toolCallId, 'toolu_02XYZ');
    assert.equal(ev.status, 'failed');
    assert.equal(ev.kindType, 'tool');
  });

  test('tool loops use the latest parent call, excluding turn totals and subagents', () => {
    const { emitted, feed } = makeTranslator();
    for (let i = 0; i < 12; i++) {
      feed({ type: 'assistant', message: { model: 'global.anthropic.claude-opus-5-5[1m]', content: [],
        usage: { input_tokens: 2_000, cache_read_input_tokens: 97_000, output_tokens: 1_000 } } });
    }
    feed({ type: 'assistant', parent_tool_use_id: 'subagent', message: { model: 'claude-haiku-4-5', content: [],
      usage: { input_tokens: 190_000 } } });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 214_000, cache_read_input_tokens: 1_164_000 } });
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.equal(summary?.kind === 'usage_summary' && summary.contextUsagePercentage, 10);
    const live = emitted.filter((ev) => ev.kind === 'context_usage');
    assert.equal(live.length, 12);
    assert.equal(live[11].kind === 'context_usage' && live[11].contextUsagePercentage, 10);
  });

  test('uses the CLI context window for the active model without summing modelUsage', () => {
    const { emitted, feed, startTurn } = makeTranslator();
    feed({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [],
      usage: { input_tokens: 1_000, cache_creation_input_tokens: 19_000, output_tokens: 2_000 } } });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 900_000 }, modelUsage: {
      'global.anthropic.claude-sonnet-4-6': { contextWindow: 200_000, inputTokens: 900_000 },
      'claude-haiku-4-5': { contextWindow: 10_000, inputTokens: 800_000 },
    } });
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.equal(summary?.kind === 'usage_summary' && summary.contextUsagePercentage, 11);
    startTurn();
    feed({ type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 40_000 } } });
    const live = emitted.filter((ev) => ev.kind === 'context_usage');
    assert.equal(live[1].kind === 'context_usage' && live[1].contextUsagePercentage, 20);
  });

  test('updates live context from streaming message usage and replaces it after compaction', () => {
    const { emitted, feed } = makeTranslator();
    feed({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-5',
      usage: { input_tokens: 100_000, cache_read_input_tokens: 400_000 } } } });
    feed({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 10_000 } } });
    feed({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-5',
      usage: { input_tokens: 20_000 } } } });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 900_000 } });
    const live = emitted.filter((ev) => ev.kind === 'context_usage');
    assert.deepEqual(live.map((ev) => ev.kind === 'context_usage' && ev.contextUsagePercentage), [50, 51, 2]);
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.equal(summary?.kind === 'usage_summary' && summary.contextUsagePercentage, 2);
  });

  // ── Case 9: result.error_max_turns → runtime warning + turn_end ─────────

  test('result.error_max_turns emits a runtime warning then turn_end', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'result',
      subtype: 'error_max_turns',
      result: 'Max turns reached',
    });

    assert.equal(emitted.length, 2, `expected 2 events (warning + turn_end), got ${emitted.length}`);

    type RuntimeWarningEv = { kind: string; source: string; category: string; message: string };
    const errorEv = emitted[0] as unknown as RuntimeWarningEv;
    assert.equal(errorEv.kind, 'warning');
    assert.equal(errorEv.source, 'claude-cli');
    assert.equal(errorEv.category, 'runtime');
    assert.equal(errorEv.message, 'Max turns reached');

    type TurnEndEv2 = { kind: string; stopReason?: string };
    const turnEnd = emitted[1] as unknown as TurnEndEv2;
    assert.equal(turnEnd.kind, 'turn_end');
    assert.equal(turnEnd.stopReason, 'error');
    assert.equal((emitted[0] as Extract<NormalizedEvent, { kind: 'warning' }>).code, 'error_max_turns');
  });

  // ── Case 10: system.api_retry → provider warning ─────────────────────────

  test('system.api_retry envelope emits a provider warning', () => {
    const { emitted, feed } = makeTranslator();

    feed({ type: 'system', subtype: 'api_retry', error: 'rate limit exceeded' });

    assert.equal(emitted.length, 1);
    type RuntimeWarningEv = { kind: string; source: string; category: string; message: string };
    const ev = emitted[0] as unknown as RuntimeWarningEv;
    assert.equal(ev.kind, 'warning');
    assert.equal(ev.source, 'anthropic-api');
    assert.equal(ev.category, 'provider');
    assert.equal(ev.message, 'rate limit exceeded');
  });

  test('visible informational warnings preserve the official banner text without ending the turn', () => {
    const content = '  Model "restricted-configured-model" is restricted by your organization\'s settings. Using claude-opus-5-5[1m] instead.\n';
    for (const isMeta of [undefined, false]) {
      const { emitted, feed } = makeTranslator();
      feed({ type: 'system', subtype: 'informational', level: 'warning', content,
        ...(isMeta === undefined ? {} : { isMeta }) });

      assert.deepEqual(emitted, [{
        kind: 'warning', source: 'claude-cli', category: 'runtime', code: 'informational', message: content,
      }]);
      feed({ type: 'result', subtype: 'success' });
      assert.deepEqual(emitted.at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
      assert.equal(emitted.filter((event) => event.kind === 'turn_end').length, 1);
    }
  });

  test('informational warning prose does not change the model used for context calculations', () => {
    const { emitted, feed, getSessionId } = makeTranslator();
    feed({ type: 'system', subtype: 'init', session_id: 'session-before-banner', model: 'claude-haiku-4-5' });
    feed({ type: 'system', subtype: 'informational', level: 'warning',
      content: 'Using claude-opus-5-5[1m] instead.', session_id: 'untrusted-banner-session' });
    feed({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 20_000 } } } });

    assert.equal(getSessionId(), 'session-before-banner');
    assert.deepEqual(emitted.at(-1), { kind: 'context_usage', contextUsagePercentage: 10 });
  });

  test('informational messages ignore lower levels, internal banners and malformed warning content', () => {
    const { emitted, feed } = makeTranslator();
    for (const level of ['info', 'notice', 'suggestion', undefined]) {
      feed({ type: 'system', subtype: 'informational', level, content: 'A non-warning banner' });
    }
    feed({ type: 'system', subtype: 'informational', level: 'warning', isMeta: true, content: 'Internal metadata' });
    for (const content of ['', ' \n\t', undefined, null, 42, { text: 'not SDK plaintext' }]) {
      feed({ type: 'system', subtype: 'informational', level: 'warning', content });
    }
    assert.deepEqual(emitted, []);
  });

  // ── Case 11: content_block_start tool_use → inline tool_call ────────────
  //
  // Regression guard for the chip-pooling bug: Claude CLI streams text via
  // content_block_delta and only later emits the trailing `assistant`
  // envelope with full content[]. If we waited for that envelope to emit
  // tool_call, every chip's textOffset would land at end-of-message because
  // m.text.length is already the full reply by the time the dispatch lands.
  //
  // The fix routes tool_call through stream_event content_block_start, and
  // turns the trailing assistant.tool_use into a tool_call_update that
  // backfills `detail` without re-emitting tool_call.

  test('content_block_start tool_use emits tool_call inline; trailing assistant envelope updates detail without duplicating', () => {
    const { emitted, feed } = makeTranslator();

    // Simulate: text streaming → tool_use start → more text → assistant envelope
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me look. ' }, index: 0 },
    });
    feed({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: {} },
      },
    });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'After tool. ' }, index: 2 },
    });
    feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me look. ' },
          { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: '/foo.ts' } },
          { type: 'text', text: 'After tool. ' },
        ],
      },
    });

    type AnyEv = { kind: string; text?: string; toolCallId?: string; title?: string; detail?: string; status?: string };
    const evs = emitted as unknown as AnyEv[];

    // Order matters: chunk → tool_call → chunk → tool_call_update
    assert.equal(evs.length, 5, `expected 5 events (chunk, tool_call, chunk, paragraph chunk, tool_call_update), got ${evs.length}: ${JSON.stringify(evs)}`);
    assert.equal(evs[0].kind, 'chunk');
    assert.equal(evs[0].text, 'Let me look. ');
    assert.equal(evs[1].kind, 'tool_call', 'tool_call must arrive BEFORE the second chunk so textOffset weaves it inline');
    assert.equal(evs[1].toolCallId, 'toolu_01');
    assert.equal(evs[1].title, 'read_file');
    // Detail empty at start — input streams later via assistant envelope
    assert.equal(evs[1].detail, '');
    // Paragraph break gets injected because index jumped 0 → 2
    assert.equal(evs[2].kind, 'chunk');
    assert.equal(evs[2].text, '\n\n');
    assert.equal(evs[3].kind, 'chunk');
    assert.equal(evs[3].text, 'After tool. ');
    // Trailing assistant envelope must NOT re-emit tool_call (would create
    // a duplicate chip and clobber textOffset). It emits tool_call_update
    // instead, carrying the full input as detail.
    assert.equal(evs[4].kind, 'tool_call_update');
    assert.equal(evs[4].toolCallId, 'toolu_01');
    assert.ok(typeof evs[4].detail === 'string' && evs[4].detail.includes('foo.ts'));
  });

  test('backfills full streamed tool input without treating input JSON deltas as snapshots', () => {
    const { emitted, feed } = makeTranslator();
    const input = { file_path: '/tmp/app.ts', content: 'first line\nsecond line' };
    feed({ type: 'stream_event', event: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'write-1', name: 'Write', input: {} },
    } });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, 'tool_call');
    assert.equal(emitted[0].kind === 'tool_call' && emitted[0].inputJson, undefined);

    for (const partial_json of ['{"file_path":', '"/tmp/app.ts","content":']) {
      feed({ type: 'stream_event', event: {
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json },
      } });
    }
    assert.equal(emitted.length, 1, 'append-only SDK input fragments must not become input snapshots');
    feed({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'write-1', name: 'Write', input },
    ] } });
    const afterSnapshot = emitted.length;
    feed({ type: 'stream_event', event: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '"late fragment"}' },
    } });
    assert.equal(emitted.length, afterSnapshot, 'late fragments must not overwrite complete input');
    feed({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'write-1', content: 'saved' },
    ] } });

    let snapshot = createDurableTurn({
      turnId: 'input-turn', assistantId: 'input-assistant', nodeId: 'input-node',
      workspaceId: 'input-workspace', displayUserText: 'write it', startedAt: 1,
    });
    for (const [seq, normalized] of emitted.entries()) {
      const wire = toChatStreamEvent(normalized);
      assert.ok(wire);
      const parsed = parseChatStreamEvent(wire.event, JSON.stringify({ ...wire.data, seq }));
      assert.ok(parsed);
      snapshot = applyTurnEvent(snapshot, parsed);
    }
    assert.equal(snapshot.assistantMessage.toolCalls.length, 1);
    assert.equal(snapshot.assistantMessage.toolCalls[0].inputJson, JSON.stringify(input));
    assert.equal(snapshot.assistantMessage.toolCalls[0].output, 'saved');
    assert.equal(snapshot.assistantMessage.toolCalls[0].status, 'completed');
  });

  // ── Regression: cross-turn paragraph break ──────────────────────────────
  //
  // Claude restarts content-block indices at 0 every turn. So when turn 1
  // ends with text at idx=1 and turn 2 starts with text at idx=1, the
  // intra-message multi-text-block break logic does NOT fire (same index).
  // Without an explicit break the two turns' text run into each other and
  // weaveToolCalls cannot find a paragraph boundary to slice the inline
  // tool chip from turn 1 → chip pools at end of message.
  //
  // The translator inserts \n\n on message_start when the previous turn
  // produced text, so the per-turn boundary is always renderable.

  test('message_start inserts paragraph break between turns when previous turn produced text', () => {
    const { emitted, feed } = makeTranslator();

    // Turn 1: text idx=1 → tool_use idx=2
    feed({ type: 'stream_event', event: { type: 'message_start' } });
    feed({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
    feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'first turn.' } } });
    feed({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_x', name: 'Bash' } } });

    // Turn 2: text idx=1 again
    feed({ type: 'stream_event', event: { type: 'message_start' } });
    feed({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
    feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'second turn.' } } });

    type AnyEv = { kind: string; text?: string; toolCallId?: string };
    const evs = emitted as unknown as AnyEv[];
    const chunks = evs.filter((e) => e.kind === 'chunk').map((e) => e.text);
    // Concatenated text must contain a paragraph break between turns so the
    // chip's textOffset (recorded at end of turn 1's text) can snap to a
    // safe boundary instead of the end of the whole reply.
    const joined = chunks.join('');
    assert.ok(joined.includes('first turn.\n\nsecond turn.'), `expected \\n\\n separator between turns, got: ${JSON.stringify(joined)}`);

    // First turn's tool_call must have been emitted before the second turn's
    // text — otherwise the recorded offset would point past 'second turn.'
    const toolIdx = evs.findIndex((e) => e.kind === 'tool_call');
    let secondTurnChunkIdx = -1;
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.kind === 'chunk' && e.text === 'second turn.') {
        secondTurnChunkIdx = i;
        break;
      }
    }
    assert.ok(toolIdx >= 0 && toolIdx < secondTurnChunkIdx, 'tool_call must be emitted before turn 2 text');
  });

  // ── Case 12: unknown model logs warning exactly once ─────────────────────

  test('unknown model in usage triggers console.warn exactly once across multiple feeds', () => {
    const { emitted, feed } = makeTranslator();

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '));
    };

    try {
      // Feed the unknown model name three times
      for (let i = 0; i < 3; i++) {
        feed({
          type: 'assistant',
          message: {
            model: 'claude-totally-unknown-model-xyz',
            content: [],
          },
        });
      }

      const unknownWarnings = warnMessages.filter((m) => m.includes('claude-totally-unknown-model-xyz'));
      assert.equal(
        unknownWarnings.length,
        1,
        `expected exactly 1 warning for unknown model, got ${unknownWarnings.length}`,
      );
    } finally {
      console.warn = origWarn;
    }

    void emitted; // suppress unused warning
  });

  // ── Subagents: --forward-subagent-text (parent_tool_use_id) ──────────────
  //
  // A parent-level `Task` tool_use spawns an in-session subagent. The CLI then
  // forwards that subagent's messages as top-level envelopes stamped with
  // parent_tool_use_id = the Task id. The translator rebuilds a live roster
  // (subagent_list_update) + activity (subagent_tool_activity) and must NOT
  // fold subagent output into the parent transcript / chip list.

  type AnyEv = Record<string, unknown> & { kind: string };
  const byKind = (evs: NormalizedEvent[], kind: string): AnyEv[] =>
    (evs as unknown as AnyEv[]).filter((e) => e.kind === kind);

  function spawnTask(feed: (env: Record<string, unknown>) => void, id = 'toolu_task1'): void {
    feed({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id,
            name: 'Task',
            input: { subagent_type: 'explore', description: 'Find the auth code', prompt: 'search the repo\nmore' },
          },
        ],
      },
    });
  }

  test('subagent inner tool_use becomes subagent_tool_activity, not a parent tool_call', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    const before = emitted.length;

    feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task1',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_inner', name: 'read_file', input: { file_path: '/x.ts' } }],
      },
    });

    const fresh = emitted.slice(before);
    const activity = byKind(fresh, 'subagent_tool_activity');
    assert.equal(activity.length, 1);
    assert.equal(activity[0].subagentSessionId, 'toolu_task1');
    assert.ok(String(activity[0].title).includes('x.ts'));
    // The activity keeps the native id so its result can be paired later.
    assert.equal(activity[0].toolCallId, 'toolu_inner');
    assert.equal(activity[0].toolKind, 'read_file');
    assert.equal(activity[0].detail, '/x.ts');
    // Crucially: no parent tool_call chip for the subagent's inner tool.
    assert.equal(byKind(fresh, 'tool_call').length, 0);
    assert.equal(
      (fresh as unknown as AnyEv[]).some((e) =>
        (e.kind === 'tool_call' || e.kind === 'tool_call_update') && e.toolCallId === 'toolu_inner'),
      false,
    );
  });

  test('subagent inner text becomes narration activity and never leaks a parent chunk', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    const before = emitted.length;

    feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task1',
      message: { content: [{ type: 'text', text: 'Looking at auth middleware...' }] },
    });

    const fresh = emitted.slice(before);
    assert.equal(byKind(fresh, 'chunk').length, 0, 'subagent text must not become a parent chunk');
    const activity = byKind(fresh, 'subagent_tool_activity');
    assert.equal(activity.length, 1);
    assert.equal(activity[0].activityKind, 'message');
    assert.equal(activity[0].title, 'Looking at auth middleware...');
    // The shared fold turns narration into the row's status line.
    const roster = applySubagentActivity(
      byKind(emitted, 'subagent_list_update')[0].subagents as SubagentInfo[],
      activity[0] as unknown as SubagentActivityPayload,
    );
    assert.equal(roster?.[0].statusMessage, 'Looking at auth middleware...');
  });

  test('subagent inner tool_result completes the matching activity with its output', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    feed({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task1',
      message: { content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: { file_path: '/x.ts' } }] },
    });
    const before = emitted.length;
    feed({
      type: 'user',
      parent_tool_use_id: 'toolu_task1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: '1\tconst x = 1;' }] },
    });
    const activity = byKind(emitted.slice(before), 'subagent_tool_activity');
    assert.equal(activity.length, 1);
    assert.equal(activity[0].toolCallId, 'toolu_inner');
    assert.equal(activity[0].status, 'completed');
    assert.equal(activity[0].output, '1\tconst x = 1;');
  });

  test('the Agent tool (renamed Task) spawns a subagent with prompt and model', () => {
    const { emitted, feed } = makeTranslator();
    feed({
      type: 'assistant',
      message: { content: [{
        type: 'tool_use', id: 'toolu_agent', name: 'Agent',
        input: { subagent_type: 'probe-observer', description: 'Read fixture', prompt: 'Read fixture.txt\nthen report', model: 'haiku' },
      }] },
    });
    const subs = byKind(emitted, 'subagent_list_update')[0].subagents as SubagentInfo[];
    assert.equal(subs[0].sessionId, 'toolu_agent');
    assert.equal(subs[0].parentToolCallId, 'toolu_agent');
    assert.equal(subs[0].agentName, 'probe-observer');
    assert.equal(subs[0].description, 'Read fixture');
    assert.equal(subs[0].prompt, 'Read fixture.txt\nthen report');
    assert.equal(subs[0].model, 'haiku');
    assert.equal(subs[0].source, 'claude');
  });

  test('system task lifecycle feeds progress, usage and the final outcome', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'toolu_task1', task_type: 'local_agent', description: 'Find the auth code', subagent_type: 'explore', prompt: 'search the repo\nmore' });
    feed({ type: 'system', subtype: 'task_progress', task_id: 'task-1', tool_use_id: 'toolu_task1', description: 'Reading auth.ts', last_tool_name: 'Read', usage: { total_tokens: 900, tool_uses: 2, duration_ms: 1200 } });
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'toolu_task1', status: 'completed', summary: 'Auth lives in src/auth.ts', usage: { total_tokens: 1000, tool_uses: 3, duration_ms: 1500 } });
    const roster = byKind(emitted, 'subagent_list_update').reduce<SubagentInfo[]>(
      (acc, ev) => mergeSubagentRoster(acc, ev.subagents as SubagentInfo[]), []);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].status, 'terminated');
    assert.equal(roster[0].outcome, 'completed');
    assert.equal(roster[0].result, 'Auth lives in src/auth.ts');
    assert.deepEqual(roster[0].usage, { totalTokens: 1000, toolUses: 3, durationMs: 1500 });
    // task_* frames are consumed; they never become parent output.
    assert.equal(byKind(emitted, 'chunk').length, 0);
  });

  test('a failed hand-back records the error; the structured result wins over raw text', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed, 'ok');
    spawnTask(feed, 'bad');
    feed({
      type: 'user',
      tool_use_result: { status: 'completed', content: [{ type: 'text', text: 'Clean report' }], resolvedModel: 'claude-sonnet-5-5', totalTokens: 10, totalToolUseCount: 1, totalDurationMs: 20 },
      message: { content: [{ type: 'tool_result', tool_use_id: 'ok', content: [{ type: 'text', text: '[Subagent hand-back] framed' }] }] },
    });
    feed({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'Agent crashed' }] },
    });
    const roster = byKind(emitted, 'subagent_list_update').reduce<SubagentInfo[]>(
      (acc, ev) => mergeSubagentRoster(acc, ev.subagents as SubagentInfo[]), []);
    const ok = roster.find((s) => s.sessionId === 'ok');
    const bad = roster.find((s) => s.sessionId === 'bad');
    assert.equal(ok?.outcome, 'completed');
    assert.equal(ok?.result, 'Clean report');
    assert.equal(ok?.model, 'claude-sonnet-5-5');
    assert.deepEqual(ok?.usage, { totalTokens: 10, toolUses: 1, durationMs: 20 });
    assert.equal(bad?.outcome, 'failed');
    assert.equal(bad?.error, 'Agent crashed');
  });

  test('a backgrounded subagent stays working past its launch placeholder', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_task1', task_type: 'local_agent', is_backgrounded: true, description: 'bg' });
    const before = emitted.length;
    feed({
      type: 'user',
      tool_use_result: { status: 'async_launched' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task1', content: 'running in the background' }] },
    });
    const rosters = byKind(emitted.slice(before), 'subagent_list_update');
    assert.equal(rosters.length, 0, 'the placeholder must not terminate the subagent');
    const launched = byKind(emitted.slice(0, before), 'subagent_list_update').at(-1)?.subagents as SubagentInfo[];
    assert.equal(launched[0].background, true, 'the spawning message learns it runs in the background');
  });

  test('a background agent finishing between turns reports into the next turn with its full entry', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_task1', task_type: 'local_agent', is_backgrounded: true, description: 'bg' });
    feed({
      type: 'user',
      tool_use_result: { status: 'async_launched' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task1', content: 'running in the background' }] },
    });
    const beforeResult = emitted.length;
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(byKind(emitted.slice(beforeResult), 'subagent_list_update').length, 0,
      'the turn end must not close a background agent');

    // Completion while idle: nothing may be emitted (it would open a self-turn).
    const idle = emitted.length;
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'Found 3 issues', usage: { total_tokens: 900 } });
    assert.equal(emitted.length, idle);

    // The CLI's own follow-up turn carries the outcome, under the same agent.
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    const [entry] = byKind(emitted.slice(idle), 'subagent_list_update').flatMap((ev) => ev.subagents as SubagentInfo[]);
    assert.equal(entry.sessionId, 'toolu_task1');
    assert.equal(entry.parentToolCallId, 'toolu_task1');
    assert.equal(entry.status, 'terminated');
    assert.equal(entry.outcome, 'completed');
    assert.equal(entry.result, 'Found 3 issues');
    assert.equal(entry.background, true);
    assert.notEqual(entry.agentName, 'subagent', 'the carried entry keeps its identity');

    // Published once; the turn after that no longer carries it.
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    const later = emitted.length;
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    assert.equal(byKind(emitted.slice(later), 'subagent_list_update').length, 0);
  });

  test('a stopped agent\'s notification summary is its description, not why it stopped', () => {
    const { emitted, feed } = makeTranslator();
    // The Agent call, task_started and the stop notification all carry the
    // task's description, as CLI 2.1.310 sends them when a Stop kills it.
    spawnTask(feed, 'toolu_a');
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'toolu_a', task_type: 'local_agent', description: 'Find the auth code' });
    spawnTask(feed, 'toolu_b');
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-b', tool_use_id: 'toolu_b', task_type: 'local_agent', description: 'Find the auth code' });
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'stopped', summary: 'Find the auth code' });
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-b', status: 'stopped', summary: 'Stopped: the parent hit its budget' });
    const roster = byKind(emitted, 'subagent_list_update').flatMap((ev) => ev.subagents as SubagentInfo[]);
    const a = roster.filter((entry) => entry.sessionId === 'toolu_a').at(-1)!;
    assert.equal(a.outcome, 'cancelled');
    assert.equal(a.error, undefined, 'the task description is not a reason');
    const b = roster.filter((entry) => entry.sessionId === 'toolu_b').at(-1)!;
    assert.equal(b.outcome, 'cancelled');
    assert.equal(b.error, 'Stopped: the parent hit its budget', 'other text is kept as the reason');
  });

  test('a self-initiated turn measures its own duration', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { emitted, feed, startTurn } = makeTranslator();
    startTurn();
    t.mock.timers.tick(2_000);
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    // Idle for 30 s, then the CLI starts its own turn (a background completion).
    t.mock.timers.tick(30_000);
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    t.mock.timers.tick(3_000);
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    const durations = byKind(emitted, 'usage_summary').map((ev) => ev.turnDurationMs);
    assert.deepEqual(durations, [2_000, 3_000]);
  });

  test('background work lasts until a turn reports the background agent\'s outcome', () => {
    const { feed, startTurn, hasBackgroundSubagents } = makeTranslator();
    const launch = (id: string, taskId: string) => {
      spawnTask(feed, id);
      feed({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, task_type: 'local_agent', is_backgrounded: true, description: 'bg' });
      feed({
        type: 'user',
        tool_use_result: { status: 'async_launched' },
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'running in the background' }] },
      });
    };
    const endTurn = () => feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });

    // A foreground agent, working or closed by the turn end, is not background work.
    spawnTask(feed, 'toolu_fg');
    assert.equal(hasBackgroundSubagents(), false);
    endTurn();
    assert.equal(hasBackgroundSubagents(), false, 'a foreground agent the turn closed holds nothing');

    startTurn();
    launch('toolu_bg', 'task-bg');
    assert.equal(hasBackgroundSubagents(), true, 'launched in the background');
    endTurn();
    assert.equal(hasBackgroundSubagents(), true, 'still running after its turn');

    // Finished while idle: nothing reported it yet.
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'done' });
    assert.equal(hasBackgroundSubagents(), true, 'an unreported completion still needs the process');

    // The CLI's own follow-up turn publishes it.
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    assert.equal(hasBackgroundSubagents(), false, 'reported: nothing left to protect');
    endTurn();
    assert.equal(hasBackgroundSubagents(), false);

    // A completion inside a turn is published at once.
    startTurn();
    launch('toolu_bg2', 'task-bg2');
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg2', status: 'failed', summary: 'boom' });
    assert.equal(hasBackgroundSubagents(), false);
  });

  // ── onBackgroundSubagents: what the session reports to the registry ──────

  function reportingTranslator() {
    const emitted: NormalizedEvent[] = [];
    const reports: string[][] = [];
    /** How many events had been emitted at each report. */
    const reportedAt: number[] = [];
    const translator = createTranslator((ev) => emitted.push(ev), {
      onBackgroundSubagents: (ids) => { reports.push(ids); reportedAt.push(emitted.length); },
    });
    const feed = translator.feed;
    const launch = (id: string, taskId: string) => {
      spawnTask(feed, id);
      feed({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, task_type: 'local_agent', is_backgrounded: true, description: 'bg' });
      feed({
        type: 'user',
        tool_use_result: { status: 'async_launched' },
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'running in the background' }] },
      });
    };
    const endTurn = () => feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    return { ...translator, emitted, reports, reportedAt, launch, endTurn };
  }

  test('a backgrounded agent is reported once, and stays reported after it finishes while idle', () => {
    const { feed, reports, launch, endTurn, hasBackgroundSubagents } = reportingTranslator();
    launch('toolu_bg', 'task-bg');
    assert.deepEqual(reports, [['toolu_bg']], 'reported when task_started marks it backgrounded; the placeholder adds nothing');

    endTurn();
    feed({ type: 'system', subtype: 'task_progress', task_id: 'task-bg', tool_use_id: 'toolu_bg', description: 'Reading', usage: { total_tokens: 5 } });
    feed({ type: 'assistant', parent_tool_use_id: 'toolu_bg', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }] } });
    // Finished while idle: carried, not yet reported by a turn.
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'done' });
    assert.equal(hasBackgroundSubagents(), true);
    assert.deepEqual(reports, [['toolu_bg']], 'no call while the set is unchanged');
  });

  test('the self-turn that publishes an idle completion reports the set empty after publishing it', () => {
    const { feed, emitted, reports, reportedAt, launch, endTurn } = reportingTranslator();
    launch('toolu_bg', 'task-bg');
    endTurn();
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'done' });

    const before = emitted.length;
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    assert.deepEqual(reports, [['toolu_bg'], []]);
    const published = emitted.slice(before, reportedAt[1]).filter((ev) => ev.kind === 'subagent_list_update');
    assert.equal(published.length, 1, 'the outcome is emitted before the withdrawal');

    endTurn();
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    assert.deepEqual(reports, [['toolu_bg'], []], 'nothing more once withdrawn');
  });

  test('a foreground turn after an idle completion withdraws it too', () => {
    const { feed, reports, launch, endTurn, startTurn } = reportingTranslator();
    launch('toolu_bg', 'task-bg');
    endTurn();
    feed({ type: 'system', subtype: 'task_updated', task_id: 'task-bg', patch: { status: 'killed' } });
    assert.deepEqual(reports, [['toolu_bg']]);
    startTurn();
    assert.deepEqual(reports, [['toolu_bg'], []]);
  });

  test('a still-running agent stays reported across later turns until it finishes inside one', () => {
    const { feed, reports, launch, endTurn, startTurn } = reportingTranslator();
    launch('toolu_bg', 'task-bg');
    endTurn();
    startTurn();
    endTurn();
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    assert.deepEqual(reports, [['toolu_bg']], 'new turns keep a running agent');
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'failed', summary: 'boom' });
    assert.deepEqual(reports, [['toolu_bg'], []], 'a completion inside a turn is published, so withdrawn at once');
  });

  test('several background agents are reported as a set', () => {
    const { feed, reports, launch } = reportingTranslator();
    launch('toolu_a', 'task-a');
    launch('toolu_b', 'task-b');
    feed({ type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'completed', summary: 'a done' });
    assert.deepEqual(reports, [['toolu_a'], ['toolu_a', 'toolu_b'], ['toolu_b']]);
  });

  test('the launch placeholder alone backgrounds an agent', () => {
    const { feed, reports } = reportingTranslator();
    spawnTask(feed, 'toolu_bg');
    feed({
      type: 'user',
      tool_use_result: { status: 'async_launched' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'running in the background' }] },
    });
    assert.deepEqual(reports, [['toolu_bg']]);
  });

  test('foreground agents are never reported', () => {
    const { feed, reports, endTurn, startTurn } = reportingTranslator();
    spawnTask(feed, 'toolu_fg');
    feed({ type: 'assistant', parent_tool_use_id: 'toolu_fg', message: { content: [{ type: 'text', text: 'working' }] } });
    feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'done' }] } });
    spawnTask(feed, 'toolu_fg2');
    endTurn(); // closes the second one as unknown
    startTurn();
    feed({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow', description: 'probe' });
    assert.deepEqual(reports, []);
  });

  test('a translator without the option still tracks background work', () => {
    const { feed, hasBackgroundSubagents } = makeTranslator();
    spawnTask(feed, 'toolu_bg');
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_bg', task_type: 'local_agent', is_backgrounded: true });
    assert.equal(hasBackgroundSubagents(), true);
  });

  test('a still-running background agent appears in a later turn only when it acts', () => {
    const { emitted, feed, startTurn } = makeTranslator();
    spawnTask(feed);
    feed({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_task1', task_type: 'local_agent', is_backgrounded: true, description: 'bg' });
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    startTurn();
    const before = emitted.length;
    feed({ type: 'assistant', parent_tool_use_id: 'toolu_task1', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }] } });
    const kinds = emitted.slice(before).map((ev) => ev.kind);
    assert.deepEqual(kinds, ['subagent_list_update', 'subagent_tool_activity'],
      'the roster entry precedes its activity so the fold knows the agent');
    const [entry] = (emitted[before] as Extract<NormalizedEvent, { kind: 'subagent_list_update' }>).subagents as SubagentInfo[];
    assert.equal(entry.status, 'working');
  });

  test('workflow tasks are left to the workflow tracker, and nothing is emitted between turns', () => {
    const { emitted, feed } = makeTranslator();
    feed({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow', description: 'probe' });
    assert.equal(byKind(emitted, 'subagent_list_update').length, 0);
    spawnTask(feed);
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    const before = emitted.length;
    // A forwarded child frame after the turn ended must not open a self-turn.
    feed({ type: 'assistant', parent_tool_use_id: 'toolu_task1', message: { content: [{ type: 'text', text: 'late' }] } });
    assert.equal(emitted.length, before);
    // The next self-initiated turn starts with system:init and a fresh roster.
    feed({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    spawnTask(feed, 'toolu_next');
    const subs = byKind(emitted.slice(before), 'subagent_list_update').flatMap((ev) => ev.subagents as SubagentInfo[]);
    assert.deepEqual(subs.map((s) => s.sessionId), ['toolu_next']);
  });

  test('subagent stream_event partials with parent_tool_use_id are dropped', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    const before = emitted.length;

    feed({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_task1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner partial' } },
    });

    assert.equal(emitted.slice(before).length, 0, 'subagent partial deltas emit nothing on the parent stream');
  });

  test('parent tool_result for a Task id terminates the subagent', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    const before = emitted.length;

    feed({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_task1', content: 'done' }] },
    });

    const fresh = emitted.slice(before);
    // The Task chip still completes...
    assert.equal(byKind(fresh, 'tool_call_update').length, 1);
    // ...and the roster flips to terminated.
    const rosters = byKind(fresh, 'subagent_list_update');
    assert.equal(rosters.length, 1);
    const subs = rosters[0].subagents as Array<Record<string, unknown>>;
    assert.equal(subs[0].status, 'terminated');
  });
});

// ── Native usage, compaction and held turns (probe-backed, CLI 2.1.312) ──────

describe('claudeEventTranslator native capabilities', () => {
  // The shape a 2.1.312 result carries (probe 01-usage): per-turn main-loop usage.
  const RESULT_USAGE = {
    input_tokens: 3, cache_creation_input_tokens: 7237, cache_read_input_tokens: 11849, output_tokens: 5,
    output_tokens_details: { thinking_tokens: 2 }, service_tier: 'standard',
  };

  test('a successful result reports its own token counts as native and no cost', () => {
    const emitted: NormalizedEvent[] = [];
    const { feed } = createTranslator((ev) => emitted.push(ev));
    feed({ type: 'result', subtype: 'success', usage: RESULT_USAGE, total_cost_usd: 0.0307,
      modelUsage: { 'global.anthropic.claude-sonnet-4-6': { costUSD: 0.0307, costBasis: 'list', contextWindow: 200_000 } } });
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.ok(summary?.kind === 'usage_summary');
    assert.equal(summary.source, 'native');
    assert.equal(summary.inputTokens, 3 + 7237 + 11849);
    assert.equal(summary.cachedInputTokens, 11849);
    assert.equal(summary.outputTokens, 5);
    assert.equal(summary.reasoningOutputTokens, 2);
    assert.equal(summary.totalTokens, 3 + 7237 + 11849 + 5);
    assert.equal(summary.charge, undefined, 'the CLI cost is a list-price estimate');
    assert.equal(summary.totalCredits, undefined);
    // Across the wire: the route keeps every token field.
    const wire = toChatStreamEvent(summary);
    assert.ok(wire);
    const parsed = parseChatStreamEvent(wire!.event, JSON.stringify(wire!.data));
    assert.equal(parsed?.event, 'usage_summary');
    assert.equal(parsed?.event === 'usage_summary' && parsed.data.totalTokens, 19094);
    assert.equal(parsed?.event === 'usage_summary' && parsed.data.cachedInputTokens, 11849);
  });

  test('a result without usage is unverifiable, not zero', () => {
    const emitted: NormalizedEvent[] = [];
    const { feed } = createTranslator((ev) => emitted.push(ev));
    feed({ type: 'result', subtype: 'success' });
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.ok(summary?.kind === 'usage_summary');
    assert.equal(summary.source, 'unverifiable');
    assert.equal(summary.totalTokens, undefined);
  });

  test('a compaction reports start, end and the compacted context size', () => {
    const emitted: NormalizedEvent[] = [];
    const translator = createTranslator((ev) => emitted.push(ev));
    translator.feed({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-4-6' });
    // The order probe 02-compact recorded.
    translator.feed({ type: 'system', subtype: 'status', status: 'compacting' });
    translator.feed({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    translator.feed({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-4-6' });
    translator.feed({ type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 19_107, post_tokens: 4_174, duration_ms: 7379 } });
    translator.feed({ type: 'user', message: { role: 'user', content: 'This session is being continued…' } });
    translator.feed({ type: 'result', subtype: 'success', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    assert.deepEqual(emitted.slice(0, 3).map((ev) => ev.kind), ['compaction_start', 'compaction_end', 'context_usage']);
    const context = emitted[2];
    assert.ok(context.kind === 'context_usage');
    const { entry } = getClaudeModelEntry('claude-sonnet-4-6');
    assert.equal(context.contextUsagePercentage, (4_174 / entry.contextWindow) * 100);
    assert.deepEqual(translator.takeCompaction(), { result: 'success', trigger: 'manual', preTokens: 19_107, postTokens: 4_174 });
    assert.equal(translator.takeCompaction(), null, 'taken once');
    assert.equal(emitted.at(-1)?.kind, 'turn_end');
  });

  test('a failed compaction ends with its error and reports no boundary', () => {
    const emitted: NormalizedEvent[] = [];
    const translator = createTranslator((ev) => emitted.push(ev));
    translator.feed({ type: 'system', subtype: 'status', status: 'compacting' });
    translator.feed({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages' });
    assert.deepEqual(emitted, [
      { kind: 'compaction_start', detail: 'Claude Code is compacting the conversation' },
      { kind: 'compaction_end', detail: 'Compaction failed: Not enough messages' },
    ]);
    assert.deepEqual(translator.takeCompaction(), { result: 'failed', error: 'Not enough messages' });
  });

  test('an ordinary requesting status is not a compaction', () => {
    const emitted: NormalizedEvent[] = [];
    const { feed } = createTranslator((ev) => emitted.push(ev));
    feed({ type: 'system', subtype: 'status', status: 'requesting' });
    feed({ type: 'system', subtype: 'status', status: null });
    assert.deepEqual(emitted, []);
  });

  test('a held result carries its tokens into the summary of the result that ends the host turn', () => {
    const emitted: NormalizedEvent[] = [];
    let hold = true;
    const translator = createTranslator((ev) => emitted.push(ev), { holdTurnEnd: () => hold });
    translator.startTurn();
    translator.feed({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 10 } });
    assert.equal(emitted.length, 0, 'no summary, no turn_end while held');
    hold = false;
    translator.feed({ type: 'result', subtype: 'success', usage: { input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 20 } });
    const summaries = emitted.filter((ev): ev is Extract<NormalizedEvent, { kind: 'usage_summary' }> => ev.kind === 'usage_summary');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].inputTokens, 350);
    assert.equal(summaries[0].outputTokens, 30);
    assert.equal(summaries[0].cachedInputTokens, 50);
    assert.deepEqual(emitted.filter((ev) => ev.kind === 'turn_end'), [{ kind: 'turn_end', stopReason: 'end_turn' }]);
  });

  test('releaseHeldTurn ends a held turn with the carried tokens; error results are never held', () => {
    const emitted: NormalizedEvent[] = [];
    const translator = createTranslator((ev) => emitted.push(ev), { holdTurnEnd: () => true });
    translator.startTurn();
    translator.feed({ type: 'result', subtype: 'success', usage: { input_tokens: 40, output_tokens: 4 } });
    translator.releaseHeldTurn();
    const summary = emitted.find((ev) => ev.kind === 'usage_summary');
    assert.ok(summary?.kind === 'usage_summary');
    assert.equal(summary.totalTokens, 44);
    assert.equal(emitted.at(-1)?.kind, 'turn_end');
    emitted.length = 0;
    translator.startTurn();
    translator.feed({ type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 1, output_tokens: 1 } });
    assert.deepEqual(emitted.at(-1), { kind: 'turn_end', stopReason: 'error' });
  });
});
