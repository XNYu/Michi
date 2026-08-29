import React, { useMemo, useState } from 'react';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import { AgentRunCard } from './AgentRunCard';
import { selectAgentRunActivityGroups, type LocatedAgentRun } from './agentRunSelectors';

export function AgentRunsActivity({ runs, onOpen, defaultExpanded = false, now }: {
  runs: readonly LocatedAgentRun[];
  onOpen: (identity: AgentResourceIdentity) => void;
  defaultExpanded?: boolean;
  now?: number;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const groups = useMemo(() => selectAgentRunActivityGroups(runs, now), [runs, now]);
  const visibleCount = groups.needsAttention.length + groups.running.length + groups.failed.length + groups.recentlyCompleted.length;
  const sections = [
    ['Needs attention', groups.needsAttention], ['Running', groups.running],
    ['Failed', groups.failed], ['Recently completed', groups.recentlyCompleted],
  ] as const;
  return (
    <section aria-label="Agent runs activity" style={{ borderTop: '1px solid var(--term-line)', fontFamily: 'var(--ui-font)' }}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}
        style={{ width: '100%', border: 0, background: 'transparent', color: visibleCount ? 'var(--term-fg)' : 'var(--term-muted)', padding: '9px 0', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>
        <span aria-hidden>{expanded ? '−' : '+'}</span>
        Agent runs
        <span style={{ color: 'var(--term-faint)', marginLeft: 'auto' }}>{visibleCount}</span>
      </button>
      {expanded && visibleCount > 0 && (
        <div style={{ display: 'grid', gap: 14, paddingBottom: 12 }}>
          {sections.map(([label, items]) => items.length > 0 && (
            <div key={label}>
              <div style={{ color: 'var(--term-muted)', fontSize: 10, marginBottom: 5 }}>{label}</div>
              <div style={{ display: 'grid', gap: 5 }}>
                {items.map((run) => <AgentRunCard key={`${run.backendConnectionId}:${run.value.id}`} run={run} now={now} onOpen={onOpen} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
