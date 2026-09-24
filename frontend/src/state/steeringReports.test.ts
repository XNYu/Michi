import { describe, expect, it, vi } from 'vitest';
import { createDurableTurn, applyTurnEvent, type ChatStreamEvent } from 'michi-shared';
import { mapMessageRow, hydrateSavedState } from './chatHydration';
import { assistantPersistenceContent, visibleMessageText, migrateAssistantToBlocks, projectAssistantStreamEvent } from './assistantBlocks';
import { serializeMessageRowsForNode } from './workspacePersistence';
import { createBackgroundTurnBinding } from './observeChatStream';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';
import { reduceNodes } from './chatReducers';
import type { ChatMessage, ChatNodeState } from './chatTypes';

const report = { messageId: 'steer-c3999cf6ce9f462cb72019fcc3fb5368', text: 'Changed the recommendation to cobalt.', complete: true };
const marker = `[STEERING ${report.messageId}: ${report.text}]`;
const node = (message: ChatMessage): ChatNodeState => ({ nodeId: 'n', kind: 'chat', projectId: 'w', chatId: 'n', messages: [message], status: 'streaming', followUps: [] });

describe('steering reports', () => {
  it('projects, persists, hydrates and replays separately from visible/copy content', () => {
    const event: ChatStreamEvent = { event: 'steering_report', data: { reports: [report], seq: 2 } };
    let turn = createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'q', startedAt: 1 });
    turn = applyTurnEvent(turn, { event: 'chunk', data: { text: 'Answer', seq: 1 } });
    turn = applyTurnEvent(turn, event);
    const durable = turn.assistantMessage;
    const hydrated = mapMessageRow({ id: 'a', role: 'assistant', content: 'Answer', blocks: JSON.stringify(durable.blocks), metadata: JSON.stringify(durable.metadata) });
    expect(hydrated.steeringReports).toEqual([report]);
    expect(visibleMessageText(hydrated)).toBe('Answer');
    expect(assistantPersistenceContent(hydrated)).toBe('Answer');
    const projected = projectAssistantStreamEvent(hydrated, 'w', event);
    expect(projected.steeringReports).toEqual([report]);
    const rows = serializeMessageRowsForNode({ n: node(projected) }, 'n');
    expect(mapMessageRow(rows[0]).steeringReports).toEqual([report]);
    expect(rows[0].content).toBe('Answer');
  });

  it('migrates legacy content and block-split markers, preserves thinking and tool placement', () => {
    const legacy = mapMessageRow({ role: 'assistant', content: `Answer\n${marker}\nAfter` });
    expect(visibleMessageText(legacy)).toBe('Answer\n\nAfter');
    expect(legacy.steeringReports).toEqual([report]);
    const rows = serializeMessageRowsForNode({ n: node({ id: 'old', role: 'assistant', text: `Answer\n${marker}`, toolCalls: [] }) }, 'n');
    expect(mapMessageRow(rows[0]).steeringReports).toEqual([report]);
    const message = migrateAssistantToBlocks({ id: 'a', role: 'assistant', text: '', toolCalls: [], blocks: [
      { id: 'b1', kind: 'answer', rawText: 'Answer\n[STEER' },
      { id: 'b2', kind: 'answer', rawText: marker.slice(6) },
      { id: 'b3', kind: 'tool', toolCallId: 'tool', section: 'answer', rawOffset: marker.length + 7 },
      { id: 'b4', kind: 'thinking', rawText: marker },
      { id: 'b5', kind: 'answer', rawText: '\nAfter' },
    ] });
    expect(visibleMessageText(message)).toBe('Answer\n\nAfter');
    expect(message.steeringReports).toEqual([report]);
    expect(message.blocks?.[2]).toMatchObject({ rawOffset: 7 });
    expect(message.blocks?.[3]).toMatchObject({ rawText: marker });
    expect(migrateAssistantToBlocks(message).steeringReports).toEqual([report]);
  });

  it('keeps user text, code examples and malformed examples intact', () => {
    const user = mapMessageRow({ role: 'user', content: marker });
    expect(visibleMessageText(user)).toBe(marker);
    const code = `\`\`\`text\n${marker}\n\`\`\``;
    const message = mapMessageRow({ role: 'assistant', content: code });
    expect(visibleMessageText(message)).toBe(code);
    expect(message.steeringReports).toBeUndefined();
  });

  it('migrates saved snapshots and treats interrupted notes as incomplete', () => {
    const state = hydrateSavedState({ version: 6, projects: [], nodes: { n: {
      nodeId: 'n', projectId: 'w', messages: [{ id: 'a', role: 'assistant', text: `Answer\n[STEERING ${report.messageId}: Partial`, toolCalls: [] }],
    } } });
    expect(state.nodes.n.messages[0].steeringReports?.[0]).toMatchObject({ complete: false, text: 'Partial' });
    expect(visibleMessageText(state.nodes.n.messages[0])).toBe('Answer\n');
  });

  it('observer replay attaches to the correct assistant once and reset clears reports', () => {
    const dispatch = vi.fn();
    const handlers = createBackgroundTurnBinding({ chatId: 'n', nodeId: 'n', dispatch, lastTurnRef: { current: '' }, lastSeqRef: { current: -1 } }).createHandlers();
    const event: ChatStreamEvent = { event: 'steering_report', data: { reports: [report], assistantId: 'a', turnId: 't', seq: 2 } };
    dispatchChatStreamEvent(event, handlers);
    dispatchChatStreamEvent(event, handlers);
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'steering-report')).toEqual([[{ type: 'steering-report', nodeId: 'n', assistantId: 'a', reports: [report] }]]);
    let nodes: Record<string, ChatNodeState> = { n: node({ id: 'a', role: 'assistant', text: '', blocks: [], toolCalls: [], streaming: true }) };
    nodes = reduceNodes(nodes, { type: 'steering-report', nodeId: 'n', assistantId: 'a', reports: [report] });
    expect(nodes.n.messages[0].steeringReports).toEqual([report]);
    nodes = reduceNodes(nodes, { type: 'block-reset', nodeId: 'n', assistantId: 'a' });
    expect(nodes.n.messages[0].steeringReports).toBeUndefined();
  });
});
