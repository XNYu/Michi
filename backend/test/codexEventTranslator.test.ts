/**
 * Tests for codexEventTranslator.ts
 *
 * Uses fixture-style: feed concrete wire notification sequences and assert
 * emitted NormalizedEvents. Uses node:test (NOT vitest).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexTranslator } from '../src/agents/codex/codexEventTranslator';
import type { NormalizedEvent } from '../src/services/chatEvents';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTranslator(): {
  emitted: NormalizedEvent[];
  feed: (method: string, params?: Record<string, unknown>) => void;
  startTurn: () => void;
} {
  const emitted: NormalizedEvent[] = [];
  const { feed, startTurn } = createCodexTranslator((ev) => emitted.push(ev));
  return {
    emitted,
    feed: (method, params = {}) => feed(method, params),
    startTurn,
  };
}

// Convenience type aliases to avoid TypeScript union narrowing complaints
type AnyEv = Record<string, unknown>;

describe('codexEventTranslator', () => {
  // ── Text deltas ─────────────────────────────────────────────────────────────

  test('item/agentMessage/delta with delta string emits chunk', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/agentMessage/delta', { delta: 'Hello world' });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { kind: 'chunk', text: 'Hello world' });
  });

  test('item/agentMessage/delta with empty delta emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/agentMessage/delta', { delta: '' });

    assert.equal(emitted.length, 0);
  });

  // ── Reasoning deltas ────────────────────────────────────────────────────────

  test('item/reasoning/textDelta emits thought', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/reasoning/textDelta', { delta: 'I am thinking...' });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { kind: 'thought', text: 'I am thinking...' });
  });

  test('item/reasoning/summaryTextDelta emits thought', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/reasoning/summaryTextDelta', { delta: 'Summary reasoning' });

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { kind: 'thought', text: 'Summary reasoning' });
  });

  // ── Tool items: item/started ────────────────────────────────────────────────

  test('item/started with commandExecution type emits tool_call', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: {
        id: 'item-001',
        type: 'commandExecution',
        command: 'head -n 5 package.json',
        commandActions: [
          {
            type: 'read',
            command: 'head -n 5 package.json',
            name: 'package.json',
            path: '/repo/package.json',
          },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call');
    assert.equal(ev['toolCallId'], 'item-001');
    assert.equal(ev['title'], 'Read package.json');
    assert.equal(ev['status'], 'in_progress');
    assert.equal(ev['kindType'], 'read');
  });

  test('item/started with SKILL.md commandExecution title uses skill directory', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: {
        id: 'item-skill',
        type: 'commandExecution',
        command: 'head -n 5 /Users/me/.codex/skills/using-superpowers/SKILL.md',
        commandActions: [
          {
            type: 'read',
            command: 'head -n 5 /Users/me/.codex/skills/using-superpowers/SKILL.md',
            name: 'SKILL.md',
            path: '/Users/me/.codex/skills/using-superpowers/SKILL.md',
          },
        ],
      },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['title'], 'Read using-superpowers');
    assert.equal(ev['kindType'], 'read');
  });

  test('item/started with unknown commandExecution falls back to shell title', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: { id: 'item-shell', type: 'commandExecution', command: 'npm test' },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['title'], 'Shell');
    assert.equal(ev['kindType'], 'bash');
  });

  test('item/started with fileChange type emits tool_call', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: { id: 'item-002', type: 'fileChange' },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call');
    assert.equal(ev['toolCallId'], 'item-002');
    assert.equal(ev['title'], 'Edit files');
    assert.equal(ev['kindType'], 'edit');
  });

  test('item/started with mcpToolCall type emits tool_call', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: {
        id: 'item-003',
        type: 'mcpToolCall',
        server: '__michi_internal__',
        tool: 'save_context',
        arguments: { key: 'value' },
      },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call');
    assert.equal(ev['toolCallId'], 'item-003');
    assert.equal(ev['title'], 'save_context');
    assert.ok(typeof ev['detail'] === 'string' && (ev['detail'] as string).includes('value'));
  });

  test('item/started with dynamicToolCall type emits real tool name', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: {
        id: 'item-dyn',
        type: 'dynamicToolCall',
        namespace: 'image_gen',
        tool: 'imagegen',
        arguments: { prompt: 'cat' },
      },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call');
    assert.equal(ev['toolCallId'], 'item-dyn');
    assert.equal(ev['title'], 'image_gen.imagegen');
    assert.ok(typeof ev['detail'] === 'string' && (ev['detail'] as string).includes('cat'));
  });

  test('item/started with webSearch type emits tool_call', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: { id: 'item-004', type: 'webSearch', query: 'typescript docs' },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call');
    assert.equal(ev['toolCallId'], 'item-004');
    assert.equal(ev['title'], 'Search typescript docs');
    assert.ok(typeof ev['detail'] === 'string' && (ev['detail'] as string).includes('typescript'));
  });

  test('item/started with agentMessage type (streamed) emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: { id: 'item-005', type: 'agentMessage' },
    });

    assert.equal(emitted.length, 0, 'agentMessage is streamed via deltas — item/started must be skipped');
  });

  test('item/started with reasoning type (streamed) emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: { id: 'item-006', type: 'reasoning' },
    });

    assert.equal(emitted.length, 0, 'reasoning is streamed via deltas — item/started must be skipped');
  });

  // ── Tool items: item/completed ──────────────────────────────────────────────

  test('item/completed for commandExecution emits tool_call_update with completed status', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/completed', {
      item: { id: 'item-001', type: 'commandExecution', status: 'success' },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call_update');
    assert.equal(ev['toolCallId'], 'item-001');
    assert.equal(ev['status'], 'completed');
    assert.equal(ev['kindType'], 'bash');
  });

  test('item/completed with status failed emits tool_call_update with failed status', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/completed', {
      item: { id: 'item-002', type: 'commandExecution', status: 'failed' },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call_update');
    assert.equal(ev['toolCallId'], 'item-002');
    assert.equal(ev['status'], 'failed', 'failed item status must map to failed');
  });

  test('item/completed for agentMessage (streamed) emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/completed', {
      item: { id: 'item-007', type: 'agentMessage', status: 'success' },
    });

    assert.equal(emitted.length, 0);
  });

  // ── Output deltas ───────────────────────────────────────────────────────────

  test('item/commandExecution/outputDelta emits tool_call_update in_progress', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/started', {
      item: {
        id: 'item-001',
        type: 'commandExecution',
        command: 'head package.json',
        commandActions: [
          {
            type: 'read',
            command: 'head package.json',
            name: 'package.json',
            path: '/repo/package.json',
          },
        ],
      },
    });
    feed('item/commandExecution/outputDelta', { itemId: 'item-001', delta: 'stdout line\n' });

    assert.equal(emitted.length, 2);
    const ev = emitted[1] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call_update');
    assert.equal(ev['toolCallId'], 'item-001');
    assert.equal(ev['status'], 'in_progress');
    assert.equal(ev['kindType'], 'read');
    assert.ok(typeof ev['detail'] === 'string' && (ev['detail'] as string).includes('stdout'));
  });

  test('item/fileChange/outputDelta emits tool_call_update in_progress', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/fileChange/outputDelta', { itemId: 'item-002', delta: '+++ added line' });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call_update');
    assert.equal(ev['toolCallId'], 'item-002');
    assert.equal(ev['status'], 'in_progress');
  });

  // ── Token usage ─────────────────────────────────────────────────────────────

  test('thread/tokenUsage/updated emits context_usage using modelContextWindow', () => {
    const { emitted, feed } = makeTranslator();

    feed('thread/tokenUsage/updated', {
      total: { totalTokens: 50_000 },
      modelContextWindow: 200_000,
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'context_usage');
    // 50_000 / 200_000 * 100 = 25
    assert.ok(
      Math.abs((ev['contextUsagePercentage'] as number) - 25) < 1e-9,
      `contextUsagePercentage: expected 25, got ${ev['contextUsagePercentage']}`,
    );
  });

  test('thread/tokenUsage/updated with zero modelContextWindow emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('thread/tokenUsage/updated', {
      total: { totalTokens: 10_000 },
      modelContextWindow: 0,
    });

    assert.equal(emitted.length, 0, 'zero context window must not emit to avoid division by zero');
  });

  test('thread/tokenUsage/updated without modelContextWindow emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('thread/tokenUsage/updated', {
      total: { totalTokens: 10_000 },
    });

    assert.equal(emitted.length, 0);
  });

  // ── Turn lifecycle ──────────────────────────────────────────────────────────

  test('turn/completed emits usage_summary then turn_end with turn status', () => {
    const { emitted, feed, startTurn } = makeTranslator();

    startTurn();
    feed('turn/completed', {
      turn: { status: 'completed' },
    });

    assert.equal(emitted.length, 2, 'turn/completed must emit usage_summary + turn_end');

    const summary = emitted[0] as unknown as AnyEv;
    assert.equal(summary['kind'], 'usage_summary');
    assert.equal(summary['contextUsagePercentage'], 0);
    assert.equal(summary['totalCredits'], 0);
    assert.ok(
      typeof summary['turnDurationMs'] === 'number' && (summary['turnDurationMs'] as number) >= 0,
      'turnDurationMs must be a non-negative number',
    );

    const turnEnd = emitted[1] as unknown as AnyEv;
    assert.equal(turnEnd['kind'], 'turn_end');
    assert.equal(turnEnd['stopReason'], 'completed');
  });

  test('turn/completed with failed turn status emits a runtime error', () => {
    const { emitted, feed } = makeTranslator();

    feed('turn/completed', {
      turn: { status: 'failed' },
    });

    assert.equal(emitted.length, 2);
    const runtimeError = emitted[1] as unknown as AnyEv;
    assert.equal(runtimeError['kind'], 'runtime_error');
    assert.equal(runtimeError['error'], 'Codex turn failed');
  });

  test('turn/started resets turn timer without emitting', () => {
    const { emitted, feed } = makeTranslator();

    feed('turn/started', {});

    assert.equal(emitted.length, 0, 'turn/started must not emit any NormalizedEvent');
  });

  // ── Error notifications ─────────────────────────────────────────────────────

  test('error notification is held until the turn outcome is known', () => {
    const { emitted, feed } = makeTranslator();

    feed('error', {
      error: { message: 'process exited unexpectedly', additionalDetails: null },
      willRetry: false,
    });

    assert.equal(emitted.length, 0);
  });

  test('failed turn emits runtime_error with the nested Codex message', () => {
    const { emitted, feed } = makeTranslator();

    feed('error', {
      error: { message: 'Unable to decode local image', additionalDetails: 'invalid PNG data' },
      willRetry: false,
    });
    feed('turn/completed', {
      turn: {
        status: 'failed',
        error: { message: 'Unable to decode local image', additionalDetails: 'invalid PNG data' },
      },
    });

    assert.equal(emitted.length, 2);
    const ev = emitted[1] as unknown as AnyEv;
    assert.equal(ev['kind'], 'runtime_error');
    assert.equal(ev['error'], 'Unable to decode local image: invalid PNG data');
  });

  test('unknown method emits nothing (forward-compat)', () => {
    const { emitted, feed } = makeTranslator();

    feed('some/future/notification', { data: 42 });
    feed('turn/plan/updated', { plan: [] });
    feed('item/plan/delta', { delta: 'x' });

    assert.equal(emitted.length, 0, 'unrecognised methods must be silently ignored');
  });

  // ── MCP startup failure ─────────────────────────────────────────────────────

  test('mcpServer/startupStatus/updated with status failed emits mcp_server_error', () => {
    const { emitted, feed } = makeTranslator();

    feed('mcpServer/startupStatus/updated', {
      status: 'failed',
      name: 'my-mcp-server',
      error: 'connection refused',
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'mcp_server_error');
    assert.equal(ev['serverName'], 'my-mcp-server');
    assert.equal(ev['error'], 'connection refused');
  });

  test('mcpServer/startupStatus/updated with status started emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('mcpServer/startupStatus/updated', {
      status: 'started',
      name: 'my-mcp-server',
    });

    assert.equal(emitted.length, 0, 'successful MCP startup must not emit mcp_server_error');
  });

  // ── Robustness: missing/undefined fields ────────────────────────────────────

  test('item/started with missing item fields does not throw', () => {
    const { emitted, feed } = makeTranslator();

    // item with no id, no type — should not throw
    assert.doesNotThrow(() => {
      feed('item/started', { item: {} });
    });
    // type is '' — not in TOOL_ITEM_TYPES → no emit
    assert.equal(emitted.length, 0);
  });

  test('item/completed with missing item id emits tool_call_update with empty toolCallId', () => {
    const { emitted, feed } = makeTranslator();

    assert.doesNotThrow(() => {
      feed('item/completed', { item: { type: 'commandExecution' } });
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal(ev['kind'], 'tool_call_update');
    assert.equal(ev['toolCallId'], '');
  });

  test('malformed error notification falls back safely when the turn fails', () => {
    const { emitted, feed } = makeTranslator();

    assert.doesNotThrow(() => {
      feed('error', { message: 42 as unknown as string });
    });
    feed('turn/completed', { turn: { status: 'failed' } });

    assert.equal(emitted.length, 2);
    const ev = emitted[1] as unknown as AnyEv;
    assert.equal(ev['kind'], 'runtime_error');
    assert.equal(ev['error'], 'Codex runtime error');
  });

  // ── Detail cap at 200 graphemes ─────────────────────────────────────────────

  test('output delta longer than 200 chars is capped to 200 graphemes', () => {
    const { emitted, feed } = makeTranslator();

    const longDelta = 'x'.repeat(500);
    feed('item/commandExecution/outputDelta', { itemId: 'x', delta: longDelta });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.equal((ev['detail'] as string).length, 200, 'detail must be capped at 200 chars');
  });

  test('mcpToolCall item detail from args is capped to 200 graphemes', () => {
    const { emitted, feed } = makeTranslator();

    const largeArgs = { data: 'y'.repeat(500) };
    feed('item/started', {
      item: { id: 'x', type: 'mcpToolCall', tool: 'large_tool', arguments: largeArgs },
    });

    assert.equal(emitted.length, 1);
    const ev = emitted[0] as unknown as AnyEv;
    assert.ok(
      (ev['detail'] as string).length <= 200,
      `detail length ${(ev['detail'] as string).length} exceeds 200`,
    );
  });
});
