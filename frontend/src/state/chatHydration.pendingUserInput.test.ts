import { describe, expect, it } from 'vitest';
import { applyTreeMessages, hydrateBackendWorkspaces, mapMessageRow } from './chatHydration';
import { selectPendingAskUsers } from './askUserSelectors';
import type { ChatNodeState } from './chatTypes';

const question = { id: 'q1', question: 'Ship the status email now?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'Not yet' }] };

function assistantRow(status: 'pending' | 'answered' | 'interrupted') {
  return {
    id: 'a1', node_id: 'n1', role: 'assistant', content: 'The draft is ready.', seq: 1, created_at: 2,
    blocks: JSON.stringify([
      { id: 'a1-b-0', kind: 'answer', rawText: 'The draft is ready.', streaming: false },
      { id: 'a1-b-1', kind: 'user-input', requestId: 3, section: 'answer', rawOffset: 19,
        interaction: { interactionId: 'turn-1:input:3', requestId: 3, questions: [question], answers: [], status } },
    ]),
  };
}

function workspace(nodeStatus: 'streaming' | 'idle', interactionStatus: 'pending' | 'answered' | 'interrupted') {
  return {
    workspace: { id: 'ws1', name: 'Test', created_at: 1 },
    trees: [{ id: 't1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'n1', created_at: 1, kind: 'chat', status: nodeStatus, last_applied_turn_id: 'turn-1', last_applied_seq: 9, acp_session_id: 's1' }],
    edges: [],
    messages: [{ id: 'u1', node_id: 'n1', role: 'user', content: 'Draft and send it', seq: 0, created_at: 1 }, assistantRow(interactionStatus)],
    artifacts: [],
  };
}

describe('a question asked before this renderer was watching', () => {
  it('is restored as the pending request of a running turn, so it can be answered and is announced', () => {
    const { nodes } = hydrateBackendWorkspaces([workspace('streaming', 'pending')]);
    expect(nodes.n1.pendingUserInput).toEqual({ requestId: 3, interactionId: 'turn-1:input:3', questions: [question], answers: [] });
    expect(selectPendingAskUsers(nodes)).toMatchObject([{ nodeId: 'n1', requestId: 3, question: 'Ship the status email now?' }]);
  });

  it('is not restored once answered, or when the turn is no longer running', () => {
    expect(hydrateBackendWorkspaces([workspace('streaming', 'answered')]).nodes.n1.pendingUserInput).toBeUndefined();
    expect(hydrateBackendWorkspaces([workspace('idle', 'pending')]).nodes.n1.pendingUserInput).toBeUndefined();
    expect(hydrateBackendWorkspaces([workspace('streaming', 'interrupted')]).nodes.n1.pendingUserInput).toBeUndefined();
  });

  it('is restored when a lazily loaded thread receives its messages', () => {
    const placeholder = { nodeId: 'n1', projectId: 'ws1', kind: 'chat', chatId: 'n1', status: 'streaming', messages: [], messagesLoaded: false, followUps: [] } as unknown as ChatNodeState;
    const nodes = applyTreeMessages({ n1: placeholder }, { n1: [mapMessageRow(assistantRow('pending'))] });
    expect(nodes.n1.pendingUserInput?.requestId).toBe(3);
  });

  it('keeps a request the live stream already delivered', () => {
    const live = { requestId: 4, interactionId: 'turn-1:input:4', questions: [question], answers: [] };
    const node = { nodeId: 'n1', projectId: 'ws1', kind: 'chat', chatId: 'n1', status: 'streaming', messages: [], messagesLoaded: false, followUps: [], pendingUserInput: live } as unknown as ChatNodeState;
    const nodes = applyTreeMessages({ n1: node }, { n1: [mapMessageRow(assistantRow('pending'))] });
    expect(nodes.n1.pendingUserInput).toBe(live);
  });
});
