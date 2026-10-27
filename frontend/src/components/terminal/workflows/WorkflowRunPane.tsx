import React, { useState } from 'react';
import { isWorkflowRunTerminal, workflowProgress, type WorkflowAction, type WorkflowNodeDto, type WorkflowRunDtoV1 } from 'michi-shared';
import MarkdownContent from '../../MarkdownContent';
import { formatDurationMs } from '../toolCallGrouping';
import { WorkflowActions, useLiveNow } from './WorkflowRunCard';
import { WorkflowApprovals } from './WorkflowApprovals';
import {
  NODE_STATUS_COLOR,
  NODE_STATUS_LABEL,
  RUNTIME_LABEL,
  WORKFLOW_STATUS_COLOR,
  WORKFLOW_STATUS_LABEL,
  formatWorkflowTokens,
  nodeDurationMs,
  workflowElapsedLabel,
  workflowNodeRows,
} from './workflowPresentation';

/**
 * A workflow run as a pane: the AgentRunPane header (name, status · elapsed,
 * runtime, controls, close), then WorkflowRunDetail: the definition, the
 * node tree with each node's task / now / result, the step log and the
 * final report.
 */

const MONO = 'var(--font-mono)';

const capsLabel: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 'var(--fs-xs)',
  letterSpacing: 'var(--ls-caps-wide)',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
  fontWeight: 500,
};

const proseVars: React.CSSProperties = {
  '--tw-prose-body': 'var(--term-mid)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-muted)',
  '--tw-prose-bullets': 'var(--term-muted)',
} as React.CSSProperties;

function Section({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={capsLabel}>{label}</span>
        <span aria-hidden style={{ flex: 1, borderTop: '1px solid var(--term-line)' }} />
        {aside}
      </div>
      {children}
    </section>
  );
}

function NodeGlyph({ node }: { node: WorkflowNodeDto }) {
  if (node.status === 'failed') {
    return <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-danger)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>;
  }
  if (node.status === 'queued' || node.status === 'skipped') {
    return <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-faint)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>○</span>;
  }
  return (
    <span aria-hidden style={{ width: 8, flexShrink: 0, display: 'inline-flex', alignSelf: 'center' }}>
      <span className={node.status === 'running' ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
    </span>
  );
}

const KIND_LABEL: Record<WorkflowNodeDto['kind'], string> = {
  phase: 'phase', agent: 'agent', step: 'step', parallel: 'parallel', loop: 'loop', branch: 'branch', group: 'group',
};

function NodeRow({ node, depth, now }: { node: WorkflowNodeDto; depth: number; now: number }) {
  const container = node.kind === 'phase' || node.kind === 'parallel' || node.kind === 'loop' || node.kind === 'branch' || node.kind === 'group';
  const hasDetail = !!(node.prompt || node.result || node.error);
  const [open, setOpen] = useState(node.status === 'failed' && !!node.error);
  const duration = nodeDurationMs(node, now);
  const meta = [
    node.agentName && node.agentName !== node.title ? node.agentName : undefined,
    node.model,
    node.iteration !== undefined ? `iteration ${node.iteration}` : undefined,
    node.attempt !== undefined && node.attempt > 1 ? `attempt ${node.attempt}` : undefined,
    node.toolCount ? `${node.toolCount} ${node.toolCount === 1 ? 'tool' : 'tools'}` : undefined,
    formatWorkflowTokens(node.usage?.totalTokens),
  ].filter(Boolean);
  const detailId = `workflow-node-${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return (
    <li data-testid="workflow-node" data-node-id={node.id} data-node-status={node.status} style={{ listStyle: 'none', paddingLeft: depth * 16, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
        <NodeGlyph node={node} />
        <span style={{
          fontSize: container ? 'var(--fs-xs)' : 'var(--fs-sm)',
          fontWeight: container ? 500 : 600,
          letterSpacing: container ? 'var(--ls-caps)' : undefined,
          textTransform: container ? 'uppercase' : undefined,
          color: node.status === 'failed' ? 'var(--term-danger)' : container ? 'var(--term-muted)' : 'var(--term-fg)',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {node.title}
        </span>
        {!container && <span style={{ fontFamily: MONO, fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)', flexShrink: 0 }}>{KIND_LABEL[node.kind]}</span>}
        {meta.length > 0 && (
          <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {meta.join(' · ')}
          </span>
        )}
        <span style={{ marginLeft: 'auto', paddingLeft: 8, display: 'inline-flex', alignItems: 'baseline', gap: 6, flexShrink: 0, fontSize: 'var(--fs-xs)' }}>
          <span style={{ color: NODE_STATUS_COLOR[node.status] }}>{NODE_STATUS_LABEL[node.status]}</span>
          {duration !== undefined && node.status !== 'running' && <span style={{ fontFamily: MONO, color: 'var(--term-muted)' }}>{formatDurationMs(duration)}</span>}
        </span>
      </div>
      <div style={{ paddingLeft: 15, display: 'flex', flexDirection: 'column', gap: 2, marginTop: 1 }}>
        {node.status === 'running' && (node.currentTool || node.statusMessage) && (
          <div style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--term-muted)' }}>now ❯ </span>
            <span style={{ color: 'var(--term-accent)' }}>{node.currentTool ?? node.statusMessage}</span>
          </div>
        )}
        {node.status !== 'running' && node.statusMessage && !node.result && (
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{node.statusMessage}</div>
        )}
        {hasDetail && (
          <div>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? detailId : undefined}
              aria-label={`${open ? 'Hide' : 'Show'} ${node.title} details`}
              onClick={() => setOpen((value) => !value)}
              className="t-hover-fg"
              style={{ border: 0, padding: 0, background: 'transparent', font: 'inherit', fontFamily: MONO, fontSize: 'var(--fs-xs)', cursor: 'pointer', color: node.error ? 'var(--term-danger)' : 'var(--term-muted)', display: 'inline-flex', gap: 6 }}
            >
              <span aria-hidden style={{ fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>
              {[node.prompt ? 'task' : undefined, node.error ? 'error' : node.result ? 'result' : undefined].filter(Boolean).join(' · ')}
            </button>
          </div>
        )}
        {open && hasDetail && (
          <div id={detailId} data-testid="workflow-node-detail" style={{ border: '1px solid var(--term-line)', background: 'var(--term-alt)', padding: '6px 10px 8px', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
            {node.prompt && (
              <div>
                <div style={{ ...capsLabel, fontSize: 'var(--fs-2xs)', marginBottom: 2 }}>task</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-mid)', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{node.prompt}</div>
              </div>
            )}
            {node.error && (
              <div>
                <div style={{ ...capsLabel, fontSize: 'var(--fs-2xs)', marginBottom: 2, color: 'var(--term-danger)' }}>error</div>
                <pre style={{ margin: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--term-danger)' }}>{node.error}</pre>
              </div>
            )}
            {node.result && (
              <div>
                <div style={{ ...capsLabel, fontSize: 'var(--fs-2xs)', marginBottom: 2 }}>result</div>
                <MarkdownContent text={node.result} size="sm" style={{ ...proseVars, fontSize: 'var(--fs-md)', lineHeight: 1.55 }} />
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Everything about a run below its title: description, status, approvals,
 * the definition, the node tree, the step log, the report and the footer.
 * The workflow pane puts it under its header; the Background work drawer
 * expands it in place, with the run's controls on top (`controls`).
 */
export function WorkflowRunDetail({ run, now, pending, error, onAction, onAnswer, onOpenParent, controls = false, className, style }: {
  run: WorkflowRunDtoV1;
  /** Clock for elapsed times (useLiveNow). */
  now: number;
  pending?: WorkflowAction | 'answer';
  error?: string;
  onAction?: (action: WorkflowAction) => void;
  onAnswer?: (approvalId: string, optionId: string) => void;
  onOpenParent?: () => void;
  /** Show status · elapsed, runtime and the Pause/Resume/Stop controls first. */
  controls?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const live = !isWorkflowRunTerminal(run.status);
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const rows = workflowNodeRows(run.nodes);
  const progress = workflowProgress(run);
  const color = WORKFLOW_STATUS_COLOR[run.status];
  const tokens = formatWorkflowTokens(run.usage?.totalTokens);
  return (
    <div data-testid="workflow-run-detail" className={className} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, ...style }}>
      {controls && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase', color, fontWeight: 600, flexShrink: 0 }}>
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: 'var(--ui-radius-pill)', background: color }} />
            {WORKFLOW_STATUS_LABEL[run.status]} · {workflowElapsedLabel(run, now)}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{RUNTIME_LABEL[run.runtime]}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 12, fontSize: 'var(--fs-sm)' }}>
            <WorkflowActions run={run} pending={pending} onAction={onAction} />
          </span>
        </div>
      )}
      {run.description && <div style={{ fontSize: 'var(--fs-md)', color: 'var(--term-mid)', lineHeight: 1.5 }}>{run.description}</div>}
      {(run.statusDetail && run.status !== 'running') || error ? (
        <div role={error ? 'alert' : undefined} style={{ fontSize: 'var(--fs-sm)', color: error || run.status === 'failed' ? 'var(--term-danger)' : run.status === 'paused' ? 'var(--term-select)' : 'var(--term-muted)' }}>
          {error ?? run.statusDetail}
        </div>
      ) : null}

      {run.approvals?.length ? (
        <Section label="needs approval">
          <WorkflowApprovals run={run} busy={pending === 'answer'} onAnswer={onAnswer} />
        </Section>
      ) : null}

      {run.definition && (
        <Section label={run.runtime === 'claude' ? 'script' : 'inputs'} aside={(
          <button type="button" aria-expanded={definitionOpen} onClick={() => setDefinitionOpen((value) => !value)} className="t-hover-fg"
            style={{ border: 0, padding: 0, background: 'transparent', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', cursor: 'pointer' }}>
            {definitionOpen ? 'hide' : 'show'}
          </button>
        )}>
          {definitionOpen && (
            <pre data-testid="workflow-definition" className="term-scrollbar" style={{ margin: 0, maxHeight: 320, overflow: 'auto', border: '1px solid var(--term-line)', background: 'var(--term-alt)', padding: '8px 10px', fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontVariantLigatures: 'none' }}>
              {run.definition}
            </pre>
          )}
        </Section>
      )}

      <Section label={run.runtime === 'claude' ? 'agents' : 'steps'} aside={progress.total > 0 ? (
        <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: progress.running > 0 ? 'var(--term-accent)' : 'var(--term-muted)' }}>
          {progress.done}/{progress.total}{progress.running > 0 ? ` · ${progress.running} running` : ''}{progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
        </span>
      ) : undefined}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{live ? 'Waiting for the first step…' : 'The runtime reported no steps for this workflow.'}</div>
        ) : (
          <ol aria-label="Workflow steps" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {rows.map(({ node, depth }) => <NodeRow key={node.id} node={node} depth={depth} now={now} />)}
          </ol>
        )}
      </Section>

      {run.log.length > 0 && (
        <Section label="messages" aside={<span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{run.log.length}</span>}>
          <ol aria-label="Workflow messages" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {run.log.map((entry, index) => (
              <li key={`${entry.at}-${index}`} style={{ listStyle: 'none', display: 'flex', gap: 8, fontSize: 'var(--fs-sm)', lineHeight: 1.45, minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)', flexShrink: 0 }}>
                  {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                {entry.nodeId && <span style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{entry.nodeId}</span>}
                <span style={{ color: entry.severity === 'error' ? 'var(--term-danger)' : entry.severity === 'warning' ? 'var(--term-select)' : 'var(--term-mid)', overflowWrap: 'anywhere' }}>{entry.text}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {run.result && (
        <Section label="result">
          <div data-testid="workflow-result" style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', padding: '8px 10px' }}>
            <MarkdownContent text={run.result} size="sm" style={{ ...proseVars, fontSize: 'var(--fs-lg)', lineHeight: 1.55 }} />
          </div>
        </Section>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', borderTop: '1px solid var(--term-line)', paddingTop: 8 }}>
        <span>{RUNTIME_LABEL[run.runtime]}</span>
        <span aria-hidden>·</span>
        <span>{run.nativeId}</span>
        {tokens && (<><span aria-hidden>·</span><span>{tokens}</span></>)}
        {run.usage?.toolUses ? (<><span aria-hidden>·</span><span>{run.usage.toolUses} tools</span></>) : null}
        <span aria-hidden>·</span>
        <span>started {new Date(run.startedAt).toLocaleString()}</span>
        {onOpenParent && run.nodeId && (
          <button type="button" onClick={onOpenParent} style={{ marginLeft: 'auto', border: 0, padding: 0, background: 'transparent', color: 'var(--term-accent)', font: 'inherit', cursor: 'pointer' }}>
            ↰ Open chat
          </button>
        )}
      </div>
    </div>
  );
}

export function WorkflowRunPane({ run, pending, error, onClose, onAction, onAnswer, onOpenParent }: {
  run: WorkflowRunDtoV1;
  pending?: WorkflowAction | 'answer';
  error?: string;
  onClose: () => void;
  onAction?: (action: WorkflowAction) => void;
  onAnswer?: (approvalId: string, optionId: string) => void;
  onOpenParent?: () => void;
}) {
  const live = !isWorkflowRunTerminal(run.status);
  const now = useLiveNow(live);
  const color = WORKFLOW_STATUS_COLOR[run.status];
  return (
    <section data-testid="workflow-run-pane" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', background: 'var(--term-bg)', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)' }}>
      <header style={{ height: 36, display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--term-line)', padding: '0 12px', background: 'var(--term-surface)', flexShrink: 0, minWidth: 0 }}>
        <span aria-hidden style={{ color: 'var(--term-mauve)', fontSize: 'var(--fs-sm)' }}>⧉</span>
        <span style={{ color: 'var(--term-fg)', fontSize: 'var(--fs-lg)', fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.name}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase', color, fontWeight: 600, flexShrink: 0 }}>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: 'var(--ui-radius-pill)', background: color }} />
          {WORKFLOW_STATUS_LABEL[run.status]} · {workflowElapsedLabel(run, now)}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', flexShrink: 0 }}>{RUNTIME_LABEL[run.runtime]}</span>
        <span style={{ display: 'inline-flex', gap: 12, fontSize: 'var(--fs-md)' }}>
          <WorkflowActions run={run} pending={pending} onAction={onAction} />
        </span>
        <button type="button" aria-label="Close workflow pane" onClick={onClose}
          style={{ border: 0, background: 'transparent', color: 'var(--term-muted)', cursor: 'pointer', fontSize: 'var(--fs-xl)' }}>×</button>
      </header>

      <WorkflowRunDetail
        run={run}
        now={now}
        pending={pending}
        error={error}
        onAction={onAction}
        onAnswer={onAnswer}
        onOpenParent={onOpenParent}
        className="term-scrollbar"
        style={{ overflowY: 'auto', padding: '14px 16px 18px', flex: 1 }}
      />
    </section>
  );
}
