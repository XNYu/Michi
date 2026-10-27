import { describe, expect, it } from 'vitest';
import { AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import type { AgentRunDtoV1 } from 'michi-shared';

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

  it('retains replay dedupe in a per-window tracker', () => {
    const tracker = createAgentRunNotificationTracker();
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)], focusedPaneId: null })).toHaveLength(1);
    expect(tracker.collect({ runs: [located(AgentRunStatus.Completed)], focusedPaneId: null })).toEqual([]);
  });
});
