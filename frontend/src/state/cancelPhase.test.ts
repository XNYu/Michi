import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

function node(partial: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    id: 'n1',
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
});
