import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import type { ChatNodeState, SubagentInfo } from '../../state/chatTypes';
import { AgentBlockStyleOverride, DEFAULT_PREFS } from '../../state/prefs';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../state/workflowDomain';
import { PaneMessageList } from './PaneMessageList';
import { OPEN_BACKGROUND_WORK_EVENT, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

const subagent: SubagentInfo = {
  sessionId: 'toolu_agent', parentToolCallId: 'toolu_agent', sessionName: '', agentName: 'Explore', initialQuery: 'Map the auth flow',
  status: 'terminated', outcome: 'completed', group: '', dependsOn: [], prompt: 'Find every cookie reader.', result: 'Three readers.',
};

const node: ChatNodeState = {
  nodeId: 'obs-node',
  kind: 'chat',
  chatId: null,
  projectId: 'obs-ws',
  status: 'idle',
  messagesLoaded: true,
  followUps: [],
  messages: [
    { id: 'ask', role: 'user', text: 'Audit the auth flow.', toolCalls: [] },
    {
      id: 'answer',
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'toolu_agent', title: 'Agent', status: 'completed', kind: 'tool', detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }) },
        { id: 'toolu_wf', title: 'Workflow', status: 'completed', kind: 'tool' },
      ],
      blocks: [
        { id: 'b0', kind: 'tool', toolCallId: 'toolu_agent', section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'answer', rawText: 'Delegated the audit.' },
      ],
      subagents: [subagent],
    },
  ],
};

const run: WorkflowRunDtoV1 = {
  version: 1, id: 'wfr_1', runtime: 'claude', nativeId: 'w1', workspaceId: 'obs-ws', nodeId: 'obs-node', parentToolCallId: 'toolu_wf',
  name: 'read-probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
};

const noop = () => {};
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function recordRequests() {
  const requests: OpenBackgroundWorkDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  cleanups.push(() => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener));
  return requests;
}

function Subscribe({ workspaceId }: { workspaceId: string }) {
  const domain = useOptionalWorkflowDomain();
  React.useEffect(() => domain?.subscribeWorkspace(workspaceId), [domain, workspaceId]);
  return null;
}

function renderList() {
  const api: WorkflowDomainApi = {
    list: vi.fn(), get: vi.fn(), act: vi.fn(), answer: vi.fn(),
    subscribe: vi.fn((_workspaceId, options) => { options.onRun(run); return () => {}; }),
  };
  return render(
    <AgentBlockStyleOverride.Provider value="card">
      <WorkflowDomainProvider api={api}>
        <Subscribe workspaceId="obs-ws" />
        <PaneMessageList
          node={node}
          prefs={DEFAULT_PREFS}
          contentStyle={{}}
          streaming={false}
          viewportHeight={800}
          onRetryTurn={noop}
          onEditUserMessage={noop}
          onContinueFollowUp={noop}
          onBranchFollowUp={noop}
        />
      </WorkflowDomainProvider>
    </AgentBlockStyleOverride.Provider>,
  );
}

describe('PaneMessageList background work links', () => {
  it('a subagent card is one line that opens the drawer on that agent', () => {
    const requests = recordRequests();
    renderList();
    const message = document.querySelector('[data-msg-id="answer"]') as HTMLElement;
    // A finished delegation group starts collapsed.
    if (!within(message).queryByTestId('subagent-card')) fireEvent.click(message.querySelector('button[data-toolgroup-header]')!);
    const card = within(message).getByTestId('subagent-card');
    expect(within(card).queryByTestId('subagent-detail')).toBeNull();
    fireEvent.click(within(card).getByTestId('subagent-summary'));
    expect(requests).toEqual([{ nodeId: 'obs-node', focus: { kind: 'subagent', sessionId: 'toolu_agent' } }]);
  });

  it('a workflow card opens the drawer on its run instead of a pane', async () => {
    const requests = recordRequests();
    renderList();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow read-probe' }));
    expect(requests).toEqual([{ nodeId: 'obs-node', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }]);
  });
});
