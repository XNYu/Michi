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

describe('observer-turn-start', () => {
  it('synthesizes user and assistant messages keyed by the server assistantId', () => {
    const next = reduceNodes(
      { n1: baseNode() },
      {
        type: 'observer-turn-start',
        nodeId: 'n1',
        turnId: 'T1',
        assistantId: 'a-n1-T1',
        userText: 'hello from owner',
      },
    );

    expect(next.n1.status).toBe('streaming');
    expect(next.n1.messages).toHaveLength(2);
    expect(next.n1.messages[0]).toMatchObject({
      id: 'u-a-n1-T1',
      role: 'user',
      text: 'hello from owner',
    });
    expect(next.n1.messages[1]).toMatchObject({
      id: 'a-n1-T1',
      role: 'assistant',
      streaming: true,
    });
  });

  it('is idempotent for repeated turn_start replay', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };
    const action = {
      type: 'observer-turn-start' as const,
      nodeId: 'n1',
      turnId: 'T1',
      assistantId: 'a-n1-T1',
      userText: 'x',
    };

    nodes = reduceNodes(nodes, action);
    nodes = reduceNodes(nodes, action);

    expect(nodes.n1.messages.filter((m) => m.id === 'a-n1-T1')).toHaveLength(1);
  });

  it('routes chunks to the synthesized assistant block', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };
    nodes = reduceNodes(nodes, {
      type: 'observer-turn-start',
      nodeId: 'n1',
      turnId: 'T1',
      assistantId: 'a-n1-T1',
      userText: 'x',
    });
    nodes = reduceNodes(nodes, {
      type: 'chunk',
      nodeId: 'n1',
      assistantId: 'a-n1-T1',
      text: 'partial',
    });

    const assistant = nodes.n1.messages.find((m) => m.id === 'a-n1-T1')!;
    expect(visibleMessageText(assistant)).toContain('partial');
  });
});

describe('broadcast seq watermark', () => {
  it('advances within a turn and never moves backward', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };

    nodes = reduceNodes(nodes, { type: 'apply-seq', nodeId: 'n1', turnId: 'T1', seq: 3 });
    expect(nodes.n1.lastAppliedTurnId).toBe('T1');
    expect(nodes.n1.lastAppliedSeq).toBe(3);

    nodes = reduceNodes(nodes, { type: 'apply-seq', nodeId: 'n1', turnId: 'T1', seq: 1 });
    expect(nodes.n1.lastAppliedSeq).toBe(3);

    nodes = reduceNodes(nodes, { type: 'apply-seq', nodeId: 'n1', turnId: 'T2', seq: 0 });
    expect(nodes.n1.lastAppliedTurnId).toBe('T2');
    expect(nodes.n1.lastAppliedSeq).toBe(0);
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
  it('renames the optimistic user and assistant ids to the server ids', () => {
    let nodes: Record<string, ChatNodeState> = { n1: baseNode() };
    nodes = reduceNodes(nodes, {
      type: 'user-send',
      nodeId: 'n1',
      userText: 'hi',
      assistantId: 'a-local',
    });

    nodes = reduceNodes(nodes, {
      type: 'realign-assistant-id',
      nodeId: 'n1',
      fromId: 'a-local',
      toId: 'a-server',
    });

    expect(nodes.n1.messages.map((m) => m.id)).toEqual(['u-a-server', 'a-server']);
  });

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
