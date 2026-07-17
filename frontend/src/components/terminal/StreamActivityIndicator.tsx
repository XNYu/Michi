import React, { useEffect, useRef, useState } from 'react';
import type { ChatNodeState } from '../../state/chatTypes';
import type { PlanEntry } from '../../services/api';
import { isRunningStatus, isHiddenInternalTool } from './toolCallGrouping';

/**
 * Phase 1 "backend is working" indicator — runtime-agnostic.
 *
 * The stream pipe already carries every signal we need (thought/tool deltas,
 * heartbeats), but the UI only showed liveness in three narrow spots: the
 * in-bubble three-dot placeholder (brand-new turn only), the blinking answer
 * cursor (visible-text only), and a static tool chip. That leaves long silent
 * gaps — a 30s bash call, or extended thinking while thoughts are collapsed —
 * looking frozen. This row fills exactly those gaps by deriving a descriptive
 * label from existing node state. No new stream event required.
 *
 * Deliberately returns null while visible answer text is streaming (the cursor
 * already shows that), while the turn is brand-new and empty (MessageBlock's
 * ThinkingIndicator owns that), and while Kiro subagents are working
 * (SubagentStatus renders richer per-agent detail).
 */

export interface StreamActivity {
  /** Short human label, e.g. "Thinking", "Running bash", "Working". */
  label: string;
  /**
   * Optional leading qualifier rendered before the label, e.g. "Step 3/7".
   * Kiro-only (derived from plan entries); Claude never emits a plan so this
   * stays undefined and the row degrades to the Phase 1 label alone.
   */
  detail?: string;
}

const MAX_TOOL_TITLE = 48;
const MAX_PLAN_STEP = 48;

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Derive a "Step N/M · <content>" activity from a Kiro plan. Returns null when
 * there's no plan, no in-progress entry, or the entries are malformed. The
 * step number is the 1-based position of the in-progress entry within the full
 * list (not a count of completed), matching how the plan reads top-to-bottom.
 */
function planStepActivity(plan: PlanEntry[] | undefined): StreamActivity | null {
  if (!plan || plan.length === 0) return null;
  const idx = plan.findIndex((e) => e.status === 'in_progress');
  if (idx < 0) return null;
  const entry = plan[idx];
  const content = entry.content?.trim();
  return {
    detail: `Step ${idx + 1}/${plan.length}`,
    label: content ? truncate(content, MAX_PLAN_STEP) : 'Working',
  };
}

/**
 * Pure label derivation. Returns null when no standalone row should render.
 * Exported for unit testing — keep it free of React/timing concerns.
 */
export function deriveStreamActivity(node: ChatNodeState): StreamActivity | null {
  if (node.status !== 'streaming') return null;

  // Kiro subagents get a dedicated, richer panel (SubagentStatus). Don't
  // double up while any of them are working.
  if (node.subagents?.some((s) => s.status === 'working')) return null;

  const last = node.messages[node.messages.length - 1];
  if (!last || last.role !== 'assistant') return { label: 'Working' };

  // Brand-new turn with no output yet → MessageBlock's in-bubble dots own this.
  const blocks = last.blocks ?? [];
  const hasNothingYet =
    blocks.length === 0 && !last.text && !last.thought && last.toolCalls.length === 0;
  if (hasNothingYet) return null;

  // A tool actively executing is the most common silent gap (long bash / MCP
  // call). Name it so the user sees what's churning. Most immediate signal,
  // so it outranks the plan step below.
  const runningTool = [...last.toolCalls].reverse().find((t) => isRunningStatus(t.status) && !isHiddenInternalTool(t.title));
  if (runningTool) {
    return {
      label: runningTool.title ? `Running ${truncate(runningTool.title, MAX_TOOL_TITLE)}` : 'Running tool',
    };
  }

  // While visible answer text streams, the blinking cursor already conveys
  // liveness — stay quiet regardless of plan state. However, if the stream has
  // gone idle for over 2s (e.g. kiro-cli writing a file without emitting a
  // tool_call running event), fall through so the user sees "Working" dots.
  const tail = blocks[blocks.length - 1];
  if (tail?.kind === 'answer' && tail.streaming) {
    const idle = node.streamingIdleMs ?? 0;
    if (idle < 2000) return null;
    // Fall through — cursor hasn't moved in 2s, show activity indicator.
  }

  // Kiro plan progress: richer than the bare Thinking/Working fallbacks, so it
  // takes over once no tool is running and no answer is streaming. Claude never
  // emits a plan, so it falls straight through to the fallbacks below.
  const planStep = planStepActivity(last.plan);
  if (planStep) return planStep;

  // Tail block tells us what the model is mid-producing.
  if (tail?.kind === 'thinking' && tail.streaming) return { label: 'Thinking' };

  // Blocks exist but nothing is actively streaming and no tool is running:
  // a real between-steps gap (e.g. extended thinking with thoughts collapsed,
  // or the model deciding its next move). This is the case that read as frozen.
  return { label: 'Working' };
}

/** Only surface an elapsed counter once a turn has run long enough to matter. */
const ELAPSED_GRACE_MS = 3000;

function StreamActivityIndicatorInner({ node }: { node: ChatNodeState }) {
  const activity = deriveStreamActivity(node);

  // Elapsed ticker. Seeded from the store's streamingStartedAt so the timer
  // survives unmount/remount cycles (e.g. switching threads and back). Falls
  // back to mount-time if the field is somehow missing. The 1s setState
  // re-renders only this row — never the message list.
  const startRef = useRef<number>(node.streamingStartedAt ?? Date.now());
  if (node.streamingStartedAt && node.streamingStartedAt !== startRef.current) {
    startRef.current = node.streamingStartedAt;
  }
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startRef.current);
  const isStreaming = node.status === 'streaming';
  useEffect(() => {
    // Only tick while the turn is actually streaming. The component stays
    // mounted across label flips within a turn (and renders null when idle),
    // but once the node goes idle/error there is nothing to count — leaving the
    // 1Hz setState running on every idle pane that ever streamed was pure
    // wasted re-render churn.
    if (!isStreaming) return;
    setElapsedMs(Date.now() - startRef.current);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, 1000);
    return () => window.clearInterval(id);
  }, [node.streamingStartedAt, isStreaming]);

  // Render nothing (but stay mounted, preserving the timer across label flips
  // within a turn) when there's no standalone activity to show.
  if (!activity) return null;

  const seconds = Math.floor(elapsedMs / 1000);
  const showElapsed = elapsedMs >= ELAPSED_GRACE_MS;

  const ariaLabel =
    `${activity.detail ? `${activity.detail}, ` : ''}${activity.label}` +
    `${showElapsed ? `, ${seconds} seconds elapsed` : ''}`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '8px 0',
        fontSize: 11,
        fontFamily: 'var(--ui-font)',
        color: 'var(--term-muted)',
        animation: 'fadeIn .3s ease',
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center' }}>
        <span className="typing-dot" />
        <span className="typing-dot" style={{ animationDelay: '.15s' }} />
        <span className="typing-dot" style={{ animationDelay: '.3s' }} />
      </span>
      {activity.detail && (
        <span style={{ color: 'var(--term-accent)', fontVariantNumeric: 'tabular-nums' }}>
          {activity.detail}
        </span>
      )}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activity.label}
      </span>
      {showElapsed && (
        <span style={{ marginLeft: 'auto', color: 'var(--term-faint)', fontVariantNumeric: 'tabular-nums' }}>
          {seconds}s
        </span>
      )}
    </div>
  );
}

/**
 * Memoized so unrelated parent re-renders (e.g. sibling message churn) don't
 * reset the elapsed ticker. Re-renders only when the fields the label depends
 * on change, plus its own 1s internal tick.
 */
export const StreamActivityIndicator = React.memo(StreamActivityIndicatorInner);
