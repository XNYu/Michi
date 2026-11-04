import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { workflowProgress } from 'michi-shared';
import { DrawerShell, type DrawerShellProps } from '../../ui/DrawerShell';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import {
  chatLabel,
  shallowArrayEqual,
  useChatProjects,
  useNodesSelector,
} from '../../../state/chatStore';
import type { ChatNodeState, SubagentInfo } from '../../../state/chatTypes';
import { findTreeIdForNode } from '../../../state/tree';
import {
  selectBackgroundWork,
  threadConversationIds,
  type BackgroundWork,
  type BackgroundWorkKeep,
} from '../../../state/backgroundWork';
import {
  useBackgroundSubagentLiveness,
  useOptionalWorkflowDomain,
  useWorkflowRun,
  useWorkflowRunDetail,
  useWorkflowRunsForNodes,
} from '../../../state/workflowDomain';
import { formatDurationMs } from '../toolCallGrouping';
import { SubagentDetail, subagentDetailDomId } from '../subagents/SubagentDetail';
import { SubagentSummaryText } from '../subagents/SubagentRoster';
import {
  SUBAGENT_TONE_COLOR,
  SUBAGENT_TONE_LABEL,
  firstPlainLine,
  subagentDisplayName,
  subagentShownDurationMs,
  subagentSummary,
  subagentToolCount,
  subagentTone,
} from '../subagents/subagentPresentation';
import { useLiveNow } from '../workflows/WorkflowRunCard';
import { WorkflowRunDetail } from '../workflows/WorkflowRunPane';
import { WORKFLOW_STATUS_COLOR, WORKFLOW_STATUS_LABEL, workflowNowLine } from '../workflows/workflowPresentation';
import type { BackgroundWorkFocus, OpenBackgroundWorkDetail } from './backgroundWorkEvents';

/**
 * Background work: what a conversation's subagents and workflows are doing,
 * one line each, in a right drawer. A line expands in place to the full
 * subagent detail (task, activity, result) or workflow run (steps, messages,
 * result, controls, approvals). Opened only by a user click (pane-title
 * badge, in-chat card); live while open. Which items it lists is
 * `selectBackgroundWork`; finished work it lists while other work runs
 * folds behind one line (`foldedItems`).
 */

type Scope = 'conversation' | 'thread';

const MONO = 'var(--font-mono)';
const DRAWER_WIDTH = 640;

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const BODY: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };

/**
 * A phone fills its screen with the drawer and reads it at arm's length:
 * the chrome scale (sized for a desktop window) steps up for everything in
 * it, expanded agent and workflow detail included, and each row takes two
 * lines (stackedRow) so the larger name, summary and status still fit.
 */
const PHONE_BODY = {
  ...BODY,
  '--fs-2xs': '11px',
  '--fs-xs': '12px',
  '--fs-sm': '13px',
  '--fs-md': '15px',
  '--fs-lg': '16px',
} as React.CSSProperties;

function itemKey(nodeId: string, focus: BackgroundWorkFocus): string {
  return JSON.stringify([nodeId, focus.kind, focus.kind === 'subagent' ? focus.sessionId : focus.runKey]);
}

/** An item the drawer lists: its conversation and the item. */
interface ListedItem {
  nodeId: string;
  focus: BackgroundWorkFocus;
}

function parseItemKey(key: string): ListedItem | null {
  try {
    const [nodeId, kind, id] = JSON.parse(key) as unknown[];
    if (typeof nodeId !== 'string' || typeof id !== 'string') return null;
    if (kind === 'subagent') return { nodeId, focus: { kind, sessionId: id } };
    if (kind === 'workflow') return { nodeId, focus: { kind, runKey: id } };
  } catch {
    // Not an item key.
  }
  return null;
}

/** selectBackgroundWork's `keep`, per conversation. */
function keepByNode(items: Iterable<ListedItem>): Map<string, BackgroundWorkKeep> {
  const byNode = new Map<string, { subagentIds: Set<string>; runKeys: Set<string> }>();
  for (const { nodeId, focus } of items) {
    let keep = byNode.get(nodeId);
    if (!keep) {
      keep = { subagentIds: new Set(), runKeys: new Set() };
      byNode.set(nodeId, keep);
    }
    if (focus.kind === 'subagent') keep.subagentIds.add(focus.sessionId);
    else keep.runKeys.add(focus.runKey);
  }
  return byNode;
}

/** Items listed since the current open request (see the drawer's sticky ref). */
interface StickyItems {
  /** The request's requestSeq. */
  token: number;
  items: Map<string, ListedItem>;
  /** Item keys `foldedItems` folded when they were first listed. */
  folded: Set<string>;
}

interface WorkGroupValue {
  node: ChatNodeState;
  title: string;
  loading: boolean;
  current: boolean;
  work: BackgroundWork;
  /** Item keys behind the section's fold line (foldedItems). */
  folded: ReadonlySet<string>;
}

/**
 * Which listed items fold behind their section's "N finished" line: the
 * ones already finished when the drawer first lists them under the current
 * request while other items in their section run. Decided once per item,
 * like the sticky items: one the drawer listed unfolded stays in view (an
 * agent that finishes while the user watches does not slide out of
 * sight), and a new running item does not fold what was already showing.
 * Opening again decides afresh.
 */
function foldedItems(nodeId: string, work: BackgroundWork, sticky: StickyItems | undefined): ReadonlySet<string> {
  const folded = new Set<string>();
  const decide = (key: string, active: boolean, sectionRunning: boolean) => {
    const fold = sticky?.items.has(key) ? sticky.folded.has(key) : !active && sectionRunning;
    if (fold) folded.add(key);
  };
  const subagentsRunning = work.subagents.some((item) => item.active);
  for (const item of work.subagents) {
    decide(itemKey(nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId }), item.active, subagentsRunning);
  }
  const workflowsRunning = work.workflows.some((item) => item.active);
  for (const item of work.workflows) {
    decide(itemKey(nodeId, { kind: 'workflow', runKey: item.runKey }), item.active, workflowsRunning);
  }
  return folded;
}

function runningCount(work: BackgroundWork): number {
  return work.subagents.filter((item) => item.active).length + work.workflows.filter((item) => item.active).length;
}

const rowButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '5px 14px',
  border: 0,
  margin: 0,
  background: 'transparent',
  color: 'var(--term-fg)',
  font: 'inherit',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left',
  cursor: 'pointer',
};

/** A phone's row: name and status, then (under the name) summary and meta. */
const stackedRow: React.CSSProperties = { ...rowButton, flexDirection: 'column', alignItems: 'stretch', gap: 3, padding: '8px 14px' };
const rowLine: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', minWidth: 0 };
/** The status dot and the gap after it: the second line starts under the name. */
const subLine: React.CSSProperties = { ...rowLine, paddingLeft: 16, boxSizing: 'border-box' };

function nameStyle(stacked: boolean, failed: boolean): React.CSSProperties {
  return {
    ...ellipsis,
    ...(stacked ? { flex: 1, fontSize: 'var(--fs-md)' } : { flexShrink: 0, maxWidth: '35%', fontSize: 'var(--fs-sm)' }),
    fontWeight: 600,
    color: failed ? 'var(--term-danger)' : 'var(--term-fg)',
  };
}

function Chevron({ open }: { open: boolean }) {
  return <span aria-hidden style={{ flexShrink: 0, width: 10, textAlign: 'center', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{open ? '▾' : '▸'}</span>;
}

function StatusDot({ color, live }: { color: string; live: boolean }) {
  return (
    <span aria-hidden style={{ width: 8, flexShrink: 0, display: 'inline-flex', alignSelf: 'center' }}>
      <span className={live ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} style={{ background: color }} />
    </span>
  );
}

/**
 * Elapsed time, ticking while the agent runs (a background agent's too:
 * since it started, not its launch turn's length). Still once it stopped.
 */
function SubagentDuration({ subagent, active }: { subagent: SubagentInfo; active: boolean }) {
  const now = useLiveNow(active);
  const duration = subagentShownDurationMs(subagent, active, now);
  return duration === undefined ? null : <span>{formatDurationMs(duration)}</span>;
}

const SubagentWorkRow = React.memo(function SubagentWorkRow({ subagent, active, rowKey, expanded, onToggle }: {
  subagent: SubagentInfo;
  active: boolean;
  rowKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  // A `working` entry the conversation no longer counts reads as ended.
  const tone = subagentTone(subagent, active);
  const summary = subagentSummary(subagent, { running: tone === 'running' });
  const tools = subagentToolCount(subagent);
  const name = subagentDisplayName(subagent);
  const stacked = usePhoneLayout();
  const dot = <StatusDot color={SUBAGENT_TONE_COLOR[tone]} live={active} />;
  const nameText = <span style={nameStyle(stacked, tone === 'failed')}>{name}</span>;
  const summaryText = summary ? <SubagentSummaryText summary={summary} /> : <span style={{ flex: 1 }} />;
  const meta = (
    <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
      <SubagentDuration subagent={subagent} active={active} />
      {tools > 0 && <span>{tools} {tools === 1 ? 'tool' : 'tools'}</span>}
    </span>
  );
  const status = <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: SUBAGENT_TONE_COLOR[tone] }}>{SUBAGENT_TONE_LABEL[tone]}</span>;
  return (
    <div data-testid="background-subagent-row" data-background-work-key={rowKey} data-subagent-id={subagent.sessionId} data-active={active ? 'true' : undefined} data-stacked={stacked ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? subagentDetailDomId(subagent) : undefined}
        aria-label={`${name}, ${SUBAGENT_TONE_LABEL[tone]}${summary ? `: ${summary.text}` : ''}`}
        onClick={() => onToggle(rowKey)}
        className="t-hover-bg-alt"
        style={stacked ? stackedRow : rowButton}
      >
        {stacked ? (
          <>
            <span data-row-line="" style={rowLine}>{dot}{nameText}{status}<Chevron open={expanded} /></span>
            <span data-row-line="" style={subLine}>{summaryText}{meta}</span>
          </>
        ) : (
          <>{dot}{nameText}{summaryText}{meta}{status}<Chevron open={expanded} /></>
        )}
      </button>
      {expanded && (
        <div style={{ padding: '2px 14px 10px 30px' }}>
          <SubagentDetail subagent={subagent} active={active} bounded={false} />
        </div>
      )}
    </div>
  );
});

/** The full run, fetched whole when the bulk snapshot trimmed it. */
function WorkflowRunExpanded({ backendConnectionId, runId }: { backendConnectionId: string; runId: string }) {
  const domain = useOptionalWorkflowDomain();
  const identity = useMemo(() => ({ backendConnectionId, id: runId }), [backendConnectionId, runId]);
  const { resource, pending, error } = useWorkflowRunDetail(identity);
  const run = resource?.value;
  const now = useLiveNow(!!run && (run.status === 'running' || run.status === 'paused'));
  if (!run) return null;
  return (
    <WorkflowRunDetail
      run={run}
      now={now}
      pending={pending}
      error={error}
      controls
      onAction={domain ? (action) => { void domain.act(identity, action); } : undefined}
      onAnswer={domain ? (approvalId, optionId) => { void domain.answer(identity, approvalId, optionId); } : undefined}
      style={{ padding: '6px 14px 14px 30px' }}
    />
  );
}

const WorkflowWorkRow = React.memo(function WorkflowWorkRow({ runKey, rowKey, expanded, onToggle }: {
  runKey: string;
  rowKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const { resource } = useWorkflowRun(runKey);
  const stacked = usePhoneLayout();
  if (!resource) return null;
  const run = resource.value;
  const live = run.status === 'running' || run.status === 'paused';
  const progress = workflowProgress(run);
  const now = workflowNowLine(run);
  const finished = live ? undefined : firstPlainLine(run.result) ?? firstPlainLine(run.statusDetail);
  const approvals = run.approvals?.length ?? 0;
  const color = WORKFLOW_STATUS_COLOR[run.status];
  const lead = (
    <>
      <StatusDot color={color} live={run.status === 'running'} />
      <span aria-hidden style={{ flexShrink: 0, color: 'var(--term-mauve)', fontSize: 'var(--fs-xs)' }}>⧉</span>
      <span style={nameStyle(stacked, run.status === 'failed')}>{run.name}</span>
    </>
  );
  const nowText = (
    <span data-testid="background-workflow-now" style={{ ...ellipsis, flex: 1, fontFamily: now ? MONO : undefined, fontSize: now ? 'var(--fs-xs)' : 'var(--fs-sm)' }}>
      {now ? (
        <>
          <span style={{ color: 'var(--term-muted)' }}>now ❯ </span>
          <span style={{ color: run.status === 'paused' ? 'var(--term-select)' : 'var(--term-accent)' }}>{now}</span>
        </>
      ) : finished ? (
        <span style={{ color: run.status === 'failed' ? 'var(--term-danger)' : 'var(--term-mid)' }}>{finished}</span>
      ) : null}
    </span>
  );
  const approval = approvals > 0 && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-select)' }}>needs approval</span>;
  const steps = progress.total > 0 && (
    <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
      {progress.done}/{progress.total} {run.runtime === 'claude' ? 'agents' : 'steps'}
    </span>
  );
  const status = <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color }}>{WORKFLOW_STATUS_LABEL[run.status]}</span>;
  return (
    <div data-testid="background-workflow-row" data-background-work-key={rowKey} data-run-key={runKey} data-active={live ? 'true' : undefined} data-stacked={stacked ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Workflow ${run.name}, ${WORKFLOW_STATUS_LABEL[run.status]}${approvals > 0 ? ', needs approval' : ''}`}
        onClick={() => onToggle(rowKey)}
        className="t-hover-bg-alt"
        style={stacked ? stackedRow : rowButton}
      >
        {stacked ? (
          <>
            <span data-row-line="" style={rowLine}>{lead}{approval}{status}<Chevron open={expanded} /></span>
            {(now || finished || steps) && <span data-row-line="" style={subLine}>{nowText}{steps}</span>}
          </>
        ) : (
          <>{lead}{nowText}{approval}{steps}{status}<Chevron open={expanded} /></>
        )}
      </button>
      {expanded && <WorkflowRunExpanded backendConnectionId={resource.backendConnectionId} runId={run.id} />}
    </div>
  );
});

function SectionLabel({ label, total, running }: { label: string; total: number; running: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 3px', fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', color: 'var(--term-muted)' }}>
      <span>{label}</span>
      <span aria-hidden style={{ flex: 1, borderTop: '1px solid var(--term-line)' }} />
      <span style={{ fontFamily: MONO, textTransform: 'none', letterSpacing: 0, color: running > 0 ? 'var(--term-accent)' : 'var(--term-muted)' }}>
        {running > 0 ? `${running} running` : total}
      </span>
    </div>
  );
}

/** A fold of one row is no shorter than the row: one stays inline. */
const FOLD_MIN = 2;

function FoldLine({ count, failed, noun, open, controls, onClick }: {
  count: number;
  failed: number;
  noun: string;
  open: boolean;
  controls: string;
  onClick: () => void;
}) {
  const stacked = usePhoneLayout();
  return (
    <button
      type="button"
      data-testid="background-work-fold"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={`${count} finished ${noun}${failed > 0 ? `, ${failed} failed` : ''}`}
      onClick={onClick}
      className="t-hover-bg-alt"
      style={stacked ? { ...rowButton, padding: stackedRow.padding } : rowButton}
    >
      <span aria-hidden style={{ width: 8, flexShrink: 0, textAlign: 'center', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{open ? '▾' : '▸'}</span>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{count} finished</span>
      {failed > 0 && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)' }}>· {failed} failed</span>}
    </button>
  );
}

/**
 * One section of a conversation's work: its running items, then finished
 * ones, those `foldedItems` picked behind one line. The fold opens on a
 * click, or by itself while it holds the expanded item (a focused
 * finished agent, or one the user expanded before it finished), and then
 * stays open so collapsing that row does not close it under the user.
 */
function WorkSection<T extends { active: boolean }>({ label, noun, items, keyOf, isFailed, renderItem, folded, foldKey, foldOpen, onSetFold, expandedKey, onToggle }: {
  label: string;
  /** The fold line's noun: "subagents", "workflows". */
  noun: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  isFailed: (item: T) => boolean;
  renderItem: (item: T, key: string) => React.ReactNode;
  folded: ReadonlySet<string>;
  foldKey: string;
  foldOpen: boolean;
  onSetFold: (key: string, open: boolean) => void;
  expandedKey: string | null;
  onToggle: (key: string) => void;
}) {
  const listId = useId();
  const keyed = items.map((item) => ({ item, key: keyOf(item) }));
  const tucked = keyed.filter(({ item, key }) => !item.active && folded.has(key));
  const folds = tucked.length >= FOLD_MIN;
  const inline = folds ? keyed.filter((entry) => !tucked.includes(entry)) : keyed;
  const holdsExpanded = folds && expandedKey !== null && tucked.some(({ key }) => key === expandedKey);
  useEffect(() => {
    if (holdsExpanded && !foldOpen) onSetFold(foldKey, true);
  }, [holdsExpanded, foldOpen, foldKey, onSetFold]);
  const open = foldOpen || holdsExpanded;
  const running = items.filter((item) => item.active).length;
  return (
    <>
      <SectionLabel label={label} total={items.length} running={running} />
      {inline.map(({ item, key }) => renderItem(item, key))}
      {folds && (
        <>
          <FoldLine
            count={tucked.length}
            failed={tucked.filter(({ item }) => isFailed(item)).length}
            noun={noun}
            open={open}
            controls={listId}
            onClick={() => {
              if (!open) {
                onSetFold(foldKey, true);
                return;
              }
              // Closing hides the row it holds: collapse that too.
              if (holdsExpanded && expandedKey) onToggle(expandedKey);
              onSetFold(foldKey, false);
            }}
          />
          {open && <div id={listId}>{tucked.map(({ item, key }) => renderItem(item, key))}</div>}
        </>
      )}
    </>
  );
}

function WorkGroup({ group, showHeader, expandedKey, onToggle, openFolds, onSetFold }: {
  group: WorkGroupValue;
  showHeader: boolean;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  openFolds: ReadonlySet<string>;
  onSetFold: (key: string, open: boolean) => void;
}) {
  const { node, work, loading, folded } = group;
  const empty = work.subagents.length === 0 && work.workflows.length === 0;
  const subagentsFold = JSON.stringify([node.nodeId, 'subagents']);
  const workflowsFold = JSON.stringify([node.nodeId, 'workflows']);
  return (
    <section data-testid="background-work-group" data-node-id={node.nodeId} aria-label={showHeader ? group.title : undefined} style={{ paddingBottom: 6 }}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px 2px', minWidth: 0 }}>
          <span data-testid="background-work-group-title" style={{ ...ellipsis, fontSize: 'var(--fs-md)', fontWeight: 600, color: 'var(--term-fg)' }}>{group.title}</span>
          {group.current && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>this conversation</span>}
        </div>
      )}
      {loading && empty && (
        <div role="status" className="term-hydrating" style={{ padding: '4px 14px', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>loading…</div>
      )}
      {work.subagents.length > 0 && (
        <WorkSection
          label="subagents"
          noun="subagents"
          items={work.subagents}
          keyOf={(item) => itemKey(node.nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId })}
          isFailed={(item) => subagentTone(item.subagent, item.active) === 'failed'}
          renderItem={(item, key) => (
            <SubagentWorkRow key={key} subagent={item.subagent} active={item.active} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />
          )}
          folded={folded}
          foldKey={subagentsFold}
          foldOpen={openFolds.has(subagentsFold)}
          onSetFold={onSetFold}
          expandedKey={expandedKey}
          onToggle={onToggle}
        />
      )}
      {work.workflows.length > 0 && (
        <WorkSection
          label="workflows"
          noun="workflows"
          items={work.workflows}
          keyOf={(item) => itemKey(node.nodeId, { kind: 'workflow', runKey: item.runKey })}
          isFailed={(item) => item.run.value.status === 'failed'}
          renderItem={(item, key) => <WorkflowWorkRow key={key} runKey={item.runKey} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />}
          folded={folded}
          foldKey={workflowsFold}
          foldOpen={openFolds.has(workflowsFold)}
          onSetFold={onSetFold}
          expandedKey={expandedKey}
          onToggle={onToggle}
        />
      )}
    </section>
  );
}

const NO_FOLDS: ReadonlySet<string> = new Set();

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'conversation', label: 'This conversation' },
  { value: 'thread', label: 'Whole thread' },
];

function ScopeSwitch({ scope, onChange, phone }: { scope: Scope; onChange: (scope: Scope) => void; phone: boolean }) {
  return (
    <div role="group" aria-label="Show background work for" style={{ display: 'inline-flex', border: '1px solid var(--term-line)', flexShrink: 0 }}>
      {SCOPES.map(({ value, label }, index) => {
        const active = scope === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={active ? undefined : 't-hover-fg'}
            style={{
              border: 0,
              borderLeft: index > 0 ? '1px solid var(--term-line)' : 0,
              // A finger-sized target on a phone.
              padding: phone ? '8px 12px' : '3px 10px',
              background: active ? 'var(--term-alt)' : 'transparent',
              color: active ? 'var(--term-fg)' : 'var(--term-muted)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-sm)',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export interface BackgroundWorkDrawerProps extends Pick<DrawerShellProps, 'open' | 'onClose' | 'motion' | 'onPresenceChange'> {
  request: OpenBackgroundWorkDetail;
  /** Bumps on every open request, so opening again re-applies its focus. */
  requestSeq: number;
}

export default function BackgroundWorkDrawer({ open, onClose, motion, onPresenceChange, request, requestSeq }: BackgroundWorkDrawerProps) {
  const { activeProject } = useChatProjects();
  const focusKey = request.focus ? itemKey(request.nodeId, request.focus) : null;
  const [scope, setScope] = useState<Scope>('conversation');
  const [expandedKey, setExpandedKey] = useState<string | null>(focusKey);
  // Fold lines the user (or an expanded item, see WorkSection) opened.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(NO_FOLDS);
  const [appliedSeq, setAppliedSeq] = useState(requestSeq);
  if (appliedSeq !== requestSeq) {
    // A new open request: back to its conversation, its focus expanded.
    setAppliedSeq(requestSeq);
    setScope('conversation');
    setExpandedKey(focusKey);
    setOpenFolds(NO_FOLDS);
  }
  const onSetFold = useCallback((key: string, value: boolean) => setOpenFolds((current) => {
    if (current.has(key) === value) return current;
    const next = new Set(current);
    if (value) next.add(key);
    else next.delete(key);
    return next;
  }), []);

  // The history rule applies when the drawer opens: what it has listed since
  // the current request stays listed while it stays open, so an item the
  // user reads does not vanish the moment it finishes, nor when the scope
  // switches and back (items are per conversation; keepByNode applies them
  // only to the conversations listed). A ref, not state: recording what was
  // listed must not re-render.
  const stickyToken = requestSeq;
  const sticky = useRef<StickyItems>({ token: stickyToken, items: new Map(), folded: new Set() });
  if (sticky.current.token !== stickyToken) sticky.current = { token: stickyToken, items: new Map(), folded: new Set() };

  const requestNodeId = request.nodeId;
  // The thread of the requested conversation, whichever thread is active.
  const rootNodeId = useMemo(() => {
    if (!activeProject) return null;
    const treeId = findTreeIdForNode(requestNodeId, activeProject);
    return activeProject.trees.find((tree) => tree.id === treeId)?.rootNodeId ?? null;
  }, [activeProject, requestNodeId]);
  const edges = activeProject?.edges;
  const selectNodes = useCallback((nodes: Record<string, ChatNodeState>) => {
    const ids = scope === 'thread' ? threadConversationIds(rootNodeId, edges ?? [], nodes) : [requestNodeId];
    return ids.flatMap((id) => {
      const node = nodes[id];
      return node && !node.deletedAt && node.kind === 'chat' ? [node] : [];
    });
  }, [scope, rootNodeId, edges, requestNodeId]);
  const nodes = useNodesSelector(selectNodes, shallowArrayEqual);
  const idsKey = nodes.map((node) => node.nodeId).join('\u0000');
  const nodeIds = useMemo(() => (idsKey ? idsKey.split('\u0000') : []), [idsKey]);
  const runs = useWorkflowRunsForNodes(nodeIds);
  // Which background agents a live process still tracks (same feed).
  const liveness = useBackgroundSubagentLiveness();

  // Keep the workspace's workflow runs live while the drawer is open (the
  // subscription is shared with the dashboard's).
  const subscribeWorkspace = useOptionalWorkflowDomain()?.subscribeWorkspace;
  const workspaceId = activeProject?.id;
  useEffect(() => {
    if (!open || !workspaceId || !subscribeWorkspace) return;
    return subscribeWorkspace(workspaceId);
  }, [open, workspaceId, subscribeWorkspace]);

  const requestFocus = request.focus;
  const groups = useMemo<WorkGroupValue[]>(() => {
    const listed = sticky.current.token === stickyToken ? sticky.current : undefined;
    const kept: ListedItem[] = listed ? [...listed.items.values()] : [];
    if (requestFocus) kept.push({ nodeId: requestNodeId, focus: requestFocus });
    const expanded = expandedKey ? parseItemKey(expandedKey) : null;
    if (expanded) kept.push(expanded);
    const keep = keepByNode(kept);
    return nodes.map((node) => {
      const work = selectBackgroundWork(node, runs, keep.get(node.nodeId), liveness(node.projectId, node.nodeId));
      return {
        node,
        title: node.title || chatLabel(node),
        loading: node.messagesLoaded === false,
        current: node.nodeId === requestNodeId,
        work,
        folded: foldedItems(node.nodeId, work, listed),
      };
    });
  }, [nodes, runs, liveness, requestFocus, requestNodeId, expandedKey, stickyToken]);
  useEffect(() => {
    const current = sticky.current;
    if (current.token !== stickyToken) return;
    const record = (nodeId: string, focus: BackgroundWorkFocus, folded: ReadonlySet<string>) => {
      const key = itemKey(nodeId, focus);
      if (current.items.has(key)) return;
      current.items.set(key, { nodeId, focus });
      if (folded.has(key)) current.folded.add(key);
    };
    for (const { node, work, folded } of groups) {
      for (const item of work.subagents) record(node.nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId }, folded);
      for (const item of work.workflows) record(node.nodeId, { kind: 'workflow', runKey: item.runKey }, folded);
    }
  }, [groups, stickyToken]);
  const shown = scope === 'thread'
    ? groups.filter((group) => group.loading || group.work.subagents.length > 0 || group.work.workflows.length > 0)
    : groups;
  const running = groups.reduce((sum, group) => sum + runningCount(group.work), 0);
  const nothing = shown.every((group) => !group.loading && group.work.subagents.length === 0 && group.work.workflows.length === 0);

  const onToggle = useCallback((key: string) => setExpandedKey((current) => (current === key ? null : key)), []);

  // Scroll the focused item into view once per request, as soon as it is
  // rendered (its conversation may still be loading when the drawer opens).
  // A ref, not state: store pushes can re-render before a state reset lands.
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !focusKey) return;
    const token = `${requestSeq}\u0000${focusKey}`;
    if (scrolledFor.current === token) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-background-work-key]') ?? [];
    const row = Array.from(rows).find((element) => element.dataset.backgroundWorkKey === focusKey);
    if (!row) return;
    scrolledFor.current = token;
    row.scrollIntoView?.({ block: 'start' });
  }, [open, focusKey, requestSeq, groups]);

  const conversationTitle = scope === 'conversation' ? groups[0]?.title : undefined;
  const phone = usePhoneLayout();

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      motion={motion}
      onPresenceChange={onPresenceChange}
      title="Background work"
      width={DRAWER_WIDTH}
      titleBadge={running > 0 ? (
        <span data-testid="background-work-running" style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-accent)', fontFamily: 'var(--ui-font)' }}>{running} running</span>
      ) : undefined}
    >
      <div data-testid="background-work-body" style={phone ? PHONE_BODY : BODY}>
        {/* A title the switch leaves no room for takes its own line on a phone. */}
        <div style={{ display: 'flex', flexWrap: phone ? 'wrap' : undefined, alignItems: 'center', gap: phone ? '8px 10px' : 10, padding: '8px 14px', borderBottom: '1px solid var(--term-line)', minWidth: 0 }}>
          <ScopeSwitch scope={scope} onChange={setScope} phone={phone} />
          {conversationTitle && <span style={{ ...ellipsis, fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{conversationTitle}</span>}
        </div>
        <div ref={listRef} data-testid="background-work-list" className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 0 18px' }}>
          {nothing ? (
            <div style={{ padding: '28px 18px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-mid)' }}>
                {scope === 'thread' ? 'Nothing is running in this thread.' : 'Nothing is running in this conversation.'}
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>
                Subagents and workflows an agent starts show up here while they run, along with everything from its latest reply.
              </span>
            </div>
          ) : shown.map((group) => (
            <WorkGroup key={group.node.nodeId} group={group} showHeader={scope === 'thread'} expandedKey={expandedKey} onToggle={onToggle} openFolds={openFolds} onSetFold={onSetFold} />
          ))}
        </div>
      </div>
    </DrawerShell>
  );
}
