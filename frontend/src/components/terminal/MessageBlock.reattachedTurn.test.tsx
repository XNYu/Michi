import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { MessageBlock } from './MessageBlock';
import { AgentBlockStyleOverride } from '../../state/prefs';
import { hydrateBackendWorkspaces } from '../../state/chatHydration';
import { reduceNodes } from '../../state/chatReducers';

// Reload mid-turn: the stored row ends in a finished tool, replay resumes past
// `turn_start`, and the next event is another tool call that is still running.
const runningWorkspace = {
  workspace: { id: 'ws1', name: 'Test', created_at: 1 },
  trees: [{ id: 't1', root_node_id: 'n1', created_at: 1, last_active_at: 1 }],
  nodes: [{ id: 'n1', created_at: 1, kind: 'chat', status: 'streaming', last_applied_turn_id: 'turn-1', last_applied_seq: 9, acp_session_id: 's1' }],
  edges: [],
  messages: [
    { id: 'u1', node_id: 'n1', role: 'user', content: 'Fix it', seq: 0, created_at: 1 },
    {
      id: 'a1', node_id: 'n1', role: 'assistant', content: '', seq: 1, created_at: 2,
      tool_calls: JSON.stringify([{ id: 't1', title: 'bash', status: 'completed' }]),
      blocks: JSON.stringify([
        { id: 'a1-b-0', kind: 'thinking', rawText: 'Run the tests next.', streaming: false },
        { id: 'a1-b-1', kind: 'tool', toolCallId: 't1', section: 'thinking', rawOffset: 19 },
      ]),
    },
  ],
  artifacts: [],
};

describe('a running tool call in a turn this renderer reattached to', () => {
  it('shows the agent block as Working…', () => {
    const { nodes } = hydrateBackendWorkspaces([runningWorkspace]);
    const next = reduceNodes(nodes, {
      type: 'tool-call', nodeId: 'n1', assistantId: 'a1',
      tool: { id: 't2', title: 'bash', status: 'in_progress' },
    });
    const { getByText } = render(
      <AgentBlockStyleOverride.Provider value="card">
        <MessageBlock m={next.n1.messages[1]} index={1} isDark={false} onCopy={() => {}} showThoughts fontFamily="inherit" density="comfortable" />
      </AgentBlockStyleOverride.Provider>,
    );
    expect(getByText('Working…')).not.toBeNull();
  });
});
