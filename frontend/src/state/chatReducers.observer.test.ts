import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import { visibleMessageText } from './assistantBlocks';
import type { ChatNodeState } from './chatTypes';

function baseNode(nodeId = 'n1'): ChatNodeState {
  return {
    nodeId,
    kind: 'chat',
    chatId: 'chat1',
    projectId: 'ws1',
    messages: [],
    followUps: [],
    status: 'idle',
  };
}

describe('broadcast seq watermark', () => {
  it('advances the background watermark without clobbering foreground replay state', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };
    nodes.n1.lastAppliedTurnId = 'foreground-turn';
    nodes.n1.lastAppliedSeq = 9;

    nodes = reduceNodes(nodes, { type: 'apply-background-seq', nodeId: 'n1', turnId: 'T1', seq: 3 });
    expect(nodes.n1.lastAppliedBackgroundTurnId).toBe('T1');
    expect(nodes.n1.lastAppliedBackgroundSeq).toBe(3);
    expect(nodes.n1.lastAppliedTurnId).toBe('foreground-turn');
    expect(nodes.n1.lastAppliedSeq).toBe(9);

    nodes = reduceNodes(nodes, { type: 'apply-background-seq', nodeId: 'n1', turnId: 'T1', seq: 1 });
    expect(nodes.n1.lastAppliedBackgroundSeq).toBe(3);

    nodes = reduceNodes(nodes, { type: 'apply-background-seq', nodeId: 'n1', turnId: 'T2', seq: 0 });
    expect(nodes.n1.lastAppliedBackgroundTurnId).toBe('T2');
    expect(nodes.n1.lastAppliedBackgroundSeq).toBe(0);
  });
});

describe('block-reset', () => {
  it('clears assistant content and broadcast watermarks', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };
    nodes = reduceNodes(nodes, {
      type: 'observer-turn-start',
      nodeId: 'n1',
      turnId: 'T1',
      assistantId: 'a-n1-T1',
      userText: 'x',
    });
    nodes = reduceNodes(nodes, { type: 'chunk', nodeId: 'n1', assistantId: 'a-n1-T1', text: 'stale' });
    nodes = reduceNodes(nodes, { type: 'block-reset', nodeId: 'n1', assistantId: 'a-n1-T1' });

    const assistant = nodes.n1.messages.find((m) => m.id === 'a-n1-T1')!;
    expect(visibleMessageText(assistant)).toBe('');
    expect(nodes.n1.lastAppliedTurnId).toBeUndefined();
    expect(nodes.n1.lastAppliedSeq).toBeUndefined();
  });
});

describe('realign-assistant-id', () => {
  it('does not clobber an existing server assistant block', () => {
    const node = baseNode();
    node.messages = [
      { id: 'u-a-local', role: 'user', text: 'hi', toolCalls: [] },
      { id: 'a-local', role: 'assistant', text: '', toolCalls: [], blocks: [] },
      { id: 'a-server', role: 'assistant', text: 'existing', toolCalls: [], blocks: [] },
    ];

    const next = reduceNodes(
      { n1: node },
      { type: 'realign-assistant-id', nodeId: 'n1', fromId: 'a-local', toId: 'a-server' },
    );

    expect(next).toEqual({ n1: node });
  });
});
