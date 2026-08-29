import { AgentRunEventType, AgentRunStatus } from 'michi-shared';
import type {
  AgentRunAttemptDtoV1,
  AgentRunDtoV1,
  AgentRunEventV1,
} from 'michi-shared';
import type {
  AgentResourceIdentity,
  LocatedAgentResource,
} from '../../../state/agentIdentity';
import { identityOf } from '../../../state/agentIdentity';

export type LocatedAgentRun = LocatedAgentResource<AgentRunDtoV1>;

export interface AgentRunActivityGroups {
  needsAttention: LocatedAgentRun[];
  running: LocatedAgentRun[];
  failed: LocatedAgentRun[];
  recentlyCompleted: LocatedAgentRun[];
}

const ACTIVE = new Set<AgentRunStatus>([
  AgentRunStatus.Queued,
  AgentRunStatus.Preparing,
  AgentRunStatus.Running,
  AgentRunStatus.Recovering,
]);

export function runIdentity(run: LocatedAgentRun): AgentResourceIdentity {
  return identityOf(run);
}

export function selectAgentRunActivityGroups(
  runs: readonly LocatedAgentRun[],
  now = Date.now(),
  recentWindowMs = 7 * 24 * 60 * 60 * 1000,
): AgentRunActivityGroups {
  const groups: AgentRunActivityGroups = {
    needsAttention: [], running: [], failed: [], recentlyCompleted: [],
  };
  for (const resource of runs) {
    const run = resource.value;
    if (run.status === AgentRunStatus.Waiting) groups.needsAttention.push(resource);
    else if (ACTIVE.has(run.status)) groups.running.push(resource);
    else if (run.status === AgentRunStatus.Failed) groups.failed.push(resource);
    else if (
      run.status === AgentRunStatus.Completed
      && run.completedAt !== null
      && now - run.completedAt <= recentWindowMs
    ) groups.recentlyCompleted.push(resource);
  }
  const time = (resource: LocatedAgentRun) => resource.value.completedAt ?? resource.value.startedAt ?? resource.value.createdAt;
  groups.needsAttention.sort((a, b) => time(b) - time(a));
  groups.running.sort((a, b) => time(b) - time(a));
  groups.failed.sort((a, b) => time(b) - time(a));
  groups.recentlyCompleted.sort((a, b) => time(b) - time(a));
  return groups;
}

export function selectParentRunCards(
  runs: readonly LocatedAgentRun[],
  backendConnectionId: string,
  parentMessageId: string,
  parentToolCallId?: string | null,
): LocatedAgentRun[] {
  return runs.filter((resource) => {
    const run = resource.value;
    if (resource.backendConnectionId !== backendConnectionId || run.parentMessageId !== parentMessageId) return false;
    return parentToolCallId === undefined || run.parentToolCallId === parentToolCallId;
  }).sort((a, b) => a.value.createdAt - b.value.createdAt);
}

export function hasRecoveredAttempt(
  attempts: readonly AgentRunAttemptDtoV1[] = [],
  events: readonly AgentRunEventV1[] = [],
): boolean {
  return attempts.length > 1 || events.some((event) => event.type === AgentRunEventType.RecoveryStarted);
}

export function compactRunHandoff(run: AgentRunDtoV1): string | null {
  const handoff = run.resultBundle?.handoff;
  if (!handoff) return null;
  return handoff.conclusion.trim() || handoff.artifactsOrChanges.trim() || handoff.unresolvedIssues.trim() || null;
}

export function elapsedRunLabel(run: AgentRunDtoV1, now = Date.now()): string {
  const start = run.startedAt ?? run.createdAt;
  const end = run.completedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function runtimeProfileLabel(run: AgentRunDtoV1): string {
  const profile = run.effectiveDefinition.runtimeProfile;
  return [profile.runtimeId, profile.providerId, profile.modelId].filter(Boolean).join(' · ');
}
