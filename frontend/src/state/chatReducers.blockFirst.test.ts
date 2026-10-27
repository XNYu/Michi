import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import { mapMessageRow } from './chatHydration';
import type { ChatNodeState } from './chatTypes';

function node(): Record<string, ChatNodeState> {
  return {
    n1: {
      nodeId: 'n1',
      kind: 'chat',
      chatId: 'c1',
      projectId: 'p1',
      messages: [
        { id: 'a1', role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true },
      ],
      followUps: [],
      status: 'streaming',
    },
  };
}

describe('block-first assistant reducer', () => {
  it('uses immediate-tail append and section-local tool offsets', () => {
    let state = node();
    state = reduceNodes(state, { type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: 'answer' });
    state = reduceNodes(state, { type: 'thought', nodeId: 'n1', assistantId: 'a1', text: 'think' });
    state = reduceNodes(state, {
      type: 'tool-call',
      nodeId: 'n1',
      assistantId: 'a1',
      tool: { id: 't1', title: 'tool', status: 'running' },
    });
    state = reduceNodes(state, { type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: 'tail' });

    expect(state.n1.messages[0].blocks).toEqual([
      { id: 'a1-b-0', kind: 'answer', rawText: 'answer', streaming: false },
      { id: 'a1-b-1', kind: 'thinking', rawText: 'think', streaming: false },
      { id: 'a1-b-2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 5 },
      { id: 'a1-b-3', kind: 'answer', rawText: 'tail', streaming: true },
    ]);
  });
});


it('retains earlier answered and skipped cards after another question and hydration', () => {
  let state = node();
  const questions = [{ id: 'question-1', question: 'Choose a color?', options: [{ label: 'Blue' }], multiSelect: false }];
  state = reduceNodes(state, { type: 'user-input-request', nodeId: 'n1', userInput: { requestId: 1, interactionId: 'turn:input:1', questions, answers: [] } });
  state = reduceNodes(state, { type: 'user-input-resolved', nodeId: 'n1', requestId: 1, interactionId: 'turn:input:1', answers: [{ id: 'question-1', question: 'Choose a color?', answer: 'Blue' }] });
  state = reduceNodes(state, { type: 'user-input-request', nodeId: 'n1', userInput: { requestId: 2, interactionId: 'turn:input:2', questions: [{ ...questions[0], id: 'question-2', question: 'Continue?' }], answers: [] } });
  state = reduceNodes(state, { type: 'user-input-resolved', nodeId: 'n1', requestId: 1, interactionId: 'turn:input:1', answers: [] });
  expect(state.n1.pendingUserInput?.requestId).toBe(2);
  expect(state.n1.pendingUserInput?.resolved).not.toBe(true);
  state = reduceNodes(state, { type: 'user-input-resolved', nodeId: 'n1', requestId: 2, interactionId: 'turn:input:2', answers: [], outcome: 'skipped' });
  state = reduceNodes(state, { type: 'done', nodeId: 'n1', assistantId: 'a1', completedAt: 10 });
  const message = state.n1.messages[0];
  const hydrated = mapMessageRow({ id: message.id, node_id: 'n1', role: 'assistant', content: '', seq: 1, created_at: 1,
    blocks: JSON.stringify(message.blocks), tool_calls: '[]' });
  const interactions = hydrated.blocks!.flatMap(block => block.kind === 'user-input' ? [block.interaction!] : []);
  expect(interactions.map(interaction => interaction.status)).toEqual(['answered', 'skipped']);
  expect(interactions[0].answers[0]).toMatchObject({ id: 'question-1', answer: 'Blue' });
  expect(interactions[1].questions[0].question).toBe('Continue?');
});
