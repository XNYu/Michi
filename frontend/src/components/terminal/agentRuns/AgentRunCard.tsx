import React from 'react';
import { AgentRunStatus } from 'michi-shared';
import type { AgentRunAttemptDtoV1, AgentRunEventV1 } from 'michi-shared';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import {
  compactRunHandoff,
  elapsedRunLabel,
  hasRecoveredAttempt,
  runIdentity,
  runtimeProfileLabel,
  type LocatedAgentRun,
} from './agentRunSelectors';

const STATUS_COLOR: Record<AgentRunStatus, string> = {
  queued: 'var(--term-muted)', preparing: 'var(--term-select)', running: 'var(--term-accent)',
  waiting: 'var(--term-select)', recovering: 'var(--term-mauve)', completed: 'var(--term-digest)',
  failed: 'var(--term-danger)', cancelled: 'var(--term-faint)',
};

export interface AgentRunCardProps {
  run: LocatedAgentRun;
  attempts?: readonly AgentRunAttemptDtoV1[];
  events?: readonly AgentRunEventV1[];
  now?: number;
  onOpen: (identity: AgentResourceIdentity) => void;
}

export function AgentRunCard({ run: resource, attempts = [], events = [], now, onOpen }: AgentRunCardProps) {
  const run = resource.value;
  const identity = runIdentity(resource);
  const handoff = compactRunHandoff(run);
  const recovered = hasRecoveredAttempt(attempts, events);
  const environment = run.executionEnvironment.kind === 'git_worktree' ? 'isolated worktree' : 'shared workspace';
  return (
    <article
      data-testid="agent-run-card"
      style={{
        border: '1px solid var(--term-line)', background: 'var(--term-surface)',
        padding: '10px 12px', fontFamily: 'var(--ui-font)', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <strong style={{ color: 'var(--term-fg)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.effectiveDefinition.name}
        </strong>
        <span style={{ marginLeft: 'auto', color: STATUS_COLOR[run.status], fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>
          {run.status}
        </span>
      </div>
      <div style={{ color: 'var(--term-fg)', fontSize: 12, lineHeight: 1.45, marginTop: 5 }}>{run.task}</div>
      {handoff && (run.status === AgentRunStatus.Completed || run.status === AgentRunStatus.Failed) && (
        <div data-testid="compact-handoff" style={{ color: 'var(--term-mid)', fontSize: 11, lineHeight: 1.4, marginTop: 5 }}>
          {handoff}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--term-muted)', fontSize: 10 }}>
        <span>{runtimeProfileLabel(run)}</span>
        <span aria-hidden>·</span>
        <span>{environment}</span>
        <span aria-hidden>·</span>
        <span>{elapsedRunLabel(run, now)}</span>
        {recovered && <span style={{ color: 'var(--term-mauve)' }}>Recovered automatically</span>}
        <button
          type="button"
          onClick={() => onOpen(identity)}
          style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent', color: 'var(--term-accent)', font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Open →
        </button>
      </div>
    </article>
  );
}

export function AgentRunCardGroup({ runs, onOpen, onOpenAll }: {
  runs: readonly LocatedAgentRun[];
  onOpen: (identity: AgentResourceIdentity) => void;
  onOpenAll?: (identities: AgentResourceIdentity[]) => void;
}) {
  return (
    <section aria-label={`${runs.length} agent runs`} style={{ display: 'grid', gap: 6 }}>
      {runs.length > 1 && onOpenAll && (
        <button type="button" onClick={() => onOpenAll(runs.map(runIdentity))}
          style={{ justifySelf: 'end', border: 0, background: 'transparent', color: 'var(--term-muted)', fontSize: 10, cursor: 'pointer' }}>
          Open all
        </button>
      )}
      {runs.map((run) => <AgentRunCard key={`${run.backendConnectionId}:${run.value.id}`} run={run} onOpen={onOpen} />)}
    </section>
  );
}
