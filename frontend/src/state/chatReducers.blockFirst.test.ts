import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
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
      { id: 'a1-b-0', kind: 'answer', rawText: 'answer', streaming: true },
      { id: 'a1-b-1', kind: 'thinking', rawText: 'think', streaming: true },
      { id: 'a1-b-2', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 5 },
      { id: 'a1-b-3', kind: 'answer', rawText: 'tail', streaming: true },
    ]);
  });

  it('adds a visible tool block when an update arrives before the initial tool call', () => {
    const state = reduceNodes(node(), {
      type: 'tool-call-update',
      nodeId: 'n1',
      assistantId: 'a1',
      tool: { id: 't1', title: 'late', status: 'running' },
    });

    expect(state.n1.messages[0].toolCalls).toHaveLength(1);
    expect(state.n1.messages[0].blocks).toEqual([
      { id: 'a1-b-0', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 0 },
    ]);
  });

  it('finalizes text blocks on done and error', () => {
    let state = reduceNodes(node(), { type: 'chunk', nodeId: 'n1', assistantId: 'a1', text: 'answer' });
    state = reduceNodes(state, { type: 'done', nodeId: 'n1', assistantId: 'a1' });
    expect(state.n1.messages[0].streaming).toBe(false);
    expect(state.n1.messages[0].blocks?.[0]).toMatchObject({ streaming: false });

    state = reduceNodes(node(), { type: 'thought', nodeId: 'n1', assistantId: 'a1', text: 'thinking' });
    state = reduceNodes(state, { type: 'error', nodeId: 'n1', assistantId: 'a1', message: 'boom' });
    expect(state.n1.messages[0].streaming).toBe(false);
    expect(state.n1.messages[0].blocks?.[0]).toMatchObject({ streaming: false });
  });
});
