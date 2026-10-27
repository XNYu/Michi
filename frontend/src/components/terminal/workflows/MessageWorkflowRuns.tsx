import React from 'react';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import {
  useOptionalWorkflowDomain,
  useWorkflowRun,
  workflowRunKey,
  type WorkflowPlacement,
} from '../../../state/workflowDomain';
import { WorkflowRunCard } from './WorkflowRunCard';

/** One card, subscribed to its own run so other runs' progress skips it. */
const ConnectedWorkflowRunCard = React.memo(function ConnectedWorkflowRunCard({ identity, onOpen }: {
  identity: AgentResourceIdentity;
  onOpen?: (identity: AgentResourceIdentity, name: string) => void;
}) {
  const domain = useOptionalWorkflowDomain();
  const { resource, pending, error } = useWorkflowRun(workflowRunKey(identity));
  if (!resource) return null;
  return (
    <WorkflowRunCard
      run={resource.value}
      pending={pending}
      error={error}
      onAction={domain ? (action) => { void domain.act(identity, action); } : undefined}
      onAnswer={domain ? (approvalId, optionId) => { void domain.answer(identity, approvalId, optionId); } : undefined}
      onOpen={onOpen ? () => onOpen(identity, resource.value.name) : undefined}
    />
  );
});

/** Workflow runs a message launched, under it. */
export function MessageWorkflowRuns({ runs, onOpen }: {
  runs: readonly WorkflowPlacement[];
  onOpen?: (identity: AgentResourceIdentity, name: string) => void;
}) {
  return (
    <div style={{ margin: '8px 0 2px', display: 'grid', gap: 6 }}>
      {runs.map((placement) => (
        <ConnectedWorkflowRunCard key={workflowRunKey(placement.identity)} identity={placement.identity} onOpen={onOpen} />
      ))}
    </div>
  );
}
