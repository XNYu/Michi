import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import { mapNodeRowScalars } from './chatHydration';
import type { ChatNodeState } from './chatTypes';

function node(partial: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1',
    projectId: 'p1',
    kind: 'chat',
    title: 't',
    messages: [],
    status: 'streaming',
    ...partial,
  } as ChatNodeState;
}

describe('cancel phase reducer', () => {
  it('keeps the node streaming until settled, then done clears the phase', () => {
    const requested = reduceNodes({ n1: node() }, { type: 'cancel-phase', nodeId: 'n1', phase: 'requested' });
    expect(requested.n1.status).toBe('streaming');
    expect(requested.n1.cancelPhase).toBe('requested');

    const acked = reduceNodes(requested, { type: 'cancel-phase', nodeId: 'n1', phase: 'acknowledged' });
    expect(acked.n1.status).toBe('streaming');
    expect(acked.n1.cancelPhase).toBe('acknowledged');
  });

  it('accepts foreground identity only from the current streaming assistant', () => {
    let nodes: Record<string, ChatNodeState> = { n1: node({ activeTurnId: 'old-turn', lastAppliedTurnId: 'old-turn' }) };
    nodes = reduceNodes(nodes, { type: 'user-send', nodeId: 'n1', assistantId: 'new-a', userText: 'next' });
    expect(nodes.n1.activeTurnId).toBeUndefined();
    expect(nodes.n1.lastAppliedTurnId).toBe('old-turn');
    const stale = { type: 'active-turn', nodeId: 'n1', assistantId: 'old-a', turnId: 'old-turn' } as const;
    expect(reduceNodes(nodes, stale)).toBe(nodes);
    const current = { ...stale, assistantId: 'new-a', turnId: 'new-turn' };
    nodes = reduceNodes(nodes, current);
    expect(nodes.n1.activeTurnId).toBe('new-turn');
    const idle = { n1: { ...nodes.n1, status: 'idle' as const } };
    expect(reduceNodes(idle, current)).toBe(idle);
  });

  it.each([false, true])('background turn owns active identity with an existing assistant: %s', (existing) => {
    const messages: ChatNodeState['messages'] = existing
      ? [{ id: 'self-a', role: 'assistant', text: 'partial', toolCalls: [] }]
      : [];
    const nodes = reduceNodes({ n1: node({
      status: 'idle', messages, lastAppliedTurnId: 'completed-foreground', lastAppliedSeq: 9,
    }) }, {
      type: 'observer-turn-start', nodeId: 'n1', assistantId: 'self-a',
      turnId: 'active-background', userText: '', selfInitiated: true,
    });
    expect(nodes.n1).toMatchObject({
      status: 'streaming', activeTurnId: 'active-background',
      lastAppliedTurnId: 'completed-foreground', lastAppliedBackgroundTurnId: 'active-background',
    });
  });

  it.each(['done', 'error'] as const)('%s clears the active identity without erasing replay cursors', (type) => {
    const nodes = reduceNodes({ n1: node({
      activeTurnId: 'current', lastAppliedTurnId: 'current',
      messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls: [], streaming: true }],
    }) }, type === 'done'
      ? { type, nodeId: 'n1', assistantId: 'a1', aborted: true }
      : { type, nodeId: 'n1', assistantId: 'a1', message: 'cleanup failed' });
    expect(nodes.n1.activeTurnId).toBeUndefined();
    expect(nodes.n1.lastAppliedTurnId).toBe('current');
  });

  it.each(['done', 'error'] as const)('late %s of an older assistant preserves the new active identity', (type) => {
    const nodes = reduceNodes({ n1: node({
      activeTurnId: 'new-turn',
      messages: [
        { id: 'old-a', role: 'assistant', text: 'old', toolCalls: [] },
        { id: 'new-a', role: 'assistant', text: '', toolCalls: [], streaming: true },
      ],
    }) }, type === 'done'
      ? { type, nodeId: 'n1', assistantId: 'old-a', aborted: true }
      : { type, nodeId: 'n1', assistantId: 'old-a', message: 'old cleanup failed' });
    expect(nodes.n1).toMatchObject({ status: 'streaming', activeTurnId: 'new-turn' });
  });

  it.each(['streaming', 'idle', 'error'])('hydrates an active turn only for a %s node', (status) => {
    const hydrated = mapNodeRowScalars({ id: 'n1', status, last_applied_turn_id: 'persisted-turn' });
    expect(hydrated.lastAppliedTurnId).toBe('persisted-turn');
    expect(hydrated.activeTurnId).toBe(status === 'streaming' ? 'persisted-turn' : undefined);
  });
});
