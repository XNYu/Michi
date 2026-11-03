import React, { useEffect, useState } from 'react';
import { isWorkflowRunTerminal, workflowProgress, type WorkflowAction, type WorkflowRunDtoV1 } from 'michi-shared';
import {
  ACTION_LABEL,
  NODE_STATUS_COLOR,
  RUNTIME_LABEL,
  WORKFLOW_STATUS_COLOR,
  WORKFLOW_STATUS_LABEL,
  formatWorkflowTokens,
  workflowElapsedLabel,
  workflowNowLine,
} from './workflowPresentation';
import { WorkflowApprovals } from './WorkflowApprovals';
import { FadeOnChange, RevealOnShow } from '../agentBlockMotion';

/**
 * A workflow launched by this message, under the chip that launched it.
 * Same hairline card vocabulary as AgentRunCard: name + uppercase status,
 * a progress strip of the run's agents/steps, the live "now" line, and a
 * meta row with controls and "Open →".
 */

const MONO = 'var(--font-mono)';

/** Re-render every second while a run is live (elapsed time). */
export function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const textButton: React.CSSProperties = {
  border: 0,
  padding: 0,
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export function WorkflowActions({ run, pending, onAction }: {
  run: WorkflowRunDtoV1;
  pending?: WorkflowAction | 'answer';
  onAction?: (action: WorkflowAction) => void;
}) {
  if (!onAction || run.actions.length === 0) return null;
  return (
    <>
      {run.actions.map((action) => (
        <button
          key={action}
          type="button"
          disabled={!!pending}
          onClick={() => onAction(action)}
          aria-label={`${ACTION_LABEL[action]} workflow ${run.name}`}
          className="t-hover-fg"
          style={{ ...textButton, color: action === 'stop' ? 'var(--term-mid)' : 'var(--term-muted)', opacity: pending && pending !== action ? 0.5 : 1 }}
        >
          {pending === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]}
        </button>
      ))}
    </>
  );
}

/** One cell per agent/step, colored by status (a change eases in); hover names it. */
function ProgressStrip({ run }: { run: WorkflowRunDtoV1 }) {
  const leaves = run.nodes.filter((node) => node.kind === 'agent' || node.kind === 'step');
  if (leaves.length === 0) return null;
  return (
    <div aria-hidden style={{ display: 'flex', gap: 2, marginTop: 8 }}>
      {leaves.slice(0, 48).map((node) => (
        <span
          key={node.id}
          title={`${node.title} · ${node.status}`}
          className={node.status === 'running' ? 'term-dot-i--run' : undefined}
          style={{
            flex: 1,
            maxWidth: 28,
            height: 3,
            background: node.status === 'queued' || node.status === 'skipped' ? 'var(--term-line)' : NODE_STATUS_COLOR[node.status],
            opacity: node.status === 'completed' ? 0.55 : 1,
            transition: 'background-color var(--t-enter) ease-out, opacity var(--t-enter) ease-out',
          }}
        />
      ))}
    </div>
  );
}

export function WorkflowRunCard({ run, pending, error, onOpen, onAction, onAnswer }: {
  run: WorkflowRunDtoV1;
  pending?: WorkflowAction | 'answer';
  error?: string;
  onOpen?: () => void;
  onAction?: (action: WorkflowAction) => void;
  onAnswer?: (approvalId: string, optionId: string) => void;
}) {
  const live = !isWorkflowRunTerminal(run.status);
  const now = useLiveNow(live);
  const progress = workflowProgress(run);
  const nowLine = workflowNowLine(run);
  const color = WORKFLOW_STATUS_COLOR[run.status];
  const tokens = formatWorkflowTokens(run.usage?.totalTokens);
  return (
    <article
      data-testid="workflow-run-card"
      aria-label={`Workflow ${run.name}, ${WORKFLOW_STATUS_LABEL[run.status]}`}
      style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', padding: '10px 12px', fontFamily: 'var(--ui-font)', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span aria-hidden style={{ color: 'var(--term-mauve)', fontSize: 'var(--fs-xs)', flexShrink: 0 }}>⧉</span>
        <strong style={{ color: 'var(--term-fg)', fontSize: 'var(--fs-md)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.name}
        </strong>
        <span style={{ fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase', color: 'var(--term-muted)', border: '1px solid var(--term-line-s)', padding: '1px 5px', flexShrink: 0 }}>
          workflow
        </span>
        {/* A new status fades in in its colour; sections that appear later grow in. */}
        <FadeOnChange
          k={run.status}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color, fontSize: 'var(--fs-xs)', fontWeight: 700, letterSpacing: 'var(--ls-wide)', textTransform: 'uppercase', flexShrink: 0 }}
        >
          {live ? <span className={run.status === 'running' ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} aria-hidden /> : null}
          {WORKFLOW_STATUS_LABEL[run.status]}
        </FadeOnChange>
      </div>
      {run.description && run.description !== run.name && (
        <div style={{ color: 'var(--term-mid)', fontSize: 'var(--fs-sm)', lineHeight: 1.45, marginTop: 4 }}>{run.description}</div>
      )}
      <ProgressStrip run={run} />
      <RevealOnShow show={!!nowLine}>
        <div data-testid="workflow-now" style={{ marginTop: 6, fontFamily: MONO, fontSize: 'var(--fs-xs)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: 'var(--term-muted)' }}>now ❯ </span>
          <span style={{ color: run.status === 'paused' ? 'var(--term-select)' : 'var(--term-accent)' }}>{nowLine}</span>
        </div>
      </RevealOnShow>
      <RevealOnShow show={!!run.approvals?.length}>
        <div style={{ marginTop: 8 }}><WorkflowApprovals run={run} busy={pending === 'answer'} onAnswer={onAnswer} /></div>
      </RevealOnShow>
      <RevealOnShow show={!live && !!run.statusDetail && run.status !== 'completed'}>
        <div style={{ marginTop: 6, fontSize: 'var(--fs-sm)', color: run.status === 'failed' ? 'var(--term-danger)' : 'var(--term-muted)' }}>{run.statusDetail}</div>
      </RevealOnShow>
      <RevealOnShow show={!!error}>
        <div role="alert" style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--term-danger)' }}>{error}</div>
      </RevealOnShow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', minWidth: 0 }}>
        <span>{RUNTIME_LABEL[run.runtime]}</span>
        {progress.total > 0 && (
          <>
            <span aria-hidden>·</span>
            <span style={{ fontFamily: MONO }}>
              {progress.done}/{progress.total} {run.runtime === 'claude' ? 'agents' : 'steps'}
              {progress.failed > 0 && <span style={{ color: 'var(--term-danger)' }}> · {progress.failed} failed</span>}
            </span>
          </>
        )}
        {tokens && (<><span aria-hidden>·</span><span style={{ fontFamily: MONO }}>{tokens}</span></>)}
        <span aria-hidden>·</span>
        <span style={{ fontFamily: MONO }}>{workflowElapsedLabel(run, now)}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <WorkflowActions run={run} pending={pending} onAction={onAction} />
          {onOpen && (
            <button type="button" onClick={onOpen} aria-label={`Open workflow ${run.name}`} style={{ ...textButton, color: 'var(--term-accent)' }}>
              Open →
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
