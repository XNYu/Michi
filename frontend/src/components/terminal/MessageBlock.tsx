import type { DurableUserInput, UsageCharge } from 'michi-shared';
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, PresenceContext, animate, motion, useIsPresent, useReducedMotionConfig, type Variants } from 'motion/react';
import { DUR, EASE, SPRING, TRANSITION } from '../../motion/tokens';
import { AssistantBlock, ChatMessage, ToolCallState, SubagentInfo, UserInputRequest } from '../../state/chatTypes';
import { turnErrorAction } from '../../state/turnErrorRecovery';
import { isRunningStatus, isHiddenInternalTool, formatDurationMs, toolSpanMs, summarizeWork } from './toolCallGrouping';
import { activityWindow, activityWindowMs } from './agentBlockTiming';
import { ToolCallGroup } from './ToolCallGroup';
import { PageReceipt } from './PageReceipt';
import { type TerminalDensity, useAgentBlockStyle } from '../../state/prefs';
import { CardSpinner, SparkleIcon, LiveTimerLabel } from './AgentBlockVariants';
import type { PlanEntry } from '../../services/api';
import MarkdownContent from '../MarkdownContent';
import { QuoteChip } from './QuoteChip';
import { AttachmentPills } from './AttachmentPills';
import { CommentChips } from './CommentChips';
import {
  carryEqual,
  isClusterableAnswerRun,
  sameBlockRefs,
  sameToolRefs,
  splitAssistantRuns,
  thinkingRunRawText,
  useAnswerRunStream,
  useVisibleStream,
  type AssistantRun,
  type SentinelCarry,
} from '../../state/streamingProjection';
import { hasAssistantBlocks } from '../../state/assistantBlocks';
import type { ChildAnchor } from '../../state/branchAnchors';
import { ANCHOR_GROW_FROM, ANCHOR_GROW_STYLE, ANCHOR_GROW_TO, BranchAnchorRow } from './BranchAnchorRow';
import { isFresh } from '../../motion/useFresh';
import { BranchQuoteMarks } from './BranchQuoteMarks';
import { ImageBlockView } from './ImageBlockView';
import { SteeringReports } from './SteeringReports';
import { streamingMarkdownBlocksEnabled } from './streamingMarkdownBlocksFlag';
import UserInputBanner, { ResolvedUserInput } from './UserInputBanner';
import { useChatActions } from '../../state/chatStore';
import { BranchIcon, CheckIcon, CopyIcon, EditIcon, RetryIcon } from './icons';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import { playFlight } from './messageFlight';

const StreamingMarkdownContent = React.lazy(() => import('./StreamingMarkdownContent'));

/**
 * Context providing the current node's pendingUserInput so that inline
 * user-input segments can render without prop-drilling through memoized layers.
 */
export interface NodeUserInputContextValue {
  userInput: UserInputRequest | null | undefined;
  nodeId: string;
}

export const NodeUserInputContext = createContext<NodeUserInputContextValue | null>(null);

/** Renders a user-input segment inline within the weave pipeline. */
function InlineUserInputSegment({ requestId, interaction }: { requestId: number; interaction?: DurableUserInput }) {
  const ctx = useContext(NodeUserInputContext);
  const current = ctx?.userInput;
  const matchesCurrent = current?.requestId === requestId && (!interaction || !current.interactionId || current.interactionId === interaction.interactionId);
  const ui: UserInputRequest | undefined = interaction
    ? { ...interaction, resolved: interaction.status !== 'pending', interrupted: interaction.status === 'interrupted', receivedAt: matchesCurrent ? current?.receivedAt : undefined }
    : matchesCurrent ? current : undefined;
  if (!ui) return null;
  if (ui.resolved) return <ResolvedUserInput userInput={ui} />;
  if (!matchesCurrent || !ctx) return <UserInputBanner userInput={ui} readOnly onSubmit={() => {}} onSkip={() => {}} />;
  return <ActiveUserInputSegment userInput={ui} nodeId={ctx.nodeId} />;
}

function ActiveUserInputSegment({ userInput, nodeId }: { userInput: UserInputRequest; nodeId: string }) {
  const { resolveUserInputRequest, skipUserInputRequest } = useChatActions();
  return <UserInputBanner userInput={userInput}
    onSubmit={(answers) => resolveUserInputRequest(nodeId, answers)}
    onSkip={() => skipUserInputRequest(nodeId)} />;
}

function formatMessageTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export interface TurnUsageInfo {
  durationMs?: number;
  credits?: number;
  charge?: UsageCharge;
  unverifiable?: boolean;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  contextUsagePercentage?: number;
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString('en-US');
  if (value < 1_000_000) {
    const compact = value / 1_000;
    const label = compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, '');
    if (label === '1000') return '1m';
    return `${label}k`;
  }
  const compact = value / 1_000_000;
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, '')}m`;
}

function usageLabel(usage: TurnUsageInfo): string {
  const duration = usage.durationMs === undefined ? '' : ` · ${(usage.durationMs / 1000).toFixed(1)}s`;
  if (usage.unverifiable) return `usage unverifiable${duration}`;
  if (usage.totalTokens !== undefined) {
    const breakdown = usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? ` (${formatTokenCount(usage.inputTokens ?? 0)} in / ${formatTokenCount(usage.outputTokens ?? 0)} out)`
      : '';
    return `usage ${formatTokenCount(usage.totalTokens)} tokens${breakdown}${duration}`;
  }
  if (usage.charge) {
    const estimate = usage.charge.provenance === 'sdk_estimate' || usage.charge.provenance === 'catalog_estimate' ? 'estimated ' : '';
    return `usage ${estimate}${usage.charge.amount.toFixed(usage.charge.unit === 'USD' ? 4 : 2)} ${usage.charge.unit}${duration}`;
  }
  if (usage.credits !== undefined) return `usage ${usage.credits.toFixed(2)} credits${duration}`;
  return `usage${duration}`;
}

function usageTitle(usage: TurnUsageInfo): string {
  const details = usage.durationMs === undefined ? [] : [`Duration ${(usage.durationMs / 1000).toFixed(1)} seconds`];
  if (usage.charge) details.push(`${usage.charge.amount} ${usage.charge.unit} (${usage.charge.provenance.replaceAll('_', ' ')})`);
  if (usage.totalTokens !== undefined) details.push(`${Math.round(usage.totalTokens).toLocaleString('en-US')} total tokens`);
  if (usage.inputTokens !== undefined) details.push(`${Math.round(usage.inputTokens).toLocaleString('en-US')} input tokens`);
  if (usage.cachedInputTokens !== undefined && usage.cachedInputTokens > 0) {
    details.push(`${Math.round(usage.cachedInputTokens).toLocaleString('en-US')} cached input tokens`);
  }
  if (usage.outputTokens !== undefined) details.push(`${Math.round(usage.outputTokens).toLocaleString('en-US')} output tokens`);
  if (usage.reasoningOutputTokens !== undefined && usage.reasoningOutputTokens > 0) {
    details.push(`${Math.round(usage.reasoningOutputTokens).toLocaleString('en-US')} reasoning tokens`);
  }
  if (usage.contextUsagePercentage !== undefined) {
    details.push(`${usage.contextUsagePercentage.toFixed(1)}% context used`);
  }
  return details.join(', ');
}

function MessageActions({
  visible,
  time,
  onCopy,
  onRetry,
  onEdit,
  onBranch,
  usageInfo,
}: {
  visible: boolean;
  time: string;
  onCopy: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
  usageInfo?: TurnUsageInfo | null;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const btnStyle: React.CSSProperties = {
    color: 'var(--term-muted)',
  };
  const hasUsage = !!usageInfo;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 4,
        paddingLeft: 0,
      }}
    >
      <div
        className="t-msg-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          opacity: visible ? 1 : 0,
          transition: 'opacity var(--t-soft) ease-out',
          pointerEvents: visible ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleCopy(); }}
          className="t-icon-btn"
          style={btnStyle}
          title="copy message"
          aria-label="copy message"
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="retry this turn"
            aria-label="retry this turn"
          >
            <RetryIcon size={13} />
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="edit and resend"
            aria-label="edit and resend"
          >
            <EditIcon size={13} />
          </button>
        )}
        {onBranch && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onBranch(); }}
            className="t-icon-btn"
            style={btnStyle}
            title="branch from here"
            aria-label="branch from here"
          >
            <BranchIcon size={13} />
          </button>
        )}
        {time && (
          <span
            style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--ui-font)', color: 'var(--term-muted)', marginLeft: 4 }}
          >
            {time}
          </span>
        )}
      </div>
      {hasUsage && (
        <span
          data-testid="turn-usage"
          title={usageTitle(usageInfo)}
          style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)' }}
        >
          {usageLabel(usageInfo)}
        </span>
      )}
    </div>
  );
}

function TermPlanBlock({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ borderLeft: '2px solid var(--term-muted)', paddingLeft: 8, marginBottom: 8, fontSize: 'var(--fs-sm)' }}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', letterSpacing: 'var(--ls-caps-wide)', marginBottom: 4, fontFamily: 'var(--ui-font)' }}>
        PLAN
      </div>
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, lineHeight: 1.5, color: e.status === 'completed' ? 'var(--term-muted)' : 'var(--term-fg)' }}>
          <span style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', flexShrink: 0 }}>
            {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'}
          </span>
          <span style={{ textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

// Tail-mode height cap: ~10 lines at line-height 1.5, font-size 11px.
const THOUGHT_TAIL_MAX_HEIGHT = 10 * 11 * 1.5;

type ThoughtMode = 'tail' | 'expanded' | 'collapsed';

/* ── Motion (motion.dev) ──
   Only what arrives while a message is on screen animates: everything a
   MessageBlock renders on its first commit (hydration, lazy loads, remounts)
   is settled. Streamed Markdown never animates and loops stay in CSS. */

interface MessageMotionScope {
  /** True once the message has committed; blocks mounting later are new. */
  mounted: { current: boolean };
  /** The pending dots' height while they show, so the block replacing them
   *  grows from there. Cleared once they hide. */
  pendingHeight: { current: number | null };
}

const MessageMotionContext = createContext<MessageMotionScope | null>(null);

/** Where a block grows from (px) when it arrives live, or null to render it
 *  settled. Decided on the block's first render. */
function useBlockEntrance(live: boolean | undefined): number | null {
  const scope = useContext(MessageMotionContext);
  const [from] = useState(() => (live && scope?.mounted.current ? scope.pendingHeight.current ?? 0 : null));
  return from;
}

const ICON_SWAP: Variants = {
  enter: { opacity: 0, scale: 0.5 },
  shown: { opacity: 1, scale: 1, transition: SPRING.snappy },
  leave: { opacity: 0, scale: 0.5, transition: { duration: 0.1 } },
};

const LABEL_SWAP: Variants = {
  enter: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.18, delay: 0.03, ease: EASE.out } },
  leave: { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE.out } },
};

/** One state of a SwapSlot. A leaving state is no longer announced or clickable. */
function SwapItem({ variants, as, style, children }: {
  variants: Variants;
  as: 'span' | 'div';
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const present = useIsPresent();
  const itemStyle: React.CSSProperties = {
    gridArea: '1 / 1',
    minWidth: 0,
    pointerEvents: present ? undefined : 'none',
    ...style,
  };
  return as === 'div' ? (
    <motion.div variants={variants} initial="enter" animate="shown" exit="leave" aria-hidden={present ? undefined : true} style={itemStyle}>
      {children}
    </motion.div>
  ) : (
    <motion.span variants={variants} initial="enter" animate="shown" exit="leave" aria-hidden={present ? undefined : true} style={itemStyle}>
      {children}
    </motion.span>
  );
}

/**
 * Shows one of several states in a single grid cell, so a new `swapKey`
 * cross-fades in place: the old state leaves while the new one arrives.
 * Present on the first render, a state appears settled.
 */
function SwapSlot({ swapKey, variants, as = 'span', style, children }: {
  swapKey: string;
  variants: Variants;
  as?: 'span' | 'div';
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const content = (
    <AnimatePresence initial={false}>
      <SwapItem key={swapKey} variants={variants} as={as}>{children}</SwapItem>
    </AnimatePresence>
  );
  return as === 'div'
    ? <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', ...style }}>{content}</div>
    : <span style={{ display: 'inline-grid', ...style }}>{content}</span>;
}

/** Disclosure chevron: one ▸ that turns to point down while open. */
function Chevron({ open, style }: { open: boolean; style?: React.CSSProperties }) {
  return (
    <motion.span
      aria-hidden
      initial={false}
      animate={{ rotate: open ? 90 : 0 }}
      transition={SPRING.snappy}
      style={{ display: 'inline-block', fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)', flexShrink: 0, ...style }}
    >
      ▸
    </motion.span>
  );
}

/** Why a thought body hides: the block finishing, or the user collapsing it. */
type ThoughtBodyExit = 'finish' | 'collapse';

const THOUGHT_BODY_REVEAL: Variants = {
  // Clip only while the height moves: a settled body (also one present at
  // mount, which skips straight to here) keeps its focus ring.
  open: { height: 'auto', opacity: 1, transition: TRANSITION.expand, transitionEnd: { overflow: 'visible' } },
  closed: (exit: ThoughtBodyExit) => ({
    height: 0,
    opacity: 0,
    overflow: 'hidden',
    transition: exit === 'finish' ? { duration: 0.22, ease: EASE.drawer } : TRANSITION.collapse,
  }),
};

// From 1px, not 0: a click that opens the body changes the transcript height
// in the click's own frame, which is how TPane leaves follow mode.
const THOUGHT_BODY_FROM = { height: 1, opacity: 0, overflow: 'hidden' } as const;

/** A thought block's body: opens and closes by height, reversing in place
 *  when toggled mid-way. Rendered settled when present with its block. While
 *  it leaves it is out of the accessibility tree and inert. */
function ThoughtBodyReveal({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      variants={THOUGHT_BODY_REVEAL}
      initial={THOUGHT_BODY_FROM}
      animate="open"
      exit="closed"
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      {children}
    </motion.div>
  );
}

const BLOCK_GROW = { duration: 0.2, ease: EASE.out } as const;
const BLOCK_FADE = { duration: 0.12, ease: 'linear' } as const;

/**
 * Grows `ref` from `from` px to its natural height (200ms ease-out), then
 * releases it. The natural height is measured every frame, so content
 * streaming in meanwhile is neither clipped nor snapped to, and a block that
 * finishes (shrinks) mid-grow is followed down. Hand-written, so it skips
 * itself under reduced motion; the fade stays on the motion root.
 */
function useGrowFrom(ref: React.RefObject<HTMLElement | null>, from: number | null, ready: boolean) {
  const reduce = useReducedMotionConfig();
  useLayoutEffect(() => {
    const el = ref.current;
    if (from === null || !ready || reduce || !el) return;
    let done = false;
    const release = () => {
      done = true;
      el.style.height = '';
      el.style.overflow = '';
    };
    el.style.overflow = 'hidden';
    el.style.height = `${from}px`;
    const controls = animate(0, 1, {
      ...BLOCK_GROW,
      onUpdate: (progress) => {
        // A skipped animation can report its last frame after completing.
        if (done) return;
        if (progress >= 1) return release();
        el.style.height = '';
        const to = el.offsetHeight;
        el.style.height = `${from + (to - from) * progress}px`;
      },
      onComplete: release,
    });
    return () => {
      controls.stop();
      release();
    };
  }, [ref, from, ready, reduce]);
}

interface ThoughtHeaderBase {
  streaming: boolean;
  phase?: StreamPhase;
  /** The body is expanded: the chevron points down. */
  open: boolean;
  /** Stable across streamed chunks, so the memoized header skips them. */
  onToggle: () => void;
}

// Headers re-render on state changes only (live ↔ done, phase, open), never
// per streamed thought chunk. Done-state text is passed only once finished.

const CardThoughtHeader = React.memo(function CardThoughtHeader({
  streaming, phase, open, onToggle, startedAt, clockKey, workText, workFailed, durText, base, suffix,
}: ThoughtHeaderBase & {
  startedAt?: number;
  clockKey?: string;
  /** Finished with tools: what it did, failures, duration at the right. */
  workText?: string;
  workFailed?: number;
  durText?: string;
  /** Finished otherwise: "Thought for 4s" and its "· 3 steps" suffix. */
  base?: string;
  suffix?: string;
}) {
  // Finishing swaps the header in place: spinner → sparkle by scale, the live
  // label up and out as the summary rises in.
  return (
    <div
      onClick={onToggle}
      className="t-hover-fg"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 11px',
        cursor: 'pointer',
        userSelect: 'none',
        color: 'var(--term-muted)',
      }}
    >
      <SwapSlot swapKey={streaming ? 'spinner' : 'sparkle'} variants={ICON_SWAP} style={{ flexShrink: 0, placeItems: 'center' }}>
        {streaming ? <CardSpinner /> : <SparkleIcon size={13} color="var(--term-muted)" />}
      </SwapSlot>
      <SwapSlot as="div" swapKey={streaming ? 'live' : 'done'} variants={LABEL_SWAP} style={{ flex: 1, minWidth: 0 }}>
        {streaming ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="term-shimmer" style={{ fontSize: 'var(--fs-md)', fontWeight: 500 }}>
              {phase === 'working' ? 'Working…' : 'Thinking…'}
            </span>
            <LiveTimerLabel active={streaming} startedAt={startedAt} clockKey={clockKey} />
          </span>
        ) : workText ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              title={workText}
              style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--term-mid)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {workText}
            </span>
            {!!workFailed && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-danger)', flexShrink: 0 }}>
                · {workFailed} failed
              </span>
            )}
            <span style={{ marginLeft: 'auto', paddingLeft: 4, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {durText}
            </span>
            <Chevron open={open} />
          </span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--term-mid)' }}>{base}</span>
            {suffix && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{suffix}</span>}
            <Chevron open={open} style={{ marginLeft: 'auto' }} />
          </span>
        )}
      </SwapSlot>
    </div>
  );
});

const TerminalThoughtHeader = React.memo(function TerminalThoughtHeader({
  streaming, phase, open, onToggle, hasTools, rightMeta,
}: ThoughtHeaderBase & { hasTools?: boolean; rightMeta?: string }) {
  return (
    <SwapSlot as="div" swapKey={streaming ? 'live' : 'done'} variants={LABEL_SWAP}>
      {streaming ? (
        <div
          onClick={onToggle}
          style={{ display: 'flex', alignItems: 'baseline', gap: 7, cursor: 'pointer', userSelect: 'none', color: 'var(--term-muted)' }}
        >
          <span aria-hidden style={{ fontFamily: 'var(--font-mono)', color: 'var(--term-accent)', fontSize: 'var(--fs-sm)', flexShrink: 0 }}>❯</span>
          <span className="term-shimmer">{phase === 'working' ? 'working' : 'thinking'}</span>
          <span aria-hidden className="agent-caret" />
        </div>
      ) : (
        <div
          onClick={onToggle}
          className="t-hover-fg"
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', color: 'var(--term-muted)' }}
        >
          <Chevron open={open} />
          <span style={{ fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', color: 'var(--term-muted)', fontWeight: 500, flexShrink: 0 }}>
            {hasTools ? 'working' : 'thinking'}
          </span>
          <span aria-hidden style={{ flex: 1, borderTop: '1px dotted var(--term-line)', transform: 'translateY(1px)' }} />
          {rightMeta && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', flexShrink: 0 }}>{rightMeta}</span>
          )}
        </div>
      )}
    </SwapSlot>
  );
});

const PlainThoughtHeader = React.memo(function PlainThoughtHeader({
  streaming, phase, open, onToggle, doneLabel,
}: ThoughtHeaderBase & { doneLabel?: string }) {
  // The live dot shows while streaming unless the body is open; otherwise the
  // chevron, which turns rather than swapping glyphs.
  const liveDot = streaming && !open;
  return (
    <div
      onClick={onToggle}
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'baseline',
        gap: 7,
        fontSize: 'var(--fs-sm)',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
        userSelect: 'none',
      }}
      className="t-hover-fg"
    >
      <SwapSlot
        swapKey={liveDot ? 'dot' : 'chevron'}
        variants={ICON_SWAP}
        style={{ width: 8, flexShrink: 0, alignSelf: liveDot ? 'center' : undefined }}
      >
        {liveDot ? (
          <span aria-hidden style={{ display: 'inline-flex' }}>
            <span className="term-dot-i term-dot-i--run" />
          </span>
        ) : (
          <Chevron open={open} />
        )}
      </SwapSlot>
      <SwapSlot swapKey={streaming ? 'live' : 'done'} variants={LABEL_SWAP}>
        {streaming
          ? <span className="term-shimmer">{phase === 'working' ? 'working' : 'thinking'}</span>
          : <span>{doneLabel}</span>}
      </SwapSlot>
    </div>
  );
});

/** Step-list renderer for Codex reasoning summaries (split by \n). */
/** Strip lightweight Markdown formatting (bold, italic, code) so step text renders as plain text. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

function CodexStepList({ text, streaming }: { text: string; streaming?: boolean }) {
  const parts = text.split('\n').filter((s) => s.trim().length > 0);
  if (parts.length === 0) return null;
  return (
    <div style={{ paddingLeft: 4, lineHeight: 1.7 }}>
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1;
        const done = !isLast || !streaming;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ opacity: done ? 0.5 : 1, fontSize: 'var(--fs-xs)' }}>
              {done ? '✓' : '●'}
            </span>
            <span style={{ opacity: done ? 0.7 : 1 }}>
              {stripInlineMarkdown(part)}
              {!done && (
                <span className="typing-dot" style={{ marginLeft: 2, animationDelay: '0s' }} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ephemeral thinking timer: stamps when `streaming` first turns true and
 * reports elapsed ms once it turns false. Hydrated (never-streaming) messages
 * return undefined — the label degrades to a duration-less form.
 */
function useThinkingTimer(streaming: boolean | undefined): number | undefined {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (streaming && startRef.current == null) {
      startRef.current = Date.now();
      return;
    }
    if (!streaming && startRef.current != null) {
      setElapsed((prev) => prev ?? Date.now() - startRef.current!);
    }
  }, [streaming]);
  return elapsed;
}

/** Interleaved thought-body content for merged agent clusters: thought prose
 *  chunks and tool groups in their original stream order. */
export type ThoughtSegment =
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'tools'; tools: ToolCallState[] };

export function TermThoughtBlock({
  text,
  streaming,
  phase,
  children,
  toolCount,
  runtimeId,
  durationMs,
  startedAt,
  endedAt,
  clockKey,
  segments,
  subagents,
  tools,
  initialMode,
}: {
  text: string;
  streaming?: boolean;
  phase?: StreamPhase;
  children?: React.ReactNode;
  toolCount?: number;
  runtimeId?: string | null;
  /** Fallback duration (e.g. tool-span of the run) for hydrated turns. */
  durationMs?: number;
  /** Durable activity window (backend clock, see agentBlockTiming). The live
   *  timer counts from `startedAt`, so remounts, reloads and other windows
   *  agree; with `endedAt` too it also gives the finished duration. */
  startedAt?: number;
  endedAt?: number;
  /** Backend clock key (the assistant message id) for the live timer. */
  clockKey?: string;
  /** When provided, the body renders these interleaved chunks instead of
   *  `text` + `children` (which are then only used for the header label). */
  segments?: readonly ThoughtSegment[];
  /** Roster for tool groups rendered from `segments`. */
  subagents?: readonly SubagentInfo[];
  /** Tools this block ran, for the card header's work summary. Defaults to
   *  the tools inside `segments`. */
  tools?: readonly ToolCallState[];
  /** Initial user-mode override — used by the dev specimen to show an
   *  expanded body statically. Live rendering leaves this unset. */
  initialMode?: ThoughtMode;
}) {
  // Default mode: tail while streaming, collapsed once finished.
  // User clicks cycle: tail/collapsed → expanded → (streaming ? tail : collapsed).
  const [userMode, setUserMode] = useState<ThoughtMode | null>(initialMode ?? null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const expandedStickyRef = useRef(true);
  const [expandedScrollable, setExpandedScrollable] = useState(false);
  const liveElapsed = useThinkingTimer(streaming);
  const variant = useAgentBlockStyle();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasContent = !!(text || children || segments?.length);
  // A block that starts streaming while its message is on screen grows in
  // (from the pending dots it replaces); one already there renders settled.
  const enterFrom = useBlockEntrance(streaming);
  useGrowFrom(rootRef, enterFrom, hasContent);

  // Once streaming flips false, drop any sticky 'tail' override so the block
  // auto-collapses to 0 rows. 'expanded' is preserved (user is reading).
  useEffect(() => {
    if (!streaming && userMode === 'tail') setUserMode(null);
  }, [streaming, userMode]);

  const mode: ThoughtMode = userMode ?? (streaming ? 'tail' : 'collapsed');
  const showBody = mode === 'tail' || mode === 'expanded';
  // The mode the body last showed in. A hiding tail is the block finishing;
  // a hiding expanded body is the user collapsing it.
  const shownModeRef = useRef<ThoughtMode>(mode);
  useLayoutEffect(() => {
    if (showBody) shownModeRef.current = mode;
  });
  const bodyExit: ThoughtBodyExit = shownModeRef.current === 'tail' ? 'finish' : 'collapse';

  // Stable while chunks stream (mode and streaming change rarely), so the
  // memoized headers skip them.
  const handleToggle = useCallback(() => {
    if (mode === 'expanded') {
      // Expanded → tail (still streaming) or collapsed (done).
      setUserMode(streaming ? 'tail' : 'collapsed');
    } else {
      // Tail or collapsed → expanded.
      expandedStickyRef.current = true;
      setUserMode('expanded');
    }
  }, [mode, streaming]);

  useLayoutEffect(() => {
    const el = expandedRef.current;
    if (mode !== 'expanded' || !el) return;
    const measure = () => setExpandedScrollable(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [mode, text, segments, children, variant]);

  // Pin tail-mode scroll to the bottom as new tokens arrive. `segments`
  // changes identity when cluster content grows (new tool rows), and the
  // plain variant passes its tool groups as `children`.
  useEffect(() => {
    if (mode === 'tail' && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
    if (mode === 'expanded' && streaming && expandedStickyRef.current && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [text, mode, streaming, segments, children]);

  // Tool rows and their headers grow in over several frames after the render
  // that added them, so a pin taken then lands short and the live row stays
  // below the tail. Re-pin whenever the content itself resizes.
  useEffect(() => {
    const content = contentRef.current;
    const viewport = mode === 'tail' ? tailRef.current : mode === 'expanded' && streaming ? expandedRef.current : null;
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (mode === 'expanded' && !expandedStickyRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [mode, streaming, hasContent]);

  if (!hasContent) return null;

  // Pure reasoning → "thought for 12s". Any tool activity → "worked for".
  // Duration is the durable activity window when the blocks carry it;
  // otherwise (legacy turns) the mount-scoped live timer when this block
  // streamed here, or the tool-span for hydrated turns.
  const hasTools = (toolCount ?? 0) > 0;
  const dur = activityWindowMs(startedAt, endedAt) ?? liveElapsed ?? durationMs;
  const codexStepCount = runtimeId === 'codex'
    ? text.split('\n').filter((s) => s.trim().length > 0).length
    : 0;
  const base = dur != null
    ? `${hasTools ? 'worked' : 'thought'} for ${formatDurationMs(dur)}`
    : (hasTools ? 'worked' : 'thoughts');
  const suffix = hasTools
    ? ` · ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`
    : codexStepCount > 0
      ? ` · ${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
      : '';
  const doneLabel = `${base}${suffix}`;

  const thoughtProse = (chunk: string, chunkStreaming: boolean | undefined, key?: string) =>
    runtimeId === 'codex' ? (
      <CodexStepList key={key} text={chunk} streaming={chunkStreaming} />
    ) : (
      <MarkdownContent
        key={key}
        text={chunk}
        size="xs"
        style={thoughtProseVars}
        className="[&_a]:underline"
      />
    );

  const lastTextSegKey = segments
    ? [...segments].reverse().find((s) => s.kind === 'text')?.key
    : undefined;

  const bodyContent = segments ? (
    segments.map((seg) =>
      seg.kind === 'text' ? (
        thoughtProse(seg.text, streaming && seg.key === lastTextSegKey, seg.key)
      ) : (
        <ToolCallGroup
          key={seg.key}
          tools={seg.tools}
          defaultExpanded={seg.tools.some((t) => isRunningStatus(t.status))}
          subagents={subagents}
          receipts={false}
        />
      ),
    )
  ) : (
    <>
      {text ? thoughtProse(text, streaming) : null}
      {children}
    </>
  );

  const body = (ref: React.Ref<HTMLDivElement>, tail: boolean, chrome?: React.CSSProperties) => (
    <div
      ref={ref}
      tabIndex={!tail && expandedScrollable ? 0 : undefined}
      role={!tail && expandedScrollable ? 'region' : undefined}
      aria-label={!tail && expandedScrollable ? 'Activity details' : undefined}
      onScroll={tail ? undefined : (event) => {
        const el = event.currentTarget;
        // Nested tool lists also scroll; only this activity viewport controls
        // whether newly streamed content follows the bottom.
        if (event.target !== el) return;
        expandedStickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      style={{
        ...(chrome ?? {
          paddingLeft: 10,
          marginLeft: 2,
          borderLeft: '1px solid var(--term-line)',
          color: 'var(--term-muted)',
          lineHeight: 1.55,
          marginTop: 4,
        }),
        ...(tail ? { maxHeight: THOUGHT_TAIL_MAX_HEIGHT, overflow: 'hidden' } : null),
        ...(!tail ? { maxHeight: 'min(60vh, 480px)', overflowY: 'auto' } : null),
      }}
    >
      {/* Measured by the tail pin: its height tracks the content, uncapped. */}
      <div ref={contentRef}>{bodyContent}</div>
    </div>
  );

  const bodyRef = mode === 'tail' ? tailRef : expandedRef;
  const open = mode === 'expanded';
  const live = !!streaming;

  // Arrival: the whole block grows by height (useGrowFrom) and fades in. The
  // tail body inside it never animates per streamed chunk; it only opens and
  // closes as a whole. A settled block keeps a plain root (enterFrom never
  // changes, so neither does the element type).
  const root = (children: React.ReactNode, extra?: React.CSSProperties) => {
    const style: React.CSSProperties = { marginBottom: 8, fontSize: 'var(--fs-sm)', ...extra };
    return enterFrom === null ? (
      <div data-agent-block style={style}>{children}</div>
    ) : (
      <motion.div ref={rootRef} data-agent-block initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={BLOCK_FADE} style={style}>
        {children}
      </motion.div>
    );
  };
  const bodySlot = (chrome?: React.CSSProperties) => (
    <AnimatePresence initial={false} custom={bodyExit}>
      {showBody && <ThoughtBodyReveal key="body">{body(bodyRef, mode === 'tail', chrome)}</ThoughtBodyReveal>}
    </AnimatePresence>
  );

  // ── 1b · card chrome: hairline square-corner card, spinner/sparkle header,
  //    hairline-divided serif body. ──
  if (variant === 'card') {
    const cardBase = dur != null
      ? `${hasTools ? 'Worked' : 'Thought'} for ${formatDurationMs(dur)}`
      : (hasTools ? 'Worked' : 'Thoughts');
    const cardSuffix = toolCount && toolCount > 0
      ? `· ${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'}`
      : codexStepCount > 0
        ? `· ${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
        : '';
    // Finished blocks with tools lead with what they did; the duration moves
    // to the right edge. Computed only once done, never per streamed token.
    const work = !streaming && hasTools
      ? summarizeWork(tools ?? segments?.flatMap((s) => (s.kind === 'tools' ? s.tools : [])) ?? [], subagents)
      : null;
    return root(
        <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)' }}>
          <CardThoughtHeader
            streaming={live}
            phase={phase}
            open={open}
            onToggle={handleToggle}
            startedAt={startedAt}
            clockKey={clockKey}
            workText={work?.text || undefined}
            workFailed={work?.failed}
            durText={work?.text && dur != null ? formatDurationMs(dur) : undefined}
            base={live ? undefined : cardBase}
            suffix={live ? undefined : cardSuffix}
          />
          {bodySlot({
            borderTop: '1px solid var(--term-line)',
            padding: '9px 12px',
            color: 'var(--term-mid)',
            lineHeight: 1.6,
            // Mock spec: thought prose sits a step below the answer body
            // (12px at the default 15px slider). Scales with the size slider.
            ['--message-body-size' as never]: 'calc(var(--message-body-size-base, 15px) * 0.8)',
            ['--message-body-leading' as never]: '1.6',
          })}
        </div>,
      { fontFamily: 'var(--ui-font)' },
    );
  }

  // ── 1d · terminal chrome: ❯-prompt streaming row with a blinking caret,
  //    tracking-caps collapsed row with a dotted leader, accent-rule body. ──
  if (variant === 'terminal') {
    const rightMeta = [
      dur != null ? formatDurationMs(dur) : null,
      toolCount && toolCount > 0
        ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`
        : codexStepCount > 0
          ? `${codexStepCount} ${codexStepCount === 1 ? 'step' : 'steps'}`
          : null,
    ].filter(Boolean).join(' · ');
    return root(
      <>
        <TerminalThoughtHeader
          streaming={live}
          phase={phase}
          open={open}
          onToggle={handleToggle}
          hasTools={live ? undefined : hasTools}
          rightMeta={live ? undefined : rightMeta}
        />
        {bodySlot({
          marginTop: 5,
          marginLeft: 3,
          paddingLeft: 11,
          borderLeft: '2px solid var(--term-accent-f)',
          color: 'var(--term-muted)',
          lineHeight: 1.55,
          ['--message-body-size' as never]: 'calc(var(--message-body-size-base, 15px) * 0.8)',
          ['--message-body-leading' as never]: '1.55',
        })}
      </>,
      { fontFamily: 'var(--ui-font)' },
    );
  }

  return root(
    <>
      <PlainThoughtHeader
        streaming={live}
        phase={phase}
        open={open}
        onToggle={handleToggle}
        doneLabel={live ? undefined : doneLabel}
      />
      {bodySlot()}
    </>,
  );
}

function ThinkingIndicator() {
  // Three bouncing dots — purely a "something is happening" placeholder
  // shown only while the assistant has streaming=true but no blocks/text/
  // thought/tools have arrived yet. Replaces the older "Thinking…" copy
  // which overclaimed what was actually happening (mostly network wait,
  // not reasoning). Reuses the existing bounce-dot @keyframes in index.css.
  // Entrance and exit belong to PendingIndicatorSlot.
  return (
    <div style={{ padding: '6px 0' }} aria-label="loading" role="status">
      <span className="typing-dot" />
      <span className="typing-dot" style={{ animationDelay: '.15s' }} />
      <span className="typing-dot" style={{ animationDelay: '.3s' }} />
    </div>
  );
}

function PendingDots({ ref }: { ref?: React.Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.12 } }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      // Leaving dots are no longer a status.
      aria-hidden={present ? undefined : true}
    >
      <ThinkingIndicator />
    </motion.div>
  );
}

/**
 * Where the pending dots sit. When the first content replaces them they fade
 * out in place (popped out of the flow, so nothing jumps) while the arriving
 * block grows from their height. Placed before the message's content.
 * Memoized: streamed chunks re-render its parent, not it.
 */
const PendingIndicatorSlot = React.memo(function PendingIndicatorSlot({ show }: { show: boolean }) {
  const scope = useContext(MessageMotionContext);
  const dotsRef = useRef<HTMLDivElement>(null);
  // Record the dots' height when they show; clear it in the commit that hides
  // them, after the block replacing them has rendered.
  useLayoutEffect(() => {
    if (scope) scope.pendingHeight.current = show ? dotsRef.current?.offsetHeight ?? null : null;
  }, [scope, show]);
  return (
    // The positioned parent popLayout needs for the leaving dots.
    <div style={{ position: 'relative' }}>
      <AnimatePresence initial={false} mode="popLayout">
        {show && <PendingDots key="pending" ref={dotsRef} />}
      </AnimatePresence>
    </div>
  );
});

/**
 * Wrap `@name` tokens inside `text` in `<span class="mention-chip">` tags
 * so they render as styled clickable chips. Matches known context names greedily
 * (longest first) so names with spaces resolve correctly.
 *
 * When `nodeMentions` are provided, also wraps `@title` tokens for node mentions
 * with an additional `data-node-id` attribute for click navigation.
 */
export function highlightMentions(
  text: string,
  contextNames: ReadonlySet<string>,
  nodeMentions?: ReadonlyArray<{ label: string; nodeId: string }>,
): string {
  if (contextNames.size === 0 && (!nodeMentions || nodeMentions.length === 0)) return text;
  let result = text;

  // Handle node mentions first (they carry unique nodeId for navigation)
  if (nodeMentions && nodeMentions.length > 0) {
    const sorted = [...nodeMentions].sort((a, b) => b.label.length - a.label.length);
    for (const { label, nodeId } of sorted) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"]|$)`, 'giu');
      result = result.replace(re, (_full, matched: string) => {
        const htmlEsc = matched.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const nodeIdEsc = nodeId.replace(/"/g, '&quot;');
        return `<span class="mention-chip" data-mention="${htmlEsc}" data-mention-kind="node" data-node-id="${nodeIdEsc}">@${htmlEsc}</span>`;
      });
    }
  }

  // Handle context mentions
  if (contextNames.size > 0) {
    const sorted = [...contextNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"]|$)`, 'giu');
      result = result.replace(re, (_full, matched: string) => {
        const htmlEsc = matched.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `<span class="mention-chip" data-mention="${htmlEsc}" data-mention-kind="context">@${htmlEsc}</span>`;
      });
    }
  }

  return result;
}

/**
 * Display-time markdown prep for USER message text. Chat line breaks are
 * literal `\n` (Shift+Enter, pasted email bodies), but markdown collapses a
 * single newline into a space — so suffix every plain line with the two-space
 * hard-break marker. Lines inside fenced code blocks stay verbatim (trailing
 * spaces there would leak into the code), and blank lines already separate
 * paragraphs. `m.text` itself is never modified — copy/edit/retry keep the
 * exact typed characters.
 */
export function userTextToMarkdown(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || i === lines.length - 1 || line.trim() === '') return line;
      // A break before a blank line is meaningless (the blank line already
      // ends the paragraph) — keep those lines byte-identical.
      if (lines[i + 1].trim() === '') return line;
      return `${line}  `;
    })
    .join('\n');
}

const proseVars: React.CSSProperties = {
  '--tw-prose-body': 'var(--term-fg)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-mid)',
  '--tw-prose-bullets': 'var(--term-mid)',
} as React.CSSProperties;

const thoughtProseVars: React.CSSProperties = {
  '--tw-prose-body': 'inherit',
  '--tw-prose-headings': 'inherit',
  '--tw-prose-bold': 'inherit',
  '--tw-prose-code': 'inherit',
  '--tw-prose-links': 'var(--term-accent)',
} as React.CSSProperties;

/** Feature profile for answer-segment Markdown: enables table controls
 *  (copy / download / fullscreen toolbar + auto-measure-then-lock column
 *  widths to prevent reflow during streaming). */
const ANSWER_FEATURES: import('../MarkdownContent').MarkdownFeatureProfile = {
  tableControls: true,
};

function renderSegments(
  segments: ReturnType<typeof useVisibleStream>['segments'],
  isDark: boolean,
  subagents?: readonly SubagentInfo[],
  opts?: { streamingMarkdownBlocks?: boolean },
) {
  let chipIdx = 0;
  const lastTextIndex = opts?.streamingMarkdownBlocks
    ? segments.reduce((last, seg, index) => (seg.kind === 'text' ? index : last), -1)
    : -1;
  const useStreamingBlocks = lastTextIndex >= 0 && streamingMarkdownBlocksEnabled();
  return segments.map((seg, segmentIndex) => {
    if (seg.kind === 'text') {
      if (useStreamingBlocks && segmentIndex === lastTextIndex) {
        return (
          <React.Suspense
            key={`text-${chipIdx}`}
            fallback={(
              <MarkdownContent
                text={seg.text}
                size="sm"
                className={isDark ? 'prose-invert' : ''}
                style={proseVars}
                revealTailChars={seg.revealTailChars}
                features={ANSWER_FEATURES}
              />
            )}
          >
            <StreamingMarkdownContent
              text={seg.text}
              size="sm"
              className={isDark ? 'prose-invert' : ''}
              style={proseVars}
              revealTailChars={seg.revealTailChars}
              features={ANSWER_FEATURES}
            />
          </React.Suspense>
        );
      }
      return (
        <MarkdownContent
          key={`text-${chipIdx}`}
          text={seg.text}
          size="sm"
          className={isDark ? 'prose-invert' : ''}
          style={proseVars}
          revealTailChars={seg.revealTailChars}
          features={ANSWER_FEATURES}
        />
      );
    }
    if (seg.kind === 'user-input') {
      chipIdx += 1;
      return <InlineUserInputSegment key={seg.interaction?.interactionId ?? `ui-${seg.requestId}`} requestId={seg.requestId} interaction={seg.interaction} />;
    }
    const groupKey = seg.tools[0].id;
    const defaultExpanded = seg.tools.some((t) => isRunningStatus(t.status));
    chipIdx += 1;
    return (
      <ToolCallGroup
        key={groupKey}
        tools={seg.tools}
        defaultExpanded={defaultExpanded}
        subagents={subagents}
      />
    );
  });
}

function toolMap(toolCalls: readonly ToolCallState[]): Map<string, ToolCallState> {
  return new Map(toolCalls.map((tool) => [tool.id, tool]));
}

function relevantTools(blocks: readonly AssistantBlock[], toolsById: ReadonlyMap<string, ToolCallState>): ToolCallState[] {
  return blocks.flatMap((block): ToolCallState[] => {
    if (block.kind !== 'tool') return [];
    const tool = toolsById.get(block.toolCallId);
    return tool ? [tool] : [];
  });
}

function thinkingToolGroups(blocks: readonly AssistantBlock[], toolsById: ReadonlyMap<string, ToolCallState>): ToolCallState[][] {
  const groups: ToolCallState[][] = [];
  let current: ToolCallState[] | null = null;
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      current = null;
      continue;
    }
    const tool = toolsById.get(block.toolCallId);
    if (!tool) continue;
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push(tool);
  }
  return groups;
}

interface AnswerRunViewProps {
  blocks: AssistantBlock[];
  tools: ToolCallState[];
  incomingCarry?: SentinelCarry;
  isDark: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
}

function AnswerRunViewInner({
  blocks,
  tools,
  incomingCarry,
  isDark,
  subagents,
  runtimeId,
  onSmoothingChange,
}: AnswerRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const { segments, isSmoothing } = useAnswerRunStream(blocks, toolsById, incomingCarry, runtimeId);
  const streaming = blocks.some((b) => b.kind === 'answer' && b.streaming);
  // Update follow-up visibility before paint, including a short answer whose
  // final text and metadata arrive together while the parent still sees false.
  useLayoutEffect(() => {
    onSmoothingChange?.(isSmoothing);
  }, [isSmoothing, onSmoothingChange]);
  return (
    <>
      {renderSegments(segments, isDark, subagents, { streamingMarkdownBlocks: streaming || isSmoothing })}
    </>
  );
}

const AnswerRunView = React.memo(AnswerRunViewInner, (prev, next) =>
  sameBlockRefs(prev.blocks, next.blocks) &&
  sameToolRefs(prev.tools, next.tools) &&
  carryEqual(prev.incomingCarry, next.incomingCarry) &&
  prev.isDark === next.isDark &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.onSmoothingChange === next.onSmoothingChange,
);

interface ThinkingRunViewProps {
  blocks: AssistantBlock[];
  tools: ToolCallState[];
  streaming: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  /** Durable activity window and clock key, forwarded to TermThoughtBlock. */
  startedAt?: number;
  endedAt?: number;
  clockKey?: string;
}

function ThinkingRunViewInner({
  blocks, tools, streaming, subagents, runtimeId, startedAt, endedAt, clockKey,
}: ThinkingRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const text = useMemo(() => thinkingRunRawText(blocks), [blocks]);
  const groups = useMemo(() => thinkingToolGroups(blocks, toolsById), [blocks, toolsById]);
  const toolCount = useMemo(() => groups.reduce((n, g) => n + g.length, 0), [groups]);
  const toolsActive = tools.some((t) => isRunningStatus(t.status));
  // Hydrated turns have no live thinking timer; the run's tool-call span is
  // the best available duration approximation. Keep the block live while
  // tools still run so the timer covers thinking + tool work, not thought only.
  const spanMs = useMemo(() => toolSpanMs(tools), [tools]);
  const groupedTools = useMemo(() => groups.flat(), [groups]);
  return (
    <>
      <TermThoughtBlock
        text={text}
        streaming={streaming || toolsActive}
        phase={streaming ? 'thinking' : toolsActive ? 'working' : 'done'}
        toolCount={toolCount}
        runtimeId={runtimeId}
        durationMs={spanMs}
        startedAt={startedAt}
        endedAt={endedAt}
        clockKey={clockKey}
        tools={groupedTools}
        subagents={subagents}
      >
        {groups.length > 0
          ? groups.map((group) => (
              <ToolCallGroup
                key={group[0].id}
                tools={group}
                defaultExpanded={group.some((t) => isRunningStatus(t.status))}
                subagents={subagents}
                receipts={false}
              />
            ))
          : null}
      </TermThoughtBlock>
      {/* Outside the block: it collapses once the turn ends. */}
    </>
  );
}

const ThinkingRunView = React.memo(ThinkingRunViewInner, (prev, next) =>
  sameBlockRefs(prev.blocks, next.blocks) &&
  sameToolRefs(prev.tools, next.tools) &&
  prev.streaming === next.streaming &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.startedAt === next.startedAt &&
  prev.endedAt === next.endedAt &&
  prev.clockKey === next.clockKey,
);

/* ── Agent-run clustering (card / terminal variants) ──
   Consecutive thinking runs and tool-only answer runs merge into ONE agent
   block: a single thought header whose body interleaves thought prose and
   tool groups in stream order. Answer runs with visible text break clusters.
   The plain variant keeps the historical one-block-per-run rendering. */

type RenderCluster =
  | { kind: 'agent'; id: string; runs: AssistantRun[] }
  | { kind: 'run'; run: AssistantRun };

function isToolOnlyAnswerRun(run: AssistantRun): boolean {
  return run.kind === 'answer' && run.blocks.length > 0 && run.blocks.every((b) => b.kind === 'tool');
}

const isAgentRun = (run: AssistantRun) => run.kind === 'thinking' || isClusterableAnswerRun(run);

/** True when the agent-run stretch starting at `from` and walking by `step`
 *  contains a thinking run, i.e. it renders as an agent block. */
function agentStretchHasThinking(runs: readonly AssistantRun[], from: number, step: 1 | -1): boolean {
  for (let i = from; i >= 0 && i < runs.length && isAgentRun(runs[i]); i += step) {
    if (runs[i].kind === 'thinking') return true;
  }
  return false;
}

/** Tool blocks (and blank answer fragments between them) at one edge of a run.
 *  Returns how many blocks to peel; 0 unless a visible tool is among them, so
 *  hidden metadata tools never turn a "Thoughts" block into "Worked". */
function edgeToolBlockCount(
  blocks: readonly AssistantBlock[],
  fromEnd: boolean,
  byId: ReadonlyMap<string, ToolCallState>,
): number {
  let count = 0;
  let visibleTool = false;
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[fromEnd ? blocks.length - 1 - k : k];
    if (block.kind === 'tool') {
      const tool = byId.get(block.toolCallId);
      if (tool && !isHiddenInternalTool(tool.title)) visibleTool = true;
    } else if (!(block.kind === 'answer' && !block.rawText?.trim())) {
      break;
    }
    count++;
  }
  return visibleTool ? count : 0;
}

/**
 * An answer run's prose and its tool calls share one run, so tools the agent
 * ran right after saying what it would do ("Checking first:") sat in a
 * separate group next to the following thought block. Split such edge tools
 * off as tool-only runs when the neighbouring stretch forms an agent block,
 * so clusterAgentRuns merges them into it. Prose keeps the run's id and carry:
 * tool blocks contribute no text to sentinel projection.
 */
function detachEdgeTools(
  runs: AssistantRun[],
  byId: ReadonlyMap<string, ToolCallState>,
): AssistantRun[] {
  const out: AssistantRun[] = [];
  runs.forEach((run, i) => {
    if (run.kind !== 'answer' || isClusterableAnswerRun(run)) {
      out.push(run);
      return;
    }
    let { blocks } = run;
    const lead = agentStretchHasThinking(runs, i - 1, -1) ? edgeToolBlockCount(blocks, false, byId) : 0;
    const leading = blocks.slice(0, lead);
    blocks = blocks.slice(lead);
    const trail = agentStretchHasThinking(runs, i + 1, 1) ? edgeToolBlockCount(blocks, true, byId) : 0;
    const trailing = blocks.slice(blocks.length - trail);
    blocks = blocks.slice(0, blocks.length - trail);
    if (leading.length > 0) out.push({ id: leading[0].id, kind: 'answer', blocks: leading });
    out.push(leading.length > 0 || trailing.length > 0 ? { ...run, blocks } : run);
    if (trailing.length > 0) out.push({ id: trailing[0].id, kind: 'answer', blocks: trailing });
  });
  return out;
}

function clusterAgentRuns(runs: AssistantRun[]): RenderCluster[] {
  const out: RenderCluster[] = [];
  let buf: AssistantRun[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.some((r) => r.kind === 'thinking')) {
      out.push({ kind: 'agent', id: buf[0].id, runs: buf });
    } else {
      // Tool-only answer runs with no thinking neighbours keep their plain
      // rendering — a thought header with zero thoughts would be a lie.
      for (const r of buf) out.push({ kind: 'run', run: r });
    }
    buf = [];
  };
  for (const run of runs) {
    if (run.kind === 'thinking' || isClusterableAnswerRun(run)) {
      buf.push(run);
    } else {
      flush();
      out.push({ kind: 'run', run });
    }
  }
  flush();
  return out;
}

type StreamPhase = 'thinking' | 'working' | 'done';

interface AgentClusterViewProps {
  runs: AssistantRun[];
  tools: ToolCallState[];
  streaming: boolean;
  phase: StreamPhase;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  /** Durable activity window and clock key, forwarded to TermThoughtBlock. */
  startedAt?: number;
  endedAt?: number;
  clockKey?: string;
}

function AgentClusterViewInner({
  runs, tools, streaming, phase, subagents, runtimeId, startedAt, endedAt, clockKey,
}: AgentClusterViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const segments = useMemo(() => {
    const out: ThoughtSegment[] = [];
    for (const run of runs) {
      for (const block of run.blocks) {
        if (block.kind === 'thinking') {
          if (!block.rawText) continue;
          const last = out[out.length - 1];
          // Adjacent thinking blocks are stream fragments of one thought —
          // concatenate raw (mirrors thinkingRunRawText's '' join).
          if (last?.kind === 'text') last.text += block.rawText;
          else out.push({ key: block.id, kind: 'text', text: block.rawText });
        } else if (block.kind === 'tool') {
          const tool = toolsById.get(block.toolCallId);
          if (!tool) continue;
          const last = out[out.length - 1];
          if (last?.kind === 'tools') last.tools.push(tool);
          else out.push({ key: block.id, kind: 'tools', tools: [tool] });
        }
      }
    }
    return out;
  }, [runs, toolsById]);
  const text = useMemo(
    () => segments.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('\n\n'),
    [segments],
  );
  const spanMs = useMemo(() => toolSpanMs(tools), [tools]);
  const segmentTools = useMemo(
    () => segments.flatMap((s) => (s.kind === 'tools' ? s.tools : [])),
    [segments],
  );
  return (
    <>
      <TermThoughtBlock
        text={text}
        segments={segments}
        streaming={streaming}
        phase={phase}
        toolCount={tools.length}
        runtimeId={runtimeId}
        durationMs={spanMs}
        startedAt={startedAt}
        endedAt={endedAt}
        clockKey={clockKey}
        subagents={subagents}
      />
      {/* Outside the block: it collapses once the turn ends. */}
    </>
  );
}

function sameRunRefs(a: AssistantRun[], b: AssistantRun[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || !sameBlockRefs(a[i].blocks, b[i].blocks)) return false;
  }
  return true;
}

const AgentClusterView = React.memo(AgentClusterViewInner, (prev, next) =>
  sameRunRefs(prev.runs, next.runs) &&
  sameToolRefs(prev.tools, next.tools) &&
  prev.streaming === next.streaming &&
  prev.phase === next.phase &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  prev.startedAt === next.startedAt &&
  prev.endedAt === next.endedAt &&
  prev.clockKey === next.clockKey,
);

function LegacyAssistantBody({
  m,
  isDark,
  subagents,
  runtimeId,
  onSmoothingChange,
}: {
  m: ChatMessage;
  isDark: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
}) {
  const { segments, isSmoothing } = useVisibleStream(m, runtimeId);
  useLayoutEffect(() => {
    onSmoothingChange?.(isSmoothing);
  }, [isSmoothing, onSmoothingChange]);
  return (
    <>
      {renderSegments(segments, isDark, subagents, { streamingMarkdownBlocks: !!m.streaming || isSmoothing })}
    </>
  );
}

function BlockAssistantBody({
  m,
  isDark,
  showThoughts,
  subagents,
  runtimeId,
  onSmoothingChange,
  hidePendingIndicator,
}: {
  m: ChatMessage;
  isDark: boolean;
  showThoughts: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
  hidePendingIndicator?: boolean;
}) {
  const runs = useMemo(() => splitAssistantRuns(m.blocks), [m.blocks]);
  const byId = useMemo(() => toolMap(m.toolCalls), [m.toolCalls]);
  const variant = useAgentBlockStyle();
  const clusters = useMemo(
    () =>
      variant === 'plain'
        ? runs.map((run): RenderCluster => ({ kind: 'run', run }))
        // With thoughts hidden there is no agent block to join; keep tools
        // under the prose that introduced them.
        : clusterAgentRuns(showThoughts ? detachEdgeTools(runs, byId) : runs),
    [runs, variant, showThoughts, byId],
  );
  // Backward scans (no array copy). `runs` is rebuilt every chunk as blocks
  // grow, so the old [...runs].reverse().find() copied+reversed on every
  // streamed token of the actively-rendering message.
  // Tool-only answer runs never smooth (no text) — the callback targets the
  // last answer run that can actually stream prose.
  const tailAnswerRunId = useMemo(() => {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].kind === 'answer' && !isClusterableAnswerRun(runs[i])) return runs[i].id;
    }
    return undefined;
  }, [runs]);
  const liveThinkingId = useMemo(() => {
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (run.kind === 'thinking' && run.blocks.some((b) => b.kind === 'thinking' && b.streaming)) {
        return run.id;
      }
    }
    return undefined;
  }, [runs]);
  useLayoutEffect(() => {
    if (!tailAnswerRunId) onSmoothingChange?.(false);
  }, [onSmoothingChange, tailAnswerRunId]);
  return (
    <>
      {m.streaming && <PendingIndicatorSlot show={runs.length === 0 && !hidePendingIndicator} />}
      {clusters.map((cluster, clusterIndex) => {
        const following = clusters[clusterIndex + 1];
        const nextBlock = following
          ? (following.kind === 'agent' ? following.runs[0]?.blocks[0] : following.run.blocks[0])
          : undefined;
        if (cluster.kind === 'agent') {
          const clusterTools = cluster.runs.flatMap((r) => relevantTools(r.blocks, byId));
          if (!showThoughts) {
            // Thought prose is hidden, but tool activity from answer-section
            // runs stays visible — parity with the un-clustered rendering.
            return cluster.runs.filter(isClusterableAnswerRun).map((run) => (
              <AnswerRunView
                key={run.id}
                blocks={run.blocks}
                tools={relevantTools(run.blocks, byId)}
                incomingCarry={run.incomingCarry}
                isDark={isDark}
                subagents={subagents}
                runtimeId={runtimeId}
              />
            ));
          }
          // Keep the block live (tail body visible) while thought tokens or
          // one of its tools are active. Also keep the tail agent cluster live
          // during a between-steps gap: its "Working…" header is then the only
          // liveness signal (StreamActivityIndicator defers to it via
          // tailRunsFormAgentCluster). Once a later answer/image run exists,
          // this cluster is no longer the tail and remains completed.
          const isTailAgentCluster = clusterIndex === clusters.length - 1;
          const isThinking =
            isTailAgentCluster && cluster.runs.some((r) => r.id === liveThinkingId);
          const isTooling =
            isTailAgentCluster &&
            !isThinking &&
            !!m.streaming &&
            clusterTools.some((t) => isRunningStatus(t.status));
          const isBetweenSteps =
            isTailAgentCluster &&
            !isThinking &&
            !isTooling &&
            !!m.streaming;
          const active = isThinking || isTooling || isBetweenSteps;
          const phase: StreamPhase = isThinking ? 'thinking' : active ? 'working' : 'done';
          const activity = activityWindow(cluster.runs.flatMap((r) => r.blocks), byId, nextBlock);
          return (
            <AgentClusterView
              key={cluster.id}
              runs={cluster.runs}
              tools={clusterTools}
              streaming={active}
              phase={phase}
              subagents={subagents}
              runtimeId={runtimeId}
              startedAt={activity.startedAt}
              endedAt={activity.endedAt}
              clockKey={m.id}
            />
          );
        }
        const run = cluster.run;
        const tools = relevantTools(run.blocks, byId);
        if (run.kind === 'image') {
          return <ImageBlockView key={run.id} blocks={run.blocks} />;
        }
        if (run.kind === 'thinking') {
          if (!showThoughts) return null;
          const activity = activityWindow(run.blocks, byId, nextBlock);
          return (
            <ThinkingRunView
              key={run.id}
              blocks={run.blocks}
              tools={tools}
              streaming={run.id === liveThinkingId}
              subagents={subagents}
              runtimeId={runtimeId}
              startedAt={activity.startedAt}
              endedAt={activity.endedAt}
              clockKey={m.id}
            />
          );
        }
        return (
          <AnswerRunView
            key={run.id}
            blocks={run.blocks}
            tools={tools}
            incomingCarry={run.incomingCarry}
            isDark={isDark}
            subagents={subagents}
            runtimeId={runtimeId}
            onSmoothingChange={run.id === tailAnswerRunId ? onSmoothingChange : undefined}
          />
        );
      })}
    </>
  );
}

// User messages taller than this many lines collapse behind a "Show more"
// toggle with a fade-out gradient. Measured against the content's computed
// line-height so it tracks the (slider-driven) message font size.
const USER_COLLAPSE_MAX_LINES = 8;

// The user bubble's paper-card background — kept in sync with the color-mix
// in `.terminal-message-user` (index.css) so the collapse gradient fades into
// the bubble instead of a flat neutral.
const USER_BUBBLE_BG = 'color-mix(in srgb, var(--term-accent) 4%, var(--term-surface))';

/**
 * Clamps long user message bodies to USER_COLLAPSE_MAX_LINES with a bottom
 * fade + "Show more"/"Show less" toggle. Measurement uses scrollHeight (which
 * ignores the max-height clamp) against `lineHeight * MAX_LINES`, re-run via a
 * ResizeObserver so wrapping changes (pane resize, font slider) stay correct.
 */
function CollapsibleUserText({
  contentKey,
  children,
}: {
  contentKey: string;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = React.useId();
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clampHeight, setClampHeight] = useState<number | null>(null);
  // The clamp style is on. Expanding drops it at once; collapsing keeps it
  // off until the height has come down to it.
  const [clamping, setClamping] = useState(true);
  const reduceMotion = useReducedMotionConfig() ?? false;
  /** The height a toggle starts from, measured on the click. */
  const toggleFromRef = useRef<number | null>(null);
  const heightMotionRef = useRef<{ stop: () => void } | null>(null);

  const toggle = () => {
    const el = contentRef.current;
    heightMotionRef.current?.stop();
    heightMotionRef.current = null;
    const from = el && clampHeight != null && !reduceMotion ? el.getBoundingClientRect().height : null;
    toggleFromRef.current = from;
    const next = !expanded;
    setExpanded(next);
    if (next || from === null) setClamping(!next);
  };

  // Show more 260ms / Show less 160ms. Hand-written (skipped under reduced
  // motion). The first frame lands in the click's own commit, 1px past the
  // start, so the transcript height changes there and TPane leaves follow
  // mode, as it did when the clamp just snapped.
  useLayoutEffect(() => {
    const el = contentRef.current;
    const from = toggleFromRef.current;
    toggleFromRef.current = null;
    if (!el || from === null || clampHeight == null) return;
    const to = expanded ? el.scrollHeight : clampHeight;
    const start = expanded ? from + 1 : Math.max(clampHeight, from - 1);
    el.style.overflow = 'hidden';
    el.style.height = `${start}px`;
    // Written by hand, with a guard: an element animation can write its last
    // frame after onComplete, which would leave a fixed height behind.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      heightMotionRef.current = null;
      el.style.height = '';
      el.style.overflow = '';
      if (!expanded) setClamping(true);
    };
    heightMotionRef.current = animate(start, to, {
      duration: expanded ? DUR.expand : DUR.collapse,
      ease: EASE.drawer,
      onUpdate: (h) => {
        if (!done) el.style.height = `${h}px`;
      },
      onComplete: finish,
    });
    // clampHeight is read, not watched: a re-measure must not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  useEffect(() => () => heightMotionRef.current?.stop(), []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      // A pane mounted at zero width makes every message look overflowing;
      // the observer measures again once the content has a width.
      if (el.clientWidth === 0) return;
      const cs = window.getComputedStyle(el);
      let lineHeight = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        lineHeight = (parseFloat(cs.fontSize) || 14) * 1.6;
      }
      const threshold = Math.round(lineHeight * USER_COLLAPSE_MAX_LINES);
      // scrollHeight reports the full content height regardless of the clamp,
      // so this stays stable across the collapsed/expanded toggle (no loop).
      const isOver = el.scrollHeight > threshold + 2;
      setOverflowing(isOver);
      setClampHeight(isOver ? threshold : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentKey]);

  const collapsed = overflowing && !expanded;

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={contentRef}
        id={contentId}
        style={
          collapsed && clamping && clampHeight != null
            ? { position: 'relative', maxHeight: clampHeight, overflow: 'hidden' }
            : { position: 'relative' }
        }
      >
        {children}
        {collapsed && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '2.6em',
              pointerEvents: 'none',
              background: `linear-gradient(to bottom, transparent, ${USER_BUBBLE_BG})`,
            }}
          />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="t-hover-fg t-user-text-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          style={{
            marginTop: 4,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            letterSpacing: 'var(--ls-wide)',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * Terminal error tail below a failed assistant turn. Variants keyed by
 * `errorKind` distinguish unknown outcomes from ordinary execution failures:
 *   - restart interruption: one line and one action, Resume, which carries the
 *     turn on from its kept partial output. Typing a message works as well.
 *   - unknown outcome: check the existing turn; an explicit rerun preserves output.
 *   - connection: the backend already auto-retried once and still failed →
 *     friendly banner + Retry + Test Connection (force-respawn probe).
 *   - auth: SSO/login expired → prompt to re-authenticate (e.g. kiro login).
 *     Retry alone won't help, so no Test Connection button.
 *   - generic / undefined: the original compact "failed · ↻ retry" row, raw
 *     message preserved.
 */
function ErrorTail({
  errorMessage,
  errorKind,
  errorRecovery,
  onRetry,
  onRunAgain,
  onTestConnection,
}: {
  errorMessage?: string;
  errorKind?: string;
  errorRecovery?: 'checking' | 'unavailable';
  onRetry?: () => void;
  onRunAgain?: () => void;
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
}) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testDetail, setTestDetail] = useState<string | undefined>();
  const [confirmRerun, setConfirmRerun] = useState(false);

  const runTest = async () => {
    if (!onTestConnection || testState === 'testing') return;
    setTestState('testing');
    setTestDetail(undefined);
    const result = await onTestConnection();
    setTestState(result.ok ? 'ok' : 'fail');
    setTestDetail(result.detail);
  };

  const btnStyle: React.CSSProperties = {
    border: '1px solid var(--term-danger)',
    color: 'var(--term-danger)',
    padding: '3px 10px',
    font: '600 var(--fs-sm) var(--ui-font)',
    letterSpacing: 'var(--ls-wide)',
    background: 'transparent',
    cursor: 'pointer',
  };
  const onHoverIn = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLButtonElement).style.background = 'var(--term-danger-f)';
  };
  const onHoverOut = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
  };

  const isConnection = errorKind === 'connection';
  const isAuth = errorKind === 'auth';
  const action = turnErrorAction(errorKind);
  const inspectOriginal = action === 'inspect-existing-turn';
  const resumable = action === 'resume-turn';
  const checking = errorRecovery === 'checking';

  // Headline scaled to the class. Connection: we already retried once, so say so.
  const headline = resumable
    ? 'Turn interrupted'
    : inspectOriginal
    ? errorKind === 'turn_persistence_failed' ? 'Result could not be saved' : 'Original result is not confirmed'
    : isConnection
    ? 'Cannot reach Kiro · auto-retry failed'
    : isAuth
      ? 'Kiro session expired · please re-authenticate'
      : 'failed';

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-sm)',
            letterSpacing: 'var(--ls-wide)',
            color: 'var(--term-danger)',
          }}
        >
          {headline}
        </span>
        <span style={{ color: 'var(--term-faint)' }}>·</span>
        {!isAuth && onRetry && (
          <button
            type="button"
            data-testid="error-tail-retry"
            disabled={checking}
            onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); onRetry(); }}
            style={btnStyle}
            onMouseEnter={onHoverIn}
            onMouseLeave={onHoverOut}
          >
            {resumable ? '▶ Resume' : inspectOriginal ? checking ? 'Checking original turn…' : 'Check original turn' : '↻ retry'}
          </button>
        )}
        {inspectOriginal && onRunAgain && (
          <button type="button" disabled={checking} style={btnStyle}
            onClick={(e) => { e.stopPropagation(); setConfirmRerun(true); }}>
            Run again
          </button>
        )}
        {(isConnection || isAuth) && onTestConnection && (
          <button
            type="button"
            data-testid="error-tail-test-connection"
            onClick={(e) => { e.stopPropagation(); void runTest(); }}
            disabled={testState === 'testing'}
            style={{ ...btnStyle, cursor: testState === 'testing' ? 'default' : 'pointer', opacity: testState === 'testing' ? 0.6 : 1 }}
            onMouseEnter={testState === 'testing' ? undefined : onHoverIn}
            onMouseLeave={testState === 'testing' ? undefined : onHoverOut}
          >
            {testState === 'testing' ? 'Testing…' : '⚙ Test Connection'}
          </button>
        )}
      </div>
      {resumable && (
        <div role="status" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-muted)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45 }}>
          Michi restarted while this task was running. The output above is kept and its tool calls may already have taken effect. Resume carries on from here; typing a new message works too.
        </div>
      )}
      {inspectOriginal && (
        <div role="status" style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-muted)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45 }}>
          {checking
            ? 'Checking the original task without sending it again.'
            : errorRecovery === 'unavailable'
              ? 'The original result could not be confirmed. Existing output is kept. Running again may repeat actions.'
              : 'Existing output is kept. Check the original task before running it again; it may already have performed actions.'}
        </div>
      )}
      {inspectOriginal && confirmRerun && !checking && onRunAgain && (
        <div role="group" aria-label="Confirm running again" style={{ marginTop: 8, font: 'var(--fs-sm) var(--ui-font)', color: 'var(--term-fg)' }}>
          <p style={{ margin: '0 0 8px' }}>This sends the same request again and may repeat file changes or other actions. The previous output will stay in this conversation.</p>
          <button type="button" style={btnStyle} onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); onRunAgain(); }}>Run again anyway</button>
          {' '}
          <button type="button" style={btnStyle} onClick={(e) => { e.stopPropagation(); setConfirmRerun(false); }}>Keep current result</button>
        </div>
      )}
      {testState === 'ok' && (
        <div style={{ marginTop: 6, color: 'var(--term-digest)', font: 'var(--fs-sm) var(--ui-font)' }}>
          Connection restored — click retry to resend.
        </div>
      )}
      {testState === 'fail' && (
        <div style={{ marginTop: 6, maxWidth: 720, color: 'var(--term-danger)', font: 'var(--fs-sm) var(--ui-font)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          Kiro is still unreachable{testDetail ? `: ${testDetail}` : '. Check your network or re-authenticate, then retry.'}
        </div>
      )}
      {errorMessage && !resumable && testState !== 'ok' && (
        <div
          style={{
            marginTop: 6,
            maxWidth: 720,
            color: 'var(--term-danger)',
            font: 'var(--fs-sm) var(--ui-font)',
            lineHeight: 1.45,
            overflowWrap: 'anywhere',
          }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}

interface MessageBlockProps {
  m: ChatMessage;
  workspaceId?: string;
  backendConnectionId?: string;
  index: number;
  isDark: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  /** Fork a new blank child branch anchored at this message. */
  onBranch?: () => void;
  onCopy: () => void;
  showThoughts: boolean;
  fontFamily: string;
  density: TerminalDensity;
  usageInfo?: TurnUsageInfo | null;
  isErrorTail?: boolean;
  errorMessage?: string;
  /** Runtime/storage/transport classification, including uncertain turn outcomes. */
  errorKind?: string;
  errorRecovery?: 'checking' | 'unavailable';
  onRunAgain?: () => void;
  /** Probe backend connectivity ("Test Connection"). Present only when the
   * error is connection/auth class and a cwd/workspace is resolvable. */
  onTestConnection?: () => Promise<{ ok: boolean; detail?: string }>;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  editing?: boolean;
  onEditSave?: (newText: string) => void;
  onEditCancel?: () => void;
  /**
   * Child branch anchors of this message. Those whose first message quotes
   * a passage of it (quotedText, from Branch on a selection) underline that
   * passage where it renders (BranchQuoteMarks / BranchQuoteUnderline), and
   * hovering it shows the branches. The branches keep their turn markers
   * too: touch screens have no hover, and a selection that crossed messages
   * or picked up UI text cannot be found again. Others are ignored.
   */
  quoteAnchors?: ChildAnchor[];
  /**
   * Turn-marker anchors for child branches forked from this message.
   * Rendered as <BranchAnchorRow> rows below the message body and above
   * the MessageActions (retry/edit/copy/time) row, so the marker sits
   * closer to the message content than the action chrome.
   */
  turnAnchors?: ChildAnchor[];
  /** Called when user clicks a turn marker title or a quote-underline anchor. */
  onOpenBranch?: (childNodeId: string) => void;
  /** Lowercased context names for highlighting @mentions in user messages. */
  contextNames?: ReadonlySet<string>;
  /** Called when user clicks a mention chip in a user message. */
  onMentionClick?: (name: string, kind: string, nodeId?: string) => void;
  /** Reports whether the visible typewriter is still catching up to raw text. */
  onVisibleSmoothingChange?: (isSmoothing: boolean) => void;
  /** Hide the MessageActions row (copy/retry/edit/branch/time) for the
   *  streaming-tail message. Used by PaneMessageList to suppress completion
   *  UI when the node is still streaming after hydration (m.streaming is
   *  false but the turn has not finished). */
  hideActions?: boolean;
  /** Hide the in-bubble pending dots because the pane's activity row already
   *  shows a labelled status (e.g. "Restoring original Claude session"). */
  hidePendingIndicator?: boolean;
  /** Frames the message, with this mark above it; the hover actions stay
   *  below the frame. Pass a stable element: it takes part in memoization. */
  highlight?: React.ReactNode;
  /** Play the entrance on mount: the message was just created (PaneMessageList
   *  decides). Read on the first render only, so it is not memoized. */
  fresh?: boolean;
  /** Viewport box this user bubble flies in from (a queued block, a picked
   *  follow-up; messageFlight) instead of rising. Read on mount only. */
  flightFrom?: DOMRectReadOnly;
}

/**
 * "Branches N" under a reply. A branch made just now (its edge is under a
 * second old) grows in: the whole section when it appears with it, otherwise
 * the new row. Branches there on mount (hydration, remounts) render settled.
 */
function BranchAnchorsSection({ anchors, onOpenBranch }: {
  anchors: ChildAnchor[];
  onOpenBranch?: (childNodeId: string) => void;
}) {
  const [grows] = useState(() => anchors.some((a) => isFresh(a.createdAt)));
  // Rows mounting after the section's first commit decide their own entrance.
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
  }, []);
  const section = (
    <section className="t-branch-anchors" aria-label="Branches from this reply">
      <h3 className="t-branch-anchors-heading">Branches <span>{anchors.length}</span></h3>
      {anchors.map((a, i) => (
        <BranchAnchorRow
          key={`anchor-${a.childNodeId}`}
          title={a.title}
          messageCount={a.messageCount ?? 0}
          createdAt={a.createdAt}
          status={a.status}
          onOpen={() => onOpenBranch?.(a.childNodeId)}
          enter={mountedRef.current && isFresh(a.createdAt)}
          last={i === anchors.length - 1}
        />
      ))}
    </section>
  );
  if (!grows) return section;
  return (
    <motion.div initial={ANCHOR_GROW_FROM} animate={ANCHOR_GROW_TO} style={ANCHOR_GROW_STYLE}>
      {section}
    </motion.div>
  );
}

/** A highlighted message's frame, its mark first; any other message as it is. */
function MessageHighlight({ mark, children }: { mark: React.ReactNode; children: React.ReactNode }) {
  if (mark == null || mark === false) return <>{children}</>;
  return <div className="terminal-message-highlight">{mark}{children}</div>;
}

// A sent bubble rises from the composer, from its bottom-right corner; the
// reply placeholder only fades in under it.
const USER_ENTRANCE = {
  initial: { opacity: 0, y: 12, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: SPRING.snappy,
};
const ASSISTANT_ENTRANCE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.12, ease: 'linear' },
} as const;

function MessageBlockInner({
  m,
  workspaceId,
  backendConnectionId,
  index,
  isDark,
  onRetry,
  onEdit,
  onBranch,
  onCopy,
  showThoughts,
  fontFamily,
  density,
  usageInfo,
  isErrorTail,
  errorMessage,
  errorKind,
  errorRecovery,
  onRunAgain,
  onTestConnection,
  subagents,
  runtimeId,
  quoteAnchors,
  turnAnchors,
  onOpenBranch,
  contextNames,
  onMentionClick,
  onVisibleSmoothingChange,
  editing,
  onEditSave,
  onEditCancel,
  hideActions,
  hidePendingIndicator,
  highlight,
  fresh,
  flightFrom,
}: MessageBlockProps) {
  const [hover, setHover] = useState(false);
  const [editText, setEditText] = useState(m.text);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const isUser = m.role === 'user';
  const decorations = useMetaChatDecorations();
  const reduceMotion = useReducedMotionConfig() ?? false;
  // Decided once: hydrated, lazily loaded and remounted messages render
  // settled. A bubble with somewhere to fly in from does that instead of
  // rising (one entrance, not two).
  const [flight] = useState(() => (isUser ? flightFrom ?? null : null));
  const [entrance] = useState(() => (fresh && !flight ? (isUser ? USER_ENTRANCE : ASSISTANT_ENTRANCE) : null));
  const [motionScope] = useState<MessageMotionScope>(() => ({ mounted: { current: false }, pendingHeight: { current: null } }));
  useLayoutEffect(() => {
    motionScope.mounted.current = true;
  }, [motionScope]);
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!flight || !el) return;
    return playFlight(el, flight, reduceMotion);
    // Mount only: the flight is decided once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (editing) {
      setEditText(m.text);
      requestAnimationFrame(() => {
        const ta = editAreaRef.current;
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      });
    }
  }, [editing, m.text]);
  const dMarginBottom = density === 'dense' ? 6 : density === 'compact' ? 10 : 16;
  const dLabelFontSize = density === 'dense' ? 9 : density === 'compact' ? 10 : 10.5;
  const dLabelMarginBottom = density === 'dense' ? 2 : density === 'compact' ? 3 : 4;
  // Assistant-only inline vertical padding. The user bubble's padding lives in
  // index.css (paper-card recipe) and scales via the [data-density] attribute.
  const dPadV = density === 'dense' ? 4 : density === 'compact' ? 5 : 6;
  const contents = (
    <>
      <BranchQuoteMarks anchors={quoteAnchors} onOpenBranch={onOpenBranch}>
      <MessageHighlight mark={highlight}>
      {!isUser && (
        <div
          style={{
            color: 'var(--term-muted)',
            fontSize: dLabelFontSize,
            marginBottom: dLabelMarginBottom,
            textAlign: 'left',
          }}
        >
          {decorations?.assistantLabel ?? '> michi'}
        </div>
      )}
      {isUser ? (
        editing ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="terminal-message-user-editing">
              <textarea
                ref={editAreaRef}
                className="user-edit-area"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); onEditCancel?.(); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else onEditCancel?.();
                  }
                }}
                spellCheck={false}
              />
              <div className="user-edit-footer">
                <button className="user-edit-action" onClick={() => onEditCancel?.()}>
                  Cancel <kbd>Esc</kbd>
                </button>
                <span style={{ flex: 1 }} />
                <button
                  className="user-edit-action"
                  onClick={() => {
                    const trimmed = editText.trim();
                    if (trimmed && trimmed !== m.text) onEditSave?.(trimmed);
                    else onEditCancel?.();
                  }}
                >
                  Save <kbd>↵</kbd>
                </button>
              </div>
            </div>
          </div>
        ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            ref={bubbleRef}
            className="terminal-message terminal-message-user"
            data-density={density}
            onClick={onMentionClick ? (e) => {
              const chip = (e.target as HTMLElement).closest('[data-mention]');
              if (chip) {
                const el = chip as HTMLElement;
                const name = el.dataset.mention!;
                const kind = el.dataset.mentionKind ?? 'context';
                const nodeId = el.dataset.nodeId;
                onMentionClick(name, kind, nodeId);
              }
            } : undefined}
            style={{
              fontFamily: 'var(--ui-font)',
              lineHeight: 'var(--message-body-leading)',
              letterSpacing: 0,
              color: 'var(--term-fg)',
              wordBreak: 'break-word',
            }}
          >
            {m.threadMessage && (
              <div
                className="terminal-message-thread-source"
                title="Written by the agent in another thread and delivered with your approval"
              >
                From{' '}
                {onMentionClick ? (
                  <button
                    type="button"
                    className="terminal-message-thread-link"
                    data-mention={m.threadMessage.fromTitle ?? 'another thread'}
                    data-mention-kind="node"
                    data-node-id={m.threadMessage.fromNodeId}
                  >
                    {m.threadMessage.fromTitle ?? 'another thread'}
                  </button>
                ) : (m.threadMessage.fromTitle ?? 'another thread')}
              </div>
            )}
            {m.steered && <div className="terminal-message-steered" title="Sent to the active turn">Steered</div>}
            {m.comments && m.comments.length > 0 && <CommentChips comments={m.comments} />}
            {m.quotedText && <QuoteChip text={m.quotedText} source={m.quoteSource} />}
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentPills items={m.attachments} />
            )}
            {m.streaming ? (
              <MarkdownContent
                text={userTextToMarkdown(
                  highlightMentions(
                    m.text,
                    contextNames ?? new Set(),
                    m.mentions?.filter(x => x.kind === 'node').map(x => ({ label: x.label, nodeId: x.refId })),
                  ),
                )}
                size="sm"
                className={isDark ? 'prose-invert' : ''}
                style={proseVars}
              />
            ) : (
              <CollapsibleUserText contentKey={m.text}>
                <MarkdownContent
                  text={userTextToMarkdown(
                    highlightMentions(
                      m.text,
                      contextNames ?? new Set(),
                      m.mentions?.filter(x => x.kind === 'node').map(x => ({ label: x.label, nodeId: x.refId })),
                    ),
                  )}
                  size="sm"
                  className={isDark ? 'prose-invert' : ''}
                  style={proseVars}
                />
              </CollapsibleUserText>
            )}
            {m.streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 12,
                  background: 'var(--term-select)',
                  marginLeft: 2,
                  verticalAlign: 'middle',
                  animation: 'tblink var(--t-loop-fast) infinite',
                }}
              />
            )}
          </div>
        </div>
        )
      ) : (
        <div
          className="terminal-message terminal-message-assistant"
          data-density={density}
          style={{
            paddingTop: dPadV,
            paddingBottom: dPadV,
            // AI is flush left; user bubble floats independently on the right.
            paddingLeft: 0,
            paddingRight: 0,
            // Explicit 'none' so jsdom serializes borderLeft to '' (asserted by MessageBlock.test.tsx).
            borderLeft: 'none',
            borderRadius: 'var(--term-message-radius, 0px)',
            background: 'transparent',
            color: 'var(--term-fg)',
            fontFamily,
          }}
        >
          {showThoughts && m.plan && m.plan.length > 0 && (
            <TermPlanBlock entries={m.plan} />
          )}
          {!hasAssistantBlocks(m) && showThoughts && m.thought && (
            <TermThoughtBlock text={m.thought} streaming={m.streaming} runtimeId={runtimeId} />
          )}
          {m.streaming && !hasAssistantBlocks(m) && (
            <PendingIndicatorSlot show={!hidePendingIndicator && !m.text && !m.thought && m.toolCalls.length === 0} />
          )}
          {hasAssistantBlocks(m) ? (
            <BlockAssistantBody
              m={m}
              isDark={isDark}
              showThoughts={showThoughts}
              subagents={subagents}
              runtimeId={runtimeId}
              onSmoothingChange={onVisibleSmoothingChange}
              hidePendingIndicator={hidePendingIndicator}
            />
          ) : (
            <LegacyAssistantBody
              m={m}
              isDark={isDark}
              subagents={subagents}
              runtimeId={runtimeId}
              onSmoothingChange={onVisibleSmoothingChange}
            />
          )}
        </div>
      )}
      {!isUser && <SteeringReports reports={m.steeringReports} />}
      {!isUser && workspaceId && backendConnectionId && <PageReceipt tools={m.toolCalls} workspaceId={workspaceId} backendConnectionId={backendConnectionId} variant="conversation" />}
      {!isUser && !m.streaming && isErrorTail && (
        <ErrorTail
          errorMessage={errorMessage}
          errorKind={errorKind}
          errorRecovery={errorRecovery}
          onRetry={onRetry}
          onRunAgain={onRunAgain}
          onTestConnection={onTestConnection}
        />
      )}
      {turnAnchors && turnAnchors.length > 0 && (
        <BranchAnchorsSection anchors={turnAnchors} onOpenBranch={onOpenBranch} />
      )}
      </MessageHighlight>
      </BranchQuoteMarks>
      {!(m.streaming || hideActions) && (
        isUser ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <MessageActions
              visible={hover}
              time={formatMessageTime(m.createdAt)}
              onCopy={onCopy}
              onRetry={onRetry}
              onEdit={onEdit}
              onBranch={onBranch}
              usageInfo={usageInfo}
            />
          </div>
        ) : (
          <MessageActions
            visible={hover}
            time={formatMessageTime(m.createdAt)}
            onCopy={onCopy}
            onRetry={isErrorTail && turnErrorAction(errorKind) === 'inspect-existing-turn' ? undefined : onRetry}
            onEdit={onEdit}
            onBranch={onBranch}
            usageInfo={usageInfo}
          />
        )
      )}
      {decorations?.afterMessage?.(m)}
    </>
  );
  const onMouseEnter = () => setHover(true);
  const onMouseLeave = () => setHover(false);
  // `entrance` never changes, so neither does the root's element type: a
  // settled message keeps a plain div. The null PresenceContext lets the
  // message decide its own entrances: inside an AnimatePresence child that
  // was there on first render, motion would otherwise skip the entrance of
  // everything mounting later (this bubble, arriving thought blocks).
  return (
    <PresenceContext.Provider value={null}>
    <MessageMotionContext.Provider value={motionScope}>
      {entrance ? (
        <motion.div
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          {...entrance}
          style={{ marginBottom: dMarginBottom, ...(isUser ? { originX: 1, originY: 1 } : null) }}
        >
          {contents}
        </motion.div>
      ) : (
        <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ marginBottom: dMarginBottom }}>
          {contents}
        </div>
      )}
    </MessageMotionContext.Provider>
    </PresenceContext.Provider>
  );
}

function usageEqual(
  a: MessageBlockProps['usageInfo'],
  b: MessageBlockProps['usageInfo'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.durationMs === b.durationMs
    && a.credits === b.credits
    && a.unverifiable === b.unverifiable
    && a.totalTokens === b.totalTokens
    && a.inputTokens === b.inputTokens
    && a.cachedInputTokens === b.cachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.reasoningOutputTokens === b.reasoningOutputTokens
    && a.contextUsagePercentage === b.contextUsagePercentage;
}

function childAnchorsEqual(
  a: MessageBlockProps['turnAnchors'],
  b: MessageBlockProps['turnAnchors'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.childNodeId !== right.childNodeId ||
      left.title !== right.title ||
      (left.messageCount ?? 0) !== (right.messageCount ?? 0) ||
      left.createdAt !== right.createdAt ||
      left.status !== right.status ||
      left.quotedText !== right.quotedText ||
      left.question !== right.question ||
      left.reply !== right.reply
    ) {
      return false;
    }
  }
  return true;
}

const MessageBlock = React.memo(MessageBlockInner, (prev, next) =>
  prev.m === next.m &&
  prev.workspaceId === next.workspaceId &&
  prev.backendConnectionId === next.backendConnectionId &&
  prev.index === next.index &&
  prev.isDark === next.isDark &&
  prev.showThoughts === next.showThoughts &&
  prev.fontFamily === next.fontFamily &&
  prev.density === next.density &&
  !!prev.onRetry === !!next.onRetry &&
  !!prev.onEdit === !!next.onEdit &&
  prev.editing === next.editing &&
  usageEqual(prev.usageInfo, next.usageInfo) &&
  !!prev.isErrorTail === !!next.isErrorTail &&
  prev.errorMessage === next.errorMessage &&
  prev.errorKind === next.errorKind &&
  prev.errorRecovery === next.errorRecovery &&
  prev.onRunAgain === next.onRunAgain &&
  prev.onTestConnection === next.onTestConnection &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  childAnchorsEqual(prev.quoteAnchors, next.quoteAnchors) &&
  childAnchorsEqual(prev.turnAnchors, next.turnAnchors) &&
  prev.onOpenBranch === next.onOpenBranch &&
  prev.contextNames === next.contextNames &&
  prev.onMentionClick === next.onMentionClick &&
  prev.onVisibleSmoothingChange === next.onVisibleSmoothingChange &&
  !!prev.hidePendingIndicator === !!next.hidePendingIndicator &&
  prev.highlight === next.highlight,
  // `fresh` is left out on purpose: it is read on mount only and turns false
  // a second later, which must not re-render every recent message.
);

export { MessageBlock };
export type { MessageBlockProps };
