import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workflowProgress } from 'michi-shared';
import { DrawerShell, type DrawerShellProps } from '../../ui/DrawerShell';
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
 * `selectBackgroundWork`.
 */

type Scope = 'conversation' | 'thread';

const MONO = 'var(--font-mono)';
const DRAWER_WIDTH = 640;

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

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
}

interface WorkGroupValue {
  node: ChatNodeState;
  title: string;
  loading: boolean;
  current: boolean;
  work: BackgroundWork;
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
  return (
    <div data-testid="background-subagent-row" data-background-work-key={rowKey} data-subagent-id={subagent.sessionId} data-active={active ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? subagentDetailDomId(subagent) : undefined}
        aria-label={`${name}, ${SUBAGENT_TONE_LABEL[tone]}${summary ? `: ${summary.text}` : ''}`}
        onClick={() => onToggle(rowKey)}
        className="t-hover-bg-alt"
        style={rowButton}
      >
        <StatusDot color={SUBAGENT_TONE_COLOR[tone]} live={active} />
        <span style={{ ...ellipsis, flexShrink: 0, maxWidth: '35%', fontSize: 'var(--fs-sm)', fontWeight: 600, color: tone === 'failed' ? 'var(--term-danger)' : 'var(--term-fg)' }}>{name}</span>
        {summary ? <SubagentSummaryText summary={summary} /> : <span style={{ flex: 1 }} />}
        <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
          <SubagentDuration subagent={subagent} active={active} />
          {tools > 0 && <span>{tools} {tools === 1 ? 'tool' : 'tools'}</span>}
        </span>
        <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: SUBAGENT_TONE_COLOR[tone] }}>{SUBAGENT_TONE_LABEL[tone]}</span>
        <Chevron open={expanded} />
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
  if (!resource) return null;
  const run = resource.value;
  const live = run.status === 'running' || run.status === 'paused';
  const progress = workflowProgress(run);
  const now = workflowNowLine(run);
  const finished = live ? undefined : firstPlainLine(run.result) ?? firstPlainLine(run.statusDetail);
  const approvals = run.approvals?.length ?? 0;
  const color = WORKFLOW_STATUS_COLOR[run.status];
  return (
    <div data-testid="background-workflow-row" data-background-work-key={rowKey} data-run-key={runKey} data-active={live ? 'true' : undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Workflow ${run.name}, ${WORKFLOW_STATUS_LABEL[run.status]}${approvals > 0 ? ', needs approval' : ''}`}
        onClick={() => onToggle(rowKey)}
        className="t-hover-bg-alt"
        style={rowButton}
      >
        <StatusDot color={color} live={run.status === 'running'} />
        <span aria-hidden style={{ flexShrink: 0, color: 'var(--term-mauve)', fontSize: 'var(--fs-xs)' }}>⧉</span>
        <span style={{ ...ellipsis, flexShrink: 0, maxWidth: '35%', fontSize: 'var(--fs-sm)', fontWeight: 600, color: run.status === 'failed' ? 'var(--term-danger)' : 'var(--term-fg)' }}>{run.name}</span>
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
        {approvals > 0 && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-select)' }}>needs approval</span>}
        {progress.total > 0 && (
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
            {progress.done}/{progress.total} {run.runtime === 'claude' ? 'agents' : 'steps'}
          </span>
        )}
        <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color }}>{WORKFLOW_STATUS_LABEL[run.status]}</span>
        <Chevron open={expanded} />
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

function WorkGroup({ group, showHeader, expandedKey, onToggle }: {
  group: WorkGroupValue;
  showHeader: boolean;
  expandedKey: string | null;
  onToggle: (key: string) => void;
}) {
  const { node, work, loading } = group;
  const subagentsRunning = work.subagents.filter((item) => item.active).length;
  const workflowsRunning = work.workflows.filter((item) => item.active).length;
  const empty = work.subagents.length === 0 && work.workflows.length === 0;
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
        <>
          <SectionLabel label="subagents" total={work.subagents.length} running={subagentsRunning} />
          {work.subagents.map((item) => {
            const key = itemKey(node.nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId });
            return (
              <SubagentWorkRow key={key} subagent={item.subagent} active={item.active} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />
            );
          })}
        </>
      )}
      {work.workflows.length > 0 && (
        <>
          <SectionLabel label="workflows" total={work.workflows.length} running={workflowsRunning} />
          {work.workflows.map((item) => {
            const key = itemKey(node.nodeId, { kind: 'workflow', runKey: item.runKey });
            return <WorkflowWorkRow key={key} runKey={item.runKey} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />;
          })}
        </>
      )}
    </section>
  );
}

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'conversation', label: 'This conversation' },
  { value: 'thread', label: 'Whole thread' },
];

function ScopeSwitch({ scope, onChange }: { scope: Scope; onChange: (scope: Scope) => void }) {
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
              padding: '3px 10px',
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
  const [appliedSeq, setAppliedSeq] = useState(requestSeq);
  if (appliedSeq !== requestSeq) {
    // A new open request: back to its conversation, its focus expanded.
    setAppliedSeq(requestSeq);
    setScope('conversation');
    setExpandedKey(focusKey);
  }

  // The history rule applies when the drawer opens: what it has listed since
  // the current request stays listed while it stays open, so an item the
  // user reads does not vanish the moment it finishes, nor when the scope
  // switches and back (items are per conversation; keepByNode applies them
  // only to the conversations listed). A ref, not state: recording what was
  // listed must not re-render.
  const stickyToken = requestSeq;
  const sticky = useRef<StickyItems>({ token: stickyToken, items: new Map() });
  if (sticky.current.token !== stickyToken) sticky.current = { token: stickyToken, items: new Map() };

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
    const kept: ListedItem[] = sticky.current.token === stickyToken ? [...sticky.current.items.values()] : [];
    if (requestFocus) kept.push({ nodeId: requestNodeId, focus: requestFocus });
    const expanded = expandedKey ? parseItemKey(expandedKey) : null;
    if (expanded) kept.push(expanded);
    const keep = keepByNode(kept);
    return nodes.map((node) => ({
      node,
      title: node.title || chatLabel(node),
      loading: node.messagesLoaded === false,
      current: node.nodeId === requestNodeId,
      work: selectBackgroundWork(node, runs, keep.get(node.nodeId), liveness(node.projectId, node.nodeId)),
    }));
  }, [nodes, runs, liveness, requestFocus, requestNodeId, expandedKey, stickyToken]);
  useEffect(() => {
    const current = sticky.current;
    if (current.token !== stickyToken) return;
    for (const { node, work } of groups) {
      for (const item of work.subagents) {
        const focus: BackgroundWorkFocus = { kind: 'subagent', sessionId: item.subagent.sessionId };
        current.items.set(itemKey(node.nodeId, focus), { nodeId: node.nodeId, focus });
      }
      for (const item of work.workflows) {
        const focus: BackgroundWorkFocus = { kind: 'workflow', runKey: item.runKey };
        current.items.set(itemKey(node.nodeId, focus), { nodeId: node.nodeId, focus });
      }
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--term-line)', minWidth: 0 }}>
        <ScopeSwitch scope={scope} onChange={setScope} />
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
          <WorkGroup key={group.node.nodeId} group={group} showHeader={scope === 'thread'} expandedKey={expandedKey} onToggle={onToggle} />
        ))}
      </div>
    </DrawerShell>
  );
}
