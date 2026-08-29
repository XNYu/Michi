import { describe, expect, it } from 'vitest';
import { AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import type { AgentRunDtoV1 } from 'michi-shared';
import { agentRunPaneId } from './paneItems';
import { collectAgentRunNotifications, createAgentRunNotificationTracker } from './agentRunNotifications';

function located(status: AgentRunStatus, waitingReason: AgentRunWaitingReason | null = null) {
  return {
    backendConnectionId: 'backend-a',
    value: {
      id: 'run-1', status, waitingReason, task: 'Inspect the change',
      effectiveDefinition: { name: 'Reviewer' }, resultBundle: null,
    } as AgentRunDtoV1,
  };
}

describe('collectAgentRunNotifications', () => {
  it('notifies waiting, failure, and completion transitions once across replay', () => {
    let state = {};
    let result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission)], previous: state, focusedPaneId: null });
    expect(result.notifications.map((item) => item.kind)).toEqual(['permission']);
    state = result.state;
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Waiting, AgentRunWaitingReason.Permission)], previous: state, focusedPaneId: null });
    expect(result.notifications).toEqual([]);
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Failed)], previous: result.state, focusedPaneId: null });
    expect(result.notifications.map((item) => item.kind)).toEqual(['failed']);
    result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Completed)], previous: result.state, focusedPaneId: null });
    expect(result.notifications.map((item) => item.kind)).toEqual(['completed']);
  });

  it('records but suppresses a transition while its Run pane is focused', () => {
    const focusedPaneId = agentRunPaneId('backend-a', 'run-1');
    const first = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Completed)], previous: {}, focusedPaneId });
    expect(first.notifications).toEqual([]);
    const replay = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Completed)], previous: first.state, focusedPaneId: null });
    expect(replay.notifications).toEqual([]);
  });

  it('keeps equal Run ids on different Backends independent', () => {
    const other = { ...located(AgentRunStatus.Completed), backendConnectionId: 'backend-b' };
    const result = collectAgentRunNotifications({ runs: [located(AgentRunStatus.Completed), other], previous: {}, focusedPaneId: null });
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0].key).not.toBe(result.notifications[1].key);
  });

  it('retains replay dedupe in a per-window tracker', () => {
    const tracker = createAgentRunNotificationTracker();
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)], focusedPaneId: null })).toHaveLength(1);
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)], focusedPaneId: null })).toEqual([]);
  });
});
