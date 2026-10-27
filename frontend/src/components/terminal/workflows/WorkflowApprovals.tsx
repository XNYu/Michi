import React from 'react';
import type { WorkflowApprovalDto, WorkflowRunDtoV1 } from 'michi-shared';

/**
 * Tool approvals a workflow's steps wait on, answered in place. Mirrors the
 * chat permission card: a select-tinted rule, the request, its detail in
 * mono, and one button per option (allow first, reject quiet).
 */

const MONO = 'var(--font-mono)';

function optionStyle(kind: string | undefined, primary: boolean): React.CSSProperties {
  const reject = kind?.startsWith('reject');
  return {
    height: 22,
    padding: '0 9px',
    border: '1px solid var(--term-line)',
    background: primary ? 'var(--term-alt)' : 'var(--term-surface)',
    color: reject ? 'var(--term-mid)' : 'var(--term-fg)',
    fontFamily: 'var(--ui-font)',
    fontSize: 'var(--fs-sm)',
    fontWeight: primary ? 600 : 400,
    cursor: 'pointer',
  };
}

function ApprovalRow({ run, approval, busy, onAnswer }: {
  run: WorkflowRunDtoV1;
  approval: WorkflowApprovalDto;
  busy: boolean;
  onAnswer: (approvalId: string, optionId: string) => void;
}) {
  const step = approval.nodeId
    ? run.nodes.find((node) => node.id === approval.nodeId)?.title ?? approval.nodeId
    : approval.scope === 'session' ? 'from this chat' : undefined;
  const stepTitle = approval.scope === 'session' && !approval.nodeId
    ? 'The runtime does not say which agent asked. This request shows on each running workflow of the chat; answering it once answers it everywhere.'
    : undefined;
  return (
    <div
      role="group"
      aria-label={`Approval needed: ${approval.title}`}
      data-testid="workflow-approval"
      style={{ borderLeft: '2px solid var(--term-select)', background: 'var(--term-alt)', padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--term-fg)' }}>{approval.title}</span>
        {step && <span title={stepTitle} style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{step}</span>}
      </div>
      {approval.detail && (
        <pre className="term-scrollbar" style={{ margin: 0, maxHeight: 140, overflow: 'auto', fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {approval.detail}
        </pre>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {approval.options.map((option, index) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busy}
            className="t-hover-fg"
            onClick={() => onAnswer(approval.id, option.optionId)}
            style={{ ...optionStyle(option.kind, index === 0), opacity: busy ? 0.6 : 1 }}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkflowApprovals({ run, busy = false, onAnswer }: {
  run: WorkflowRunDtoV1;
  busy?: boolean;
  onAnswer?: (approvalId: string, optionId: string) => void;
}) {
  const approvals = run.approvals ?? [];
  if (approvals.length === 0 || !onAnswer) return null;
  return (
    <div data-testid="workflow-approvals" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {approvals.map((approval) => (
        <ApprovalRow key={approval.id} run={run} approval={approval} busy={busy} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
