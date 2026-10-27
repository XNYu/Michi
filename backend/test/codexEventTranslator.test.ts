/**
 * Tests for codexEventTranslator.ts
 *
 * Uses fixture-style: feed concrete wire notification sequences and assert
 * emitted NormalizedEvents. Uses node:test (NOT vitest).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexTranslator } from 'michi-runtime/internal/adapters/codex/codexEventTranslator';
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
  // ── Text deltas: agent messages and paragraph breaks ────────────────────

  test('deltas of one agent message stream as they come, with nothing added', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
    feed('item/agentMessage/delta', { itemId: 'msg-1', delta: ' world.' });

    assert.deepEqual(emitted, [
      { kind: 'chunk', text: 'Hello' },
      { kind: 'chunk', text: ' world.' },
    ]);
  });

  test('a second agent message in the turn starts a new paragraph', () => {
    const { emitted, feed } = makeTranslator();

    // Codex sends a commentary message, then the answer, as separate items.
    feed('item/agentMessage/delta', { itemId: 'msg-1', delta: 'I’ll check whether a shell tool is available.' });
    feed('item/agentMessage/delta', { itemId: 'msg-2', delta: 'I can’t run' });
    feed('item/agentMessage/delta', { itemId: 'msg-2', delta: ' `ls ~`.' });

    const text = emitted.map((ev) => (ev.kind === 'chunk' ? ev.text : '')).join('');
    assert.equal(text, 'I’ll check whether a shell tool is available.\n\nI can’t run `ls ~`.');
  });

  test('a tool call between agent messages still separates their text', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/agentMessage/delta', { itemId: 'msg-1', delta: 'I’ll look it up.' });
    feed('item/started', { item: { id: 'tool-1', type: 'mcpToolCall', server: 'michi', tool: 'read_node' } });
    feed('item/completed', { item: { id: 'tool-1', type: 'mcpToolCall', server: 'michi', tool: 'read_node', status: 'completed' } });
    feed('item/agentMessage/delta', { itemId: 'msg-2', delta: '- Project: michi-app' });

    const text = emitted.map((ev) => (ev.kind === 'chunk' ? ev.text : '')).join('');
    assert.equal(text, 'I’ll look it up.\n\n- Project: michi-app');
  });

  test('a new turn does not start with a paragraph break', () => {
    const { emitted, feed, startTurn } = makeTranslator();

    feed('item/agentMessage/delta', { itemId: 'msg-1', delta: 'First turn.' });
    startTurn();
    emitted.length = 0;
    feed('item/agentMessage/delta', { itemId: 'msg-2', delta: 'Second turn.' });

    assert.deepEqual(emitted, [{ kind: 'chunk', text: 'Second turn.' }]);
  });

  test('separates summary parts when a new reasoning item resets summaryIndex', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/reasoning/summaryPartAdded', {
      itemId: 'reasoning-1',
      summaryIndex: 0,
    });
    feed('item/reasoning/summaryTextDelta', {
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: 'Filtering tools by specific criteria',
    });
    feed('item/reasoning/summaryPartAdded', {
      itemId: 'reasoning-2',
      summaryIndex: 0,
    });
    feed('item/reasoning/summaryTextDelta', {
      itemId: 'reasoning-2',
      summaryIndex: 0,
      delta: 'Testing page access with curl',
    });

    assert.deepEqual(emitted, [
      { kind: 'thought', text: 'Filtering tools by specific criteria' },
      { kind: 'thought', text: '\n' },
      { kind: 'thought', text: 'Testing page access with curl' },
    ]);
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

  test('item/completed for agentMessage (streamed) emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('item/completed', {
      item: { id: 'item-007', type: 'agentMessage', text: 'done' },
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

  test('thread/tokenUsage/updated clamps active usage to 100 percent', () => {
    const { emitted, feed } = makeTranslator();

    feed('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { totalTokens: 450_000 },
        last: { totalTokens: 250_000 },
        modelContextWindow: 200_000,
      },
    });

    assert.deepEqual(emitted, [{ kind: 'context_usage', contextUsagePercentage: 100 }]);
  });

  test('thread/tokenUsage/updated without modelContextWindow emits nothing', () => {
    const { emitted, feed } = makeTranslator();

    feed('thread/tokenUsage/updated', {
      total: { totalTokens: 10_000 },
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

    assert.equal(emitted.length, 3);
    const ev = emitted[1] as unknown as AnyEv;
    assert.equal(ev['kind'], 'runtime_error');
    assert.equal(ev['error'], 'Unable to decode local image: invalid PNG data');
    assert.deepEqual(emitted[2], { kind: 'turn_end', stopReason: 'error' });
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

    assert.equal(emitted.length, 3);
    const ev = emitted[1] as unknown as AnyEv;
    assert.equal(ev['kind'], 'runtime_error');
    assert.equal(ev['error'], 'Codex runtime error');
  });

  test('compaction item and interrupted status stay honest', () => {
    const { emitted, feed, startTurn } = makeTranslator();
    feed('item/started', { item: { id: 'c1', type: 'compaction' } });
    assert.equal(emitted[0]?.kind, 'compaction_start');
    feed('item/completed', { item: { id: 'c1', type: 'compaction' } });
    assert.equal(emitted[1]?.kind, 'compaction_end');
    startTurn();
    feed('turn/completed', { turn: { status: 'interrupted' } });
    const turnEnd = emitted.find((e) => e.kind === 'turn_end');
    assert.equal(turnEnd && 'stopReason' in turnEnd ? turnEnd.stopReason : '', 'cancelled');
  });
});
