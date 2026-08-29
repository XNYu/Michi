import { AgentRunStatus, AgentRunWaitingReason } from 'michi-shared';
import type { AgentRunDtoV1 } from 'michi-shared';
import type { LocatedAgentResource } from './agentIdentity';
import { agentResourceKey, identityOf } from './agentIdentity';
import { agentRunPaneId } from './paneItems';

export type AgentRunNotificationKind = 'waiting' | 'permission' | 'failed' | 'completed';

export interface AgentRunNotification {
  key: string;
  kind: AgentRunNotificationKind;
  title: string;
  body: string;
  run: LocatedAgentResource<AgentRunDtoV1>;
}

export type AgentRunNotificationState = Record<string, string>;

export interface AgentRunNotificationTracker {
  collect(args: {
    runs: readonly LocatedAgentResource<AgentRunDtoV1>[];
    focusedPaneId: string | null;
  }): AgentRunNotification[];
  snapshot(): AgentRunNotificationState;
}

function notificationKind(run: AgentRunDtoV1): AgentRunNotificationKind | null {
  if (run.status === AgentRunStatus.Waiting) {
    return run.waitingReason === AgentRunWaitingReason.Permission ? 'permission' : 'waiting';
  }
  if (run.status === AgentRunStatus.Failed) return 'failed';
  if (run.status === AgentRunStatus.Completed) return 'completed';
  return null;
}

function transitionMarker(run: AgentRunDtoV1): string {
  return `${run.status}:${run.waitingReason ?? ''}`;
}

function copyFor(kind: AgentRunNotificationKind, run: AgentRunDtoV1): Pick<AgentRunNotification, 'title' | 'body'> {
  const name = run.effectiveDefinition.name;
  if (kind === 'permission') return { title: `${name} needs permission`, body: run.task };
  if (kind === 'waiting') return { title: `${name} is waiting`, body: run.task };
  if (kind === 'failed') return { title: `${name} failed`, body: run.resultBundle?.handoff.conclusion || run.task };
  return { title: `${name} completed`, body: run.resultBundle?.handoff.conclusion || run.task };
}

/**
 * Derive new notifications from durable Run snapshots. Every observed state is
 * recorded even when its pane is focused, so replaying that snapshot later
 * cannot produce a stale toast.
 */
export function collectAgentRunNotifications({
  runs,
  previous,
  focusedPaneId,
}: {
  runs: readonly LocatedAgentResource<AgentRunDtoV1>[];
  previous: AgentRunNotificationState;
  focusedPaneId: string | null;
}): { notifications: AgentRunNotification[]; state: AgentRunNotificationState } {
  const state = { ...previous };
  const notifications: AgentRunNotification[] = [];
  for (const resource of runs) {
    const identity = identityOf(resource);
    const key = agentResourceKey(identity);
    const marker = transitionMarker(resource.value);
    const changed = state[key] !== marker;
    state[key] = marker;
    const kind = notificationKind(resource.value);
    if (!changed || !kind || focusedPaneId === agentRunPaneId(identity.backendConnectionId, identity.id)) continue;
    notifications.push({ key: `${key}:${marker}`, kind, run: resource, ...copyFor(kind, resource.value) });
  }
  return { notifications, state };
}

/** Keeps replay dedupe alive for the lifetime of one browser window/module. */
export function createAgentRunNotificationTracker(
  initial: AgentRunNotificationState = {},
): AgentRunNotificationTracker {
  let state = { ...initial };
  return {
    collect({ runs, focusedPaneId }) {
      const result = collectAgentRunNotifications({ runs, previous: state, focusedPaneId });
      state = result.state;
      return result.notifications;
    },
    snapshot: () => ({ ...state }),
  };
}
