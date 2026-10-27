import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTurnEvent, checkpointTurnContent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { assistantAnswerRawText, assistantAnswerVisibleText, assistantPersistenceContent } from './assistantBlocks';
import { reduceNodes } from './chatReducers';
import { projectAnswerRun } from './streamingProjection';
import type { ChatAction, ChatNodeState } from './chatTypes';

function event(name: ChatStreamEvent['event'], data: Record<string, unknown>): ChatStreamEvent {
  return { event: name, data } as ChatStreamEvent;
}

afterEach(() => vi.useRealTimers());

describe('frontend canonical turn projection parity', () => {
  it('hides a real Codex TITLE trace while retaining raw blocks and the exact persisted answer', () => {
    const marker = 'METADATA_241465eefa4f4ed2b64ea1853e7fe395';
    const title = '[TITLE: Exact Response Metadata Acceptance Check]';
    const assistantId = 'a-codex-metadata';
    let nodes: Record<string, ChatNodeState> = {
      'node-1': {
        nodeId: 'node-1', kind: 'chat', chatId: 'chat-1', projectId: 'ws-1',
        messages: [{ id: assistantId, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true }],
        followUps: [], status: 'streaming',
      },
    };
    let durable = createDurableTurn({
      turnId: 'turn-1', assistantId, nodeId: 'node-1', workspaceId: 'ws-1',
      displayUserText: `Reply exactly ${marker}.`, startedAt: 100,
    });
    // Observed app-server/SSE boundaries: raw chunks carry metadata; both the
    // renderer and persistence project it out, including the partial "[T".
    const chunks = ['[T', 'ITLE', ':', ' Exact', ' Response', ' Metadata', ' Acceptance', ' Check', ']\n',
      'MET', 'ADATA', '_', '241', '465', 'e', 'efa', '4', 'f', '4', 'ed', '2', 'b', '64', 'ea', '185', '3', 'e', '7', 'fe', '395'];
    let previousVisible = '';
    for (const [index, text] of chunks.entries()) {
      durable = applyTurnEvent(durable, event('chunk', { text, seq: index + 1 }));
      nodes = reduceNodes(nodes, { type: 'chunk', nodeId: 'node-1', assistantId, text });
      const message = nodes['node-1'].messages[0];
      const visible = assistantAnswerVisibleText(message);
      expect(marker.startsWith(visible)).toBe(true);
      expect(visible.startsWith(previousVisible)).toBe(true);
      expect(projectAnswerRun(message.blocks ?? []).visibleText).toBe(visible);
      expect(checkpointTurnContent(durable)).toBe(visible);
      previousVisible = visible;
    }
    durable = applyTurnEvent(durable, event('done', { stopReason: 'completed', seq: chunks.length + 1 }));
    nodes = reduceNodes(nodes, { type: 'done', nodeId: 'node-1', assistantId });
    const message = nodes['node-1'].messages[0];
    expect(assistantAnswerRawText(message)).toBe(`${title}\n${marker}`);
    expect(assistantAnswerVisibleText(message)).toBe(marker);
    expect(assistantPersistenceContent(message)).toBe(marker);
    expect(durable.assistantMessage.content).toBe(marker);
  });

  it('matches the shared projector for durable assistant events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
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
      { stream: event('tool_call_update', { toolCallId: 'tool-1', title: 'Read', status: 'running', inputJson: '{"path":"/tmp/app.ts"}' }), action: { type: 'tool-call-update', nodeId: 'node-1', assistantId, tool: { id: 'tool-1', title: 'Read', status: 'running', inputJson: '{"path":"/tmp/app.ts"}' } } },
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

  it('stamps the same backend-observed text-block timing live and durably', () => {
    const assistantId = 'a-node-1-timing';
    let nodes: Record<string, ChatNodeState> = {
      'node-1': {
        nodeId: 'node-1', kind: 'chat', chatId: 'chat-1', projectId: 'ws-1',
        messages: [{ id: assistantId, role: 'assistant', text: '', toolCalls: [], blocks: [], streaming: true, createdAt: 100 }],
        followUps: [], status: 'streaming',
      },
    };
    let durable = createDurableTurn({
      turnId: 'turn-timing', assistantId, nodeId: 'node-1', workspaceId: 'ws-1', displayUserText: 'go', startedAt: 100,
    });
    const tool = { id: 'tool-1', title: 'Bash', status: 'running' };
    const trace: Array<{ stream: ChatStreamEvent; action: ChatAction }> = [
      { stream: event('thought', { text: 'plan', observedAt: 1_000 }), action: { type: 'thought', nodeId: 'node-1', assistantId, text: 'plan', observedAt: 1_000 } },
      { stream: event('tool_call', { toolCallId: 'tool-1', title: 'Bash', status: 'running', observedAt: 1_200 }), action: { type: 'tool-call', nodeId: 'node-1', assistantId, tool, observedAt: 1_200 } },
      { stream: event('tool_call_update', { toolCallId: 'tool-1', title: '', status: 'completed', output: 'ok', observedAt: 1_800 }), action: { type: 'tool-call-update', nodeId: 'node-1', assistantId, tool: { id: 'tool-1', title: '', status: 'completed', output: 'ok' }, observedAt: 1_800 } },
      { stream: event('chunk', { text: 'answer', observedAt: 2_500 }), action: { type: 'chunk', nodeId: 'node-1', assistantId, text: 'answer', observedAt: 2_500 } },
      { stream: event('done', { stopReason: 'end_turn', persisted: true, completedAt: 3_000 }), action: { type: 'done', nodeId: 'node-1', assistantId, completedAt: 3_000 } },
    ];
    for (const item of trace) {
      durable = applyTurnEvent(durable, item.stream);
      nodes = reduceNodes(nodes, item.action);
    }

    const blocks = nodes['node-1'].messages[0].blocks;
    expect(blocks).toEqual(durable.assistantMessage.blocks);
    expect(blocks?.[0]).toMatchObject({ kind: 'thinking', startedAt: 1_000, endedAt: 1_200 });
    expect(blocks?.[2]).toMatchObject({ kind: 'answer', startedAt: 2_500, endedAt: 3_000 });
  });
});
