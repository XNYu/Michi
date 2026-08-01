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
import { createTranslator } from '../src/agents/claude/claudeEventTranslator';
import { NormalizedEvent } from '../src/services/chatEvents';

// ── helpers ────────────────────────────────────────────────────────────────

function makeTranslator(): {
  emitted: NormalizedEvent[];
  feed: (env: Record<string, unknown>) => void;
  startTurn: () => void;
  getSessionId: () => string | null;
} {
  const emitted: NormalizedEvent[] = [];
  const { feed, startTurn, getSessionId } = createTranslator((ev) => emitted.push(ev));
  return { emitted, feed, startTurn, getSessionId };
}

describe('claudeEventTranslator', () => {
  // ── Case 1: system.init captures session id, emits nothing ───────────────

  test('system.init envelope does not emit any event and getSessionId returns captured id', () => {
    const { emitted, feed, getSessionId } = makeTranslator();

    feed({ type: 'system', subtype: 'init', session_id: 'sess-abc-123' });

    assert.equal(emitted.length, 0, 'system.init must not emit any NormalizedEvent');
    assert.equal(getSessionId(), 'sess-abc-123');
  });

  // ── Case 2: assistant with text blocks emits NOTHING (delivered via stream_event) ────

  test('assistant envelope with single text block emits no events', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });

    // text and thinking are streamed via stream_event content_block_delta;
    // re-emitting them from the assistant envelope would duplicate output.
    assert.equal(emitted.length, 0);
  });

  // ── Case 3: assistant with thinking + text blocks emits NOTHING ─────────

  test('assistant envelope with thinking and text blocks emits no events', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me reason...' },
          { type: 'text', text: 'Here is the answer.' },
        ],
      },
    });

    assert.equal(emitted.length, 0);
  });

  // ── Case 4: assistant with tool_use block → tool_call event ──────────────

  test('assistant envelope with tool_use block emits tool_call event', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01ABC',
            name: 'read_file',
            input: { path: '/foo/bar.ts' },
          },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    // NormalizedEvent has `{ kind: "tool_call" | "tool_call_update"; ... }` as one union member,
    // so Extract<NormalizedEvent, { kind: 'tool_call' }> resolves to never.  Cast via unknown.
    type ToolCallEv = { kind: string; toolCallId: string; title: string; status: string; kindType?: string; detail?: string };
    const ev = emitted[0] as unknown as ToolCallEv;
    assert.equal(ev.kind, 'tool_call');
    assert.equal(ev.toolCallId, 'toolu_01ABC');
    assert.equal(ev.title, 'read_file');
    assert.equal(ev.status, 'in_progress');
    assert.equal(ev.kindType, 'tool');
    // detail should contain stringified input (truncated to 200 chars)
    assert.ok(typeof ev.detail === 'string');
    assert.ok((ev.detail as string).includes('bar.ts'));
  });

  // ── Case 5: stream_event with text_delta → chunk event ───────────────────

  test('stream_event with text_delta emits chunk event', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'streamed text' },
      },
    });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { kind: 'chunk', text: 'streamed text' });
  });

  // ── Case 6: stream_event with thinking_delta → thought event ─────────────

  test('stream_event with thinking_delta emits thought event', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'partial thought' },
      },
    });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { kind: 'thought', text: 'partial thought' });
  });

  // ── Case 7: user envelope with tool_result → tool_call_update ────────────

  test('user envelope with tool_result emits tool_call_update with matching toolCallId', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01ABC',
            content: 'file contents here',
          },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    // Same union-member issue as tool_call — cast via unknown.
    type ToolCallUpdateEv = { kind: string; toolCallId: string; status: string; kindType?: string };
    const ev = emitted[0] as unknown as ToolCallUpdateEv;
    assert.equal(ev.kind, 'tool_call_update');
    assert.equal(ev.toolCallId, 'toolu_01ABC');
    assert.equal(ev.status, 'completed');
    assert.equal(ev.kindType, 'tool');
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

  // ── Case 8: result.success with usage → usage_summary then turn_end ──────
  //
  // Cost tracking is disabled (all rates are zero), so totalCredits = 0.
  // contextUsagePercentage still works (uses contextWindow from catalog).
  //   usage = { input_tokens:100, cache_read_input_tokens:50, cache_creation_input_tokens:50, output_tokens:200 }
  //   contextPct = (100 + 50 + 50) / 1_000_000 * 100 = 0.02

  test('result.success with usage emits usage_summary then turn_end with correct token math', () => {
    const { emitted, feed } = makeTranslator();

    // First, tell the translator we're using opus so rates are known
    feed({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7-20250514',
        content: [],
      },
    });
    emitted.length = 0; // reset

    feed({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 50,
        output_tokens: 200,
      },
    });

    assert.equal(emitted.length, 2, 'should emit usage_summary then turn_end');

    type UsageSummaryEv = { kind: string; contextUsagePercentage: number; totalCredits: number; turnDurationMs: number };
    const summary = emitted[0] as unknown as UsageSummaryEv;
    assert.equal(summary.kind, 'usage_summary');

    // contextUsagePercentage = (100+50+50)/1000000 * 100 = 0.02
    assert.ok(
      Math.abs(summary.contextUsagePercentage - 0.02) < 1e-9,
      `contextUsagePercentage: expected 0.02, got ${summary.contextUsagePercentage}`,
    );

    // Cost tracking disabled — totalCredits is always 0
    assert.equal(summary.totalCredits, 0);

    assert.ok(Number.isFinite(summary.turnDurationMs) && summary.turnDurationMs >= 0);

    type TurnEndEv = { kind: string; stopReason?: string };
    const turnEnd = emitted[1] as unknown as TurnEndEv;
    assert.equal(turnEnd.kind, 'turn_end');
    assert.equal(turnEnd.stopReason, 'end_turn');
  });

  test('usage_summary reports per-turn context and credits, not cumulative session totals', () => {
    const { emitted, feed, startTurn } = makeTranslator();

    feed({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7-20250514',
        content: [],
      },
    });
    emitted.length = 0;

    startTurn();
    feed({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 160_000,
        output_tokens: 1_000,
      },
    });

    startTurn();
    feed({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 60_000,
        output_tokens: 500,
      },
    });

    assert.equal(emitted.length, 4, 'two successful turns should emit usage_summary + turn_end each');

    type UsageSummaryEv = { kind: string; contextUsagePercentage: number; totalCredits: number };
    const first = emitted[0] as unknown as UsageSummaryEv;
    const second = emitted[2] as unknown as UsageSummaryEv;

    assert.equal(first.kind, 'usage_summary');
    assert.equal(second.kind, 'usage_summary');
    assert.ok(
      Math.abs(first.contextUsagePercentage - 16) < 1e-9,
      `first contextUsagePercentage: expected 16, got ${first.contextUsagePercentage}`,
    );
    assert.ok(
      Math.abs(second.contextUsagePercentage - 6) < 1e-9,
      `second contextUsagePercentage: expected 6, got ${second.contextUsagePercentage}`,
    );

    const firstExpectedCost = 0;  // cost tracking disabled
    const secondExpectedCost = 0;
    assert.ok(Math.abs(first.totalCredits - firstExpectedCost) < 1e-9);
    assert.ok(Math.abs(second.totalCredits - secondExpectedCost) < 1e-9);
  });

  // ── Case 9: result.error_max_turns → mcp_server_error + turn_end ─────────

  test('result.error_max_turns emits mcp_server_error then turn_end', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'result',
      subtype: 'error_max_turns',
      result: 'Max turns reached',
    });

    assert.equal(emitted.length, 2, `expected 2 events (mcp_server_error + turn_end), got ${emitted.length}`);

    type McpServerErrorEv = { kind: string; serverName: string; error: string };
    const errorEv = emitted[0] as unknown as McpServerErrorEv;
    assert.equal(errorEv.kind, 'mcp_server_error');
    assert.equal(errorEv.serverName, 'claude-cli');
    assert.equal(errorEv.error, 'Max turns reached');

    type TurnEndEv2 = { kind: string; stopReason?: string };
    const turnEnd = emitted[1] as unknown as TurnEndEv2;
    assert.equal(turnEnd.kind, 'turn_end');
    assert.equal(turnEnd.stopReason, 'error_max_turns');
  });

  // ── Case 10: system.api_retry → mcp_server_error ─────────────────────────

  test('system.api_retry envelope emits mcp_server_error with serverName anthropic-api', () => {
    const { emitted, feed } = makeTranslator();

    feed({ type: 'system', subtype: 'api_retry', error: 'rate limit exceeded' });

    assert.equal(emitted.length, 1);
    type McpServerErrorEv = { kind: string; serverName: string; error: string };
    const ev = emitted[0] as unknown as McpServerErrorEv;
    assert.equal(ev.kind, 'mcp_server_error');
    assert.equal(ev.serverName, 'anthropic-api');
    assert.equal(ev.error, 'rate limit exceeded');
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

  test('assistant envelope tool_use without prior content_block_start still emits tool_call (fallback for non-partial mode)', () => {
    const { emitted, feed } = makeTranslator();

    feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_solo', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    type ToolCallEv = { kind: string; toolCallId: string; title: string; detail: string };
    const ev = emitted[0] as unknown as ToolCallEv;
    assert.equal(ev.kind, 'tool_call');
    assert.equal(ev.toolCallId, 'toolu_solo');
    assert.equal(ev.title, 'bash');
    assert.ok(ev.detail.includes('ls'));
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

  test('parent Task tool_use seeds the subagent roster AND still emits the inline Task chip', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);

    const rosters = byKind(emitted, 'subagent_list_update');
    assert.equal(rosters.length, 1, 'exactly one roster update on spawn');
    const subs = rosters[0].subagents as Array<Record<string, unknown>>;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].sessionId, 'toolu_task1');
    assert.equal(subs[0].agentName, 'explore');
    assert.equal(subs[0].initialQuery, 'Find the auth code');
    assert.equal(subs[0].status, 'working');

    // The parent transcript still gets the Task chip marking the spawn point.
    const chips = byKind(emitted, 'tool_call');
    assert.equal(chips.length, 1);
    assert.equal(chips[0].title, 'Task');
    assert.equal(chips[0].toolCallId, 'toolu_task1');
  });

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
    // Crucially: no parent tool_call chip for the subagent's inner tool.
    assert.equal(byKind(fresh, 'tool_call').length, 0);
    assert.equal(
      (fresh as unknown as AnyEv[]).some((e) => e.toolCallId === 'toolu_inner'),
      false,
    );
  });

  test('subagent inner text updates statusMessage and never leaks a parent chunk', () => {
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
    const rosters = byKind(fresh, 'subagent_list_update');
    assert.equal(rosters.length, 1);
    const subs = rosters[0].subagents as Array<Record<string, unknown>>;
    assert.equal(subs[0].statusMessage, 'Looking at auth middleware...');
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

  test('turn-end result terminates any subagent still marked working', () => {
    const { emitted, feed } = makeTranslator();
    spawnTask(feed);
    const before = emitted.length;

    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });

    const fresh = emitted.slice(before);
    const rosters = byKind(fresh, 'subagent_list_update');
    assert.equal(rosters.length, 1, 'safety roster update on turn end');
    const subs = rosters[0].subagents as Array<Record<string, unknown>>;
    assert.equal(subs[0].status, 'terminated');
    // Ordering: termination roster must precede turn_end.
    const rosterIdx = (fresh as unknown as AnyEv[]).findIndex((e) => e.kind === 'subagent_list_update');
    const turnEndIdx = (fresh as unknown as AnyEv[]).findIndex((e) => e.kind === 'turn_end');
    assert.ok(rosterIdx >= 0 && turnEndIdx >= 0 && rosterIdx < turnEndIdx);
  });

  test('startTurn resets the roster between turns', () => {
    const { emitted, feed, startTurn } = makeTranslator();
    spawnTask(feed);
    startTurn();
    const before = emitted.length;

    // No lingering agent → a bare result must not emit a termination roster.
    feed({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(byKind(emitted.slice(before), 'subagent_list_update').length, 0);
  });
});
