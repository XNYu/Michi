import { describe, expect, it } from 'vitest';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { assistantPersistenceContent } from './assistantBlocks';
import { reduceNodes } from './chatReducers';
import type { ChatAction, ChatNodeState } from './chatTypes';

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

describe('frontend canonical turn projection parity', () => {
  it('matches the shared projector for durable assistant events', () => {
    const assistantId = 'a-node-1-turn-1';
    let nodes: Record<string, ChatNodeState> = {
      'node-1': {
        nodeId: 'node-1', kind: 'chat', chatId: 'chat-1', projectId: 'ws-1',
        messages: [
          { id: `u-${assistantId}`, role: 'user', text: 'hello', toolCalls: [], createdAt: 100 },
          { id: assistantId, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: 100 },
        ],
        followUps: [], status: 'streaming',
      },
    };
    let durable = createDurableTurn({
      turnId: 'turn-1', assistantId, nodeId: 'node-1', workspaceId: 'ws-1',
      displayUserText: 'hello', startedAt: 100,
    });

    const trace: Array<{ stream: ChatStreamEvent; action: ChatAction }> = [
      { stream: event('thought', { text: 'thinking' }), action: { type: 'thought', nodeId: 'node-1', assistantId, text: 'thinking' } },
      { stream: event('tool_call', { toolCallId: 'tool-1', title: 'Read', status: 'running' }), action: { type: 'tool-call', nodeId: 'node-1', assistantId, tool: { id: 'tool-1', title: 'Read', status: 'running' } } },
      { stream: event('chunk', { text: 'answer ' }), action: { type: 'chunk', nodeId: 'node-1', assistantId, text: 'answer ' } },
      { stream: event('image', { path: '.attachments/a.png', caption: 'A', mimeType: 'image/png', size: 42 }), action: { type: 'image-block', nodeId: 'node-1', assistantId, path: '.attachments/a.png', caption: 'A', mimeType: 'image/png', size: 42 } },
      { stream: event('plan', { entries: [{ content: 'ship', priority: 'high', status: 'completed' }] }), action: { type: 'plan', nodeId: 'node-1', assistantId, entries: [{ content: 'ship', priority: 'high', status: 'completed' }] } },
      { stream: event('tool_call_update', { toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok' }), action: { type: 'tool-call-update', nodeId: 'node-1', assistantId, tool: { id: 'tool-1', title: '', status: 'completed', output: 'ok' } } },
      { stream: event('title', { title: 'Canonical title' }), action: { type: 'set-title', nodeId: 'node-1', title: 'Canonical title' } },
      { stream: event('follow_ups', { followUps: ['Next?'] }), action: { type: 'set-follow-ups', nodeId: 'node-1', followUps: ['Next?'] } },
      { stream: event('branch_overview', { overview: 'Overview.' }), action: { type: 'set-branch-overview', nodeId: 'node-1', overview: 'Overview.', assistantId } },
      { stream: event('chunk', { text: 'done' }), action: { type: 'chunk', nodeId: 'node-1', assistantId, text: 'done' } },
      { stream: event('done', { stopReason: 'end_turn', persisted: true }), action: { type: 'done', nodeId: 'node-1', assistantId } },
    ];

    for (const item of trace) {
      durable = applyTurnEvent(durable, item.stream);
      nodes = reduceNodes(nodes, item.action);
    }

    const message = nodes['node-1'].messages.find((candidate) => candidate.id === assistantId)!;
    expect(message.blocks).toEqual(durable.assistantMessage.blocks);
    expect(message.toolCalls).toEqual(durable.assistantMessage.toolCalls);
    expect(message.plan).toEqual(durable.assistantMessage.plan);
    expect(assistantPersistenceContent(message)).toBe(durable.assistantMessage.content);
    expect(message.streaming).toBe(false);
    expect(nodes['node-1'].title).toBe(durable.nodeMetadata.title);
    expect(nodes['node-1'].followUps).toEqual(durable.nodeMetadata.followUps);
    expect(nodes['node-1'].branchOverview).toBe(durable.nodeMetadata.branchOverview);
  });

  it('represents self-initiated turns as standalone durable assistant messages', () => {
    const existing: ChatNodeState = {
      nodeId: 'node-1', kind: 'chat', chatId: 'chat-1', projectId: 'ws-1',
      messages: [{ id: 'a-old', role: 'assistant', text: 'old', toolCalls: [], createdAt: 1 }],
      followUps: [], status: 'idle',
    };
    const result = reduceNodes({ 'node-1': existing }, {
      type: 'observer-turn-start', nodeId: 'node-1', turnId: 'self-turn',
      assistantId: 'self-node-1-self-turn', userText: '', selfInitiated: true,
    });
    expect(result['node-1'].messages.map((message) => message.id)).toEqual([
      'a-old', 'self-node-1-self-turn',
    ]);
    expect(result['node-1'].messages.filter((message) => message.role === 'user')).toHaveLength(0);
  });
});
