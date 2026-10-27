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

  test('replaces input snapshots once and preserves them across output updates and replay', () => {
    let snapshot = createDurableTurn({
      turnId: 'input-turn', assistantId: 'input-assistant', nodeId: 'input-node',
      workspaceId: 'ws-1', displayUserText: 'write it', startedAt: 100,
    });
    snapshot = applyTurnEvent(snapshot, event('tool_call', {
      toolCallId: 'write-1', title: 'Write', status: 'in_progress', inputJson: '{}', seq: 1,
    }));
    const inputJson = JSON.stringify({ file_path: '/tmp/app.ts', content: 'finished input' });
    const backfill = event('tool_call_update', {
      toolCallId: 'write-1', title: 'Write', status: 'in_progress', inputJson, seq: 2,
    });
    snapshot = applyTurnEvent(snapshot, backfill);
    assert.equal(snapshot.assistantMessage.toolCalls[0].inputJson, inputJson, 'snapshots replace instead of append');
    snapshot = applyTurnEvent(snapshot, event('tool_call_update', {
      toolCallId: 'write-1', title: '', status: 'completed', output: 'saved', seq: 3,
    }));
    const afterOutput = snapshot;
    snapshot = applyTurnEvent(snapshot, backfill);
    assert.equal(snapshot, afterOutput, 'replayed backfill must not regress completed state');
    assert.equal(snapshot.assistantMessage.toolCalls[0].inputJson, inputJson);
    assert.equal(snapshot.assistantMessage.toolCalls[0].output, 'saved');
    assert.equal(snapshot.assistantMessage.toolCalls[0].status, 'completed');
    assert.equal(snapshot.assistantMessage.blocks.filter((block) => block.kind === 'tool').length, 1);
  });
});


test('replay is deterministic across clocks; unstamped legacy tools have no invented duration', () => {
  const initial = createDurableTurn({ turnId: 'times', assistantId: 'a-times', nodeId: 'node-times', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const frames = [event('tool_call', { toolCallId: 't', title: 'Read', status: 'running', observedAt: 100, seq: 1 }),
    event('tool_call_update', { toolCallId: 't', title: '', status: 'completed', observedAt: 800, seq: 2 }),
    event('done', { stopReason: 'end_turn', completedAt: 900, observedAt: 905, seq: 3 })];
  const first = frames.reduce(applyTurnEvent, initial);
  const realNow = Date.now;
  try {
    Date.now = () => 9_000_000;
    assert.deepEqual(frames.reduce(applyTurnEvent, initial), first);
  } finally { Date.now = realNow; }
  assert.equal(first.assistantMessage.toolCalls[0].endedAt! - first.assistantMessage.toolCalls[0].startedAt!, 700);
  const legacy = [event('tool_call', { toolCallId: 'old', title: 'Read', status: 'running' }), event('done', { stopReason: 'end_turn' })].reduce(applyTurnEvent, initial);
  assert.equal(legacy.assistantMessage.toolCalls[0].startedAt, undefined);
  assert.equal(legacy.assistantMessage.toolCalls[0].endedAt, undefined);
});

test('text blocks carry backend-observed start/end times that replay deterministically', () => {
  const initial = createDurableTurn({ turnId: 'text-times', assistantId: 'a-text', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const frames = [
    event('thought', { text: 'plan ', observedAt: 100, seq: 1 }),
    event('thought', { text: 'more', observedAt: 150, seq: 2 }),
    event('tool_call', { toolCallId: 't', title: 'Bash', status: 'running', observedAt: 200, seq: 3 }),
    event('tool_call_update', { toolCallId: 't', title: '', status: 'completed', observedAt: 300, seq: 4 }),
    event('chunk', { text: 'Answer', observedAt: 400, seq: 5 }),
    event('chunk', { text: ' text', observedAt: 450, seq: 6 }),
    event('done', { stopReason: 'end_turn', completedAt: 900, observedAt: 905, seq: 7 }),
  ];
  const first = frames.reduce(applyTurnEvent, initial);
  const realNow = Date.now;
  try {
    Date.now = () => 9_000_000;
    assert.deepEqual(frames.reduce(applyTurnEvent, initial), first);
  } finally { Date.now = realNow; }
  const [thinking, tool, answer] = first.assistantMessage.blocks;
  // A block starts on its first frame (later fragments do not move it) and ends
  // when the next block opens; the trailing block ends with the turn.
  assert.deepEqual(thinking, { id: 'a-text-b-0', kind: 'thinking', rawText: 'plan more', streaming: false, startedAt: 100, endedAt: 200 });
  assert.equal(tool.kind, 'tool');
  assert.deepEqual(answer, { id: 'a-text-b-2', kind: 'answer', rawText: 'Answer text', streaming: false, startedAt: 400, endedAt: 900 });
});

test('unstamped legacy text frames get no invented start/end times', () => {
  const initial = createDurableTurn({ turnId: 'legacy-text', assistantId: 'a-legacy', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  const snapshot = [
    event('thought', { text: 'old thought' }),
    event('chunk', { text: 'old answer' }),
    event('done', { stopReason: 'end_turn' }),
  ].reduce(applyTurnEvent, initial);
  for (const block of snapshot.assistantMessage.blocks) {
    assert.equal('startedAt' in block, false);
    assert.equal('endedAt' in block, false);
  }
});

test('terminal interruption preserves the unanswered question without persisting an actionable approval', () => {
  let snapshot = createDurableTurn({ turnId: 'question', assistantId: 'a-question', nodeId: 'n', workspaceId: 'ws', displayUserText: '', startedAt: 1 });
  snapshot = applyTurnEvent(snapshot, event('user_input_request', { requestId: 1, questions: [{ question: 'Continue?', options: [], multiSelect: false }], seq: 1 }));
  snapshot = applyTurnEvent(snapshot, event('done', { stopReason: 'cancel', completedAt: 20, seq: 2 }));
  const block = snapshot.assistantMessage.blocks[0];
  assert.equal(block.kind, 'user-input');
  if (block.kind === 'user-input') {
    assert.equal(block.interaction?.status, 'interrupted');
    assert.equal(block.interaction?.questions[0].id, 'question:input:1:q:0');
  }
});
