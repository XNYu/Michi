import React, { useCallback, useRef, useState } from 'react';
import { useNodesSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import {
  describeRunningWork,
  sameBackgroundWorkIndicator,
  selectBackgroundWorkIndicator,
  type BackgroundWorkIndicator,
} from '../../../state/backgroundWork';
import { useBackgroundSubagentLiveness, useWorkflowRunsForNodes } from '../../../state/workflowDomain';
import { HeaderTooltip } from '../WorkspaceMenuButton';
import { openBackgroundWork } from './backgroundWorkEvents';

/**
 * What the top-bar button shows for the open panes (selectBackgroundWorkIndicator).
 * Stream chunks do not re-render the caller: the value stays the same object
 * until the conversation, a count or the waiting state changes.
 */
export function useBackgroundWorkIndicator(
  paneIds: readonly string[],
  paneItems: Readonly<Record<string, unknown>>,
  focusedId: string | null | undefined,
): BackgroundWorkIndicator | null {
  const chatPanes = useStableChatPanes(paneIds, paneItems);
  const runs = useWorkflowRunsForNodes(chatPanes);
  const liveness = useBackgroundSubagentLiveness();
  const select = useCallback(
    (nodes: Record<string, ChatNodeState>) => selectBackgroundWorkIndicator(nodes, chatPanes, focusedId, runs, liveness),
    [chatPanes, focusedId, runs, liveness],
  );
  return useNodesSelector(select, sameBackgroundWorkIndicator);
}

/** Chat panes only (pane items are launchers, browsers, files…), as one array until they change. */
function useStableChatPanes(paneIds: readonly string[], paneItems: Readonly<Record<string, unknown>>): readonly string[] {
  const cache = useRef<readonly string[]>([]);
  const next = paneIds.filter((id) => !paneItems[id]);
  const prev = cache.current;
  if (next.length !== prev.length || next.some((id, index) => id !== prev[index])) cache.current = next;
  return cache.current;
}

/** The button's words: running counts, the approval it waits for, or what finished. */
export function backgroundWorkIndicatorLabel(indicator: BackgroundWorkIndicator): string {
  const running = describeRunningWork(indicator.running);
  if (running) return indicator.waiting ? `${running} · waiting for your approval` : running;
  return `${indicator.total} background ${indicator.total === 1 ? 'item' : 'items'} finished`;
}

/**
 * Top-right "◆ N" while open conversations have subagents or workflows:
 * violet and pulsing while work runs, amber while it waits for an
 * approval, muted once what the latest turn started has finished. Opens
 * the Background work drawer on that conversation; nothing when there is
 * no such work.
 */
export default function BackgroundWorkButton({
  paneIds,
  paneItems,
  focusedId,
}: {
  paneIds: readonly string[];
  paneItems: Readonly<Record<string, unknown>>;
  focusedId: string | null | undefined;
}) {
  const indicator = useBackgroundWorkIndicator(paneIds, paneItems, focusedId);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!indicator) return null;
  const runningCount = indicator.running.subagents + indicator.running.workflows;
  const state = indicator.waiting ? 'waiting' : runningCount > 0 ? 'running' : 'done';
  const label = backgroundWorkIndicatorLabel(indicator);
  const color = state === 'waiting' ? 'var(--term-select)'
    : state === 'running' ? 'var(--term-mauve)' : 'var(--term-faint)';
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="t-icon-btn"
        data-testid="topbar-background-work"
        data-state={state}
        aria-label={`${label}. Show background work`}
        aria-haspopup="dialog"
        onClick={() => openBackgroundWork({ nodeId: indicator.nodeId })}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 26,
          padding: '0 7px',
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-xs)',
          color: state === 'done' ? 'var(--term-faint)' : 'var(--term-fg)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        <span aria-hidden className={state === 'running' ? 'agent-glyph-run' : undefined} style={{ color, fontSize: 'var(--fs-2xs)' }}>◆</span>
        <span>{runningCount > 0 ? runningCount : indicator.total}</span>
      </button>
      {hover && <HeaderTooltip anchorRef={ref} label={label} />}
    </>
  );
}
