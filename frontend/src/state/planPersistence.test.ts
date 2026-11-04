import { describe, expect, it } from 'vitest';
import { applyTurnEvent, createDurableTurn, type PlanEntry } from 'michi-shared';
import { mapMessageRow } from './chatHydration';
import { projectAssistantStreamEvent } from './assistantBlocks';
import { serializeMessageRowsForNode } from './workspacePersistence';
import type { ChatMessage, ChatNodeState } from './chatTypes';

const node = (message: ChatMessage): ChatNodeState => ({ nodeId: 'n', kind: 'chat', projectId: 'w', chatId: 'n', messages: [message], status: 'idle', followUps: [] });
const plan: PlanEntry[] = [
  { content: 'Write tests', priority: 'medium', status: 'completed' },
  { content: 'Implement tool', priority: 'medium', status: 'in_progress' },
];

/** Durable projection -> stored metadata -> hydration -> write-back, as the backend and frontend do it. */
function roundTrip(entries: PlanEntry[]) {
  let turn = createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'q', startedAt: 1 });
  turn = applyTurnEvent(turn, { event: 'chunk', data: { text: 'Answer', seq: 1 } });
  turn = applyTurnEvent(turn, { event: 'plan', data: { entries: plan, seq: 2 } });
  turn = applyTurnEvent(turn, { event: 'plan', data: { entries, seq: 3 } });
  const durable = turn.assistantMessage;
  const hydrated = mapMessageRow({ id: 'a', role: 'assistant', content: 'Answer', blocks: JSON.stringify(durable.blocks),
    metadata: JSON.stringify({ ...durable.metadata, plan: durable.plan }) });
  const rows = serializeMessageRowsForNode({ n: node(hydrated) }, 'n');
  return { durable, hydrated, written: rows[0].metadata ? JSON.parse(rows[0].metadata) : null };
}

describe('plan persistence', () => {
  it('hydrates the latest plan and writes it back unchanged', () => {
    const { durable, hydrated, written } = roundTrip(plan);
    expect(durable.plan).toEqual(plan);
    expect(hydrated.plan).toEqual(plan);
    expect(written).toEqual({ plan });
  });

  it('keeps a cleared plan through write-back so an older plan cannot come back', () => {
    const { durable, hydrated, written } = roundTrip([]);
    expect(durable.plan).toEqual([]);
    expect(hydrated.plan).toEqual([]);
    expect(written).toEqual({ plan: [] });
  });

  it('a live plan event replaces the message plan, including with an empty list', () => {
    const message = mapMessageRow({ id: 'a', role: 'assistant', content: 'Answer', metadata: JSON.stringify({ plan }) });
    const cleared = projectAssistantStreamEvent(message, 'w', { event: 'plan', data: { entries: [] } });
    expect(cleared.plan).toEqual([]);
    expect(JSON.parse(serializeMessageRowsForNode({ n: node(cleared) }, 'n')[0].metadata!)).toEqual({ plan: [] });
  });

  it('writes no metadata for a message that never had a plan', () => {
    const message = mapMessageRow({ id: 'a', role: 'assistant', content: 'Answer' });
    expect(message.plan).toBeUndefined();
    expect(serializeMessageRowsForNode({ n: node(message) }, 'n')[0].metadata).toBeNull();
  });
});
