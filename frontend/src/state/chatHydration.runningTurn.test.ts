import { describe, expect, it } from 'vitest';
import { applyTreeMessages, hydrateBackendWorkspaces, mapMessageRow } from './chatHydration';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState } from './chatTypes';

// A turn that was mid tool call when this renderer loaded: the stored row has a
// thought and a finished tool; replay resumes past `turn_start`.
const assistantRow = {
  id: 'a1', node_id: 'n1', role: 'assistant', content: '', seq: 1, created_at: 2,
  tool_calls: JSON.stringify([{ id: 't1', title: 'bash', status: 'completed' }]),
  blocks: JSON.stringify([
    { id: 'a1-b-0', kind: 'thinking', rawText: 'Run the tests next.', streaming: false },
    { id: 'a1-b-1', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 19 },
  ]),
};

function workspace(nodeStatus: 'streaming' | 'idle') {
  return {
    workspace: { id: 'ws1', name: 'Test', created_at: 1 },
    trees: [{ id: 't1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
    nodes: [{ id: 'n1', created_at: 1, kind: 'chat', status: nodeStatus, last_applied_turn_id: 'turn-1', last_applied_seq: 9, acp_session_id: 's1' }],
    edges: [],
    messages: [{ id: 'u1', node_id: 'n1', role: 'user', content: 'Fix it', seq: 0, created_at: 1 }, assistantRow],
    artifacts: [],
  };
}

describe('a running turn opened by a renderer that did not start it', () => {
  it('marks the turn’s assistant message live, and later tool calls keep it live', () => {
    const { nodes } = hydrateBackendWorkspaces([workspace('streaming')]);
    expect(nodes.n1.messages.map((m) => m.streaming)).toEqual([false, true]);

    const next = reduceNodes(nodes, {
      type: 'tool-call', nodeId: 'n1', assistantId: 'a1',
      tool: { id: 't2', title: 'bash', status: 'in_progress' },
    });
    expect(next.n1.messages[1].streaming).toBe(true);
    expect(next.n1.messages[1].toolCalls.at(-1)).toMatchObject({ id: 't2', status: 'in_progress' });
  });

  it('leaves a finished turn finished', () => {
    const { nodes } = hydrateBackendWorkspaces([workspace('idle')]);
    expect(nodes.n1.messages[1].streaming).toBe(false);
  });

  it('marks the message live when a lazily loaded thread receives its rows', () => {
    const placeholder = { nodeId: 'n1', projectId: 'ws1', kind: 'chat', chatId: 'n1', status: 'streaming', messages: [], messagesLoaded: false, followUps: [] } as unknown as ChatNodeState;
    const nodes = applyTreeMessages({ n1: placeholder }, { n1: [mapMessageRow(assistantRow)] });
    expect(nodes.n1.messages[0].streaming).toBe(true);
  });
});
