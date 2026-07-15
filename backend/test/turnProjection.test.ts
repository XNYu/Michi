import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyTurnEvent,
  createDurableTurn,
  type ChatStreamEvent,
} from 'michi-shared';

function event(
  name: ChatStreamEvent['event'],
  data: Record<string, unknown>,
): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

describe('durable turn projector', () => {
  test('projects an interleaved tool-heavy turn into canonical durable messages', () => {
    let turn = createDurableTurn({
      turnId: 'turn-1',
      assistantId: 'a-node-1-turn-1',
      nodeId: 'node-1',
      workspaceId: 'ws-1',
      displayUserText: 'hello',
      startedAt: 100,
    });

    const trace: ChatStreamEvent[] = [
      event('thought', { text: 'thinking', seq: 1 }),
      event('tool_call', { toolCallId: 'tool-1', title: 'Read', status: 'running', seq: 2 }),
      event('tool_call_update', { toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok', seq: 3 }),
      event('chunk', { text: 'answer ', seq: 4 }),
      event('image', { path: '.attachments/a.png', caption: 'A', mimeType: 'image/png', size: 42, seq: 5 }),
      event('plan', { entries: [{ content: 'ship', priority: 'high', status: 'completed' }], seq: 6 }),
      event('title', { title: 'Canonical title', seq: 7 }),
      event('follow_ups', { followUps: ['Next?'], seq: 8 }),
      event('branch_overview', { overview: 'Investigated persistence.', seq: 9 }),
      event('chunk', { text: 'done', seq: 10 }),
      event('done', { stopReason: 'end_turn', persisted: true, seq: 11 }),
    ];
    for (const item of trace) turn = applyTurnEvent(turn, item);

    assert.equal(turn.status, 'completed');
    assert.equal(turn.lastAppliedSeq, 11);
    assert.equal(turn.userMessage?.id, 'u-a-node-1-turn-1');
    assert.equal(turn.assistantMessage.id, 'a-node-1-turn-1');
    assert.equal(turn.assistantMessage.content, 'answer done');
    assert.deepEqual(turn.assistantMessage.toolCalls, [{
      id: 'tool-1',
      title: 'Read',
      status: 'completed',
      textOffset: 8,
      output: 'ok',
    }]);
    assert.deepEqual(turn.assistantMessage.blocks.map((block) => block.kind), [
      'thinking', 'tool', 'answer', 'image', 'answer',
    ]);
    assert.deepEqual(turn.assistantMessage.plan, [
      { content: 'ship', priority: 'high', status: 'completed' },
    ]);
    assert.equal(turn.nodeMetadata.title, 'Canonical title');
    assert.deepEqual(turn.nodeMetadata.followUps, ['Next?']);
    assert.equal(turn.nodeMetadata.branchOverview, 'Investigated persistence.');
  });

  test('is idempotent for replayed or out-of-order sequence numbers', () => {
    const initial = createDurableTurn({
      turnId: 'turn-2',
      assistantId: 'a-2',
      nodeId: 'node-2',
      workspaceId: 'ws-1',
      displayUserText: 'hello',
      startedAt: 100,
    });
    const once = applyTurnEvent(initial, event('chunk', { text: 'one', seq: 4 }));
    const replayed = applyTurnEvent(once, event('chunk', { text: 'duplicate', seq: 4 }));
    const older = applyTurnEvent(replayed, event('chunk', { text: 'older', seq: 3 }));

    assert.equal(replayed, once);
    assert.equal(older, once);
    assert.equal(older.assistantMessage.content, 'one');
  });

  test('creates a tool block when an update arrives before the initial call', () => {
    const initial = createDurableTurn({
      turnId: 'turn-3',
      assistantId: 'a-3',
      nodeId: 'node-3',
      workspaceId: 'ws-1',
      displayUserText: '',
      selfInitiated: true,
      startedAt: 100,
    });
    const updated = applyTurnEvent(initial, event('tool_call_update', {
      toolCallId: 'tool-late',
      title: 'Bash',
      status: 'failed',
      output: 'nope',
      seq: 1,
    }));

    assert.equal(updated.userMessage, null);
    assert.equal(updated.assistantMessage.toolCalls.length, 1);
    assert.equal(updated.assistantMessage.blocks[0]?.kind, 'tool');
  });

  test('retains partial content for cancellation and errors', () => {
    const initial = createDurableTurn({
      turnId: 'turn-4',
      assistantId: 'a-4',
      nodeId: 'node-4',
      workspaceId: 'ws-1',
      displayUserText: 'cancel me',
      startedAt: 100,
    });
    const partial = applyTurnEvent(initial, event('chunk', { text: 'partial', seq: 1 }));
    const cancelled = applyTurnEvent(partial, event('done', { stopReason: 'cancelled', persisted: true, seq: 2 }));
    const failed = applyTurnEvent(partial, event('error', { message: 'runtime failed', seq: 2 }));

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.assistantMessage.content, 'partial');
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'runtime failed');
    assert.equal(failed.assistantMessage.content, 'partial');
  });

  test('lifts inline metadata sentinels into durable node metadata at turn end', () => {
    let turn = createDurableTurn({
      turnId: 'turn-sentinels',
      assistantId: 'a-sentinels',
      nodeId: 'node-sentinels',
      workspaceId: 'ws-1',
      displayUserText: 'hello',
      startedAt: 100,
    });
    turn = applyTurnEvent(turn, event('chunk', {
      text: [
        '[TITLE: Sentinel title]',
        'Visible answer.',
        '[BRANCH-OVERVIEW: Sentinel overview.]',
        '[FOLLOW-UP 1/3: What next?]',
        '[FOLLOW-UP 2/3: Why now?]',
      ].join('\n'),
      seq: 1,
    }));
    turn = applyTurnEvent(turn, event('done', {
      stopReason: 'end_turn', persisted: true, seq: 2,
    }));

    assert.equal(turn.assistantMessage.content, 'Visible answer.');
    assert.equal(turn.nodeMetadata.title, 'Sentinel title');
    assert.equal(turn.nodeMetadata.branchOverview, 'Sentinel overview.');
    assert.deepEqual(turn.nodeMetadata.followUps, ['What next?', 'Why now?']);
  });
});
