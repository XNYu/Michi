import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantBlock, ChatMessage, ToolCallState, SubagentInfo, UserInputRequest } from '../../state/chatTypes';
import { isRunningStatus } from './toolCallGrouping';
import { ToolCallGroup } from './ToolCallGroup';
import { type TerminalDensity } from '../../state/prefs';
import type { PlanEntry } from '../../services/api';
import MarkdownContent from '../MarkdownContent';
import { QuoteChip } from './QuoteChip';
import { AttachmentPills } from './AttachmentPills';
import { CommentChips } from './CommentChips';
import {
  carryEqual,
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
import { BranchAnchorRow } from './BranchAnchorRow';
import { ImageBlockView } from './ImageBlockView';
import { streamingMarkdownBlocksEnabled } from './streamingMarkdownBlocksFlag';
import { ResolvedUserInput } from './UserInputBanner';
import { BranchIcon, CheckIcon, CopyIcon, EditIcon, RetryIcon } from './icons';

const StreamingMarkdownContent = React.lazy(() => import('./StreamingMarkdownContent'));

/**
 * Context providing the current node's pendingUserInput so that inline
 * user-input segments can render without prop-drilling through memoized layers.
 */
export const NodeUserInputContext = createContext<UserInputRequest | null | undefined>(undefined);

/** Renders a user-input segment inline within the weave pipeline. */
function InlineUserInputSegment({ requestId }: { requestId: number }) {
  const ui = useContext(NodeUserInputContext);
  if (ui && ui.requestId === requestId && ui.resolved) {
    return <ResolvedUserInput userInput={ui} />;
  }
  // Not resolved yet — the interactive banner is rendered as a TPane overlay.
  return null;
}

function formatMessageTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
  usageInfo?: { durationMs: number; credits: number } | null;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const btnStyle: React.CSSProperties = {
    padding: 4,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--term-muted)',
    border: 'none',
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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          opacity: visible ? 1 : 0,
          transition: 'opacity 120ms ease-out',
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
            style={{ fontSize: 10, fontFamily: 'var(--ui-font)', color: 'var(--term-faint)', marginLeft: 4 }}
          >
            {time}
          </span>
        )}
      </div>
      {hasUsage && (
        <span style={{ fontSize: 10, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)' }}>
          {(usageInfo.durationMs / 1000).toFixed(1)}s
          {usageInfo.credits > 0 && ` · ${usageInfo.credits.toFixed(2)} credits`}
        </span>
      )}
    </div>
  );
}

function TermPlanBlock({ entries }: { entries: PlanEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ borderLeft: '2px solid var(--term-muted)', paddingLeft: 8, marginBottom: 8, fontSize: 11 }}>
      <div style={{ fontSize: 9.5, color: 'var(--term-muted)', letterSpacing: '.12em', marginBottom: 4, fontFamily: 'var(--ui-font)' }}>
        PLAN
      </div>
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, lineHeight: 1.5, color: e.status === 'completed' ? 'var(--term-muted)' : 'var(--term-fg)' }}>
          <span style={{ fontFamily: 'var(--ui-font)', fontSize: 10, flexShrink: 0 }}>
            {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '·'}
          </span>
          <span style={{ textDecoration: e.status === 'completed' ? 'line-through' : 'none' }}>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

// Tail-mode height cap: ~7 lines at line-height 1.5, font-size 11px.
const THOUGHT_TAIL_MAX_HEIGHT = 7 * 11 * 1.5;

type ThoughtMode = 'tail' | 'expanded' | 'collapsed';

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
            <span style={{ opacity: done ? 0.5 : 1, fontSize: 10 }}>
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

function TermThoughtBlock({
  text,
  streaming,
  children,
  toolCount,
  runtimeId,
}: {
  text: string;
  streaming?: boolean;
  children?: React.ReactNode;
  toolCount?: number;
  runtimeId?: string | null;
}) {
  // Default mode: tail while streaming, collapsed once finished.
  // User clicks cycle: tail/collapsed → expanded → (streaming ? tail : collapsed).
  const [userMode, setUserMode] = useState<ThoughtMode | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);

  // Once streaming flips false, drop any sticky 'tail' override so the block
  // auto-collapses to 0 rows. 'expanded' is preserved (user is reading).
  useEffect(() => {
    if (!streaming && userMode === 'tail') setUserMode(null);
  }, [streaming, userMode]);

  const mode: ThoughtMode = userMode ?? (streaming ? 'tail' : 'collapsed');

  // Pin tail-mode scroll to the bottom as new tokens arrive.
  useEffect(() => {
    if (mode === 'tail' && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
    if (mode === 'expanded' && streaming && expandedRef.current) {
      expandedRef.current.scrollTop = expandedRef.current.scrollHeight;
    }
  }, [text, mode, streaming]);

  if (!text && !children) return null;

  const handleToggle = () => {
    if (mode === 'expanded') {
      // Expanded → tail (still streaming) or collapsed (done).
      setUserMode(streaming ? 'tail' : 'collapsed');
    } else {
      // Tail or collapsed → expanded.
      setUserMode('expanded');
    }
  };

  const marker = mode === 'expanded' ? '▾' : '▸';
  const codexStepCount = runtimeId === 'codex'
    ? text.split('\n').filter((s) => s.trim().length > 0).length
    : 0;
  const headerLabel = mode === 'expanded'
    ? 'HIDE REASONING'
    : toolCount && toolCount > 0
      ? `WORKED THROUGH ${toolCount} ${toolCount === 1 ? 'STEP' : 'STEPS'}`
      : runtimeId === 'codex' && codexStepCount > 0 && !streaming
        ? `WORKED THROUGH ${codexStepCount} ${codexStepCount === 1 ? 'STEP' : 'STEPS'}`
        : 'THINKING';

  return (
    <div style={{ marginBottom: 8, fontSize: 11 }}>
      <div
        onClick={handleToggle}
        style={{
          cursor: 'pointer',
          fontSize: 9.5,
          color: 'var(--term-muted)',
          letterSpacing: '.12em',
          fontFamily: 'var(--ui-font)',
          userSelect: 'none',
        }}
      >
        {marker} {headerLabel}
      </div>
      {mode === 'tail' && (
        <div
          ref={tailRef}
          style={{
            paddingLeft: 8,
            borderLeft: '2px solid var(--term-line)',
            color: 'var(--term-muted)',
            fontStyle: 'italic',
            lineHeight: 1.5,
            marginTop: 4,
            maxHeight: THOUGHT_TAIL_MAX_HEIGHT,
            overflow: 'hidden',
          }}
        >
          {runtimeId === 'codex' ? (
            <CodexStepList text={text} streaming={streaming} />
          ) : (
            <MarkdownContent
              text={text}
              size="xs"
              style={thoughtProseVars}
              className="[&_a]:underline"
            />
          )}
          {children}
        </div>
      )}
      {mode === 'expanded' && (
        <div
          ref={expandedRef}
          style={{
            paddingLeft: 8,
            borderLeft: '2px solid var(--term-line)',
            color: 'var(--term-muted)',
            fontStyle: 'italic',
            lineHeight: 1.5,
            marginTop: 4,
          }}
        >
          {runtimeId === 'codex' ? (
            <CodexStepList text={text} streaming={streaming} />
          ) : (
            <MarkdownContent
              text={text}
              size="xs"
              style={thoughtProseVars}
              className="[&_a]:underline"
            />
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function ThinkingIndicator() {
  // Three bouncing dots — purely a "something is happening" placeholder
  // shown only while the assistant has streaming=true but no blocks/text/
  // thought/tools have arrived yet. Replaces the older "Thinking…" copy
  // which overclaimed what was actually happening (mostly network wait,
  // not reasoning). Reuses the existing bounce-dot @keyframes in index.css.
  return (
    <div
      style={{ padding: '6px 0', animation: 'fadeIn .3s ease' }}
      aria-label="loading"
      role="status"
    >
      <span className="typing-dot" />
      <span className="typing-dot" style={{ animationDelay: '.15s' }} />
      <span className="typing-dot" style={{ animationDelay: '.3s' }} />
    </div>
  );
}

/**
 * Wrap @contextName tokens in the user message with `<span class="mention-chip">`
 * so they render as styled clickable chips. Matches known context names greedily
 * (longest first) so names with spaces resolve correctly.
 */
export function highlightMentions(text: string, contextNames: ReadonlySet<string>): string {
  if (contextNames.size === 0) return text;
  // Sort names longest-first so "foo bar" matches before "foo".
  const sorted = [...contextNames].sort((a, b) => b.length - a.length);
  let result = text;
  for (const name of sorted) {
    // Build a case-insensitive pattern for this specific name after @
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|(?<=\\s))@(${escaped})(?=\\s|[,;:!?）)}\\]"]|$)`, 'giu');
    result = result.replace(re, (full, matched: string) => {
      const htmlEsc = matched.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<span class="mention-chip" data-mention="${htmlEsc}">@${htmlEsc}</span>`;
    });
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
              />
            )}
          >
            <StreamingMarkdownContent
              text={seg.text}
              size="sm"
              className={isDark ? 'prose-invert' : ''}
              style={proseVars}
              revealTailChars={seg.revealTailChars}
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
        />
      );
    }
    if (seg.kind === 'user-input') {
      chipIdx += 1;
      return <InlineUserInputSegment key={`ui-${seg.requestId}`} requestId={seg.requestId} />;
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
  useEffect(() => {
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
}

function ThinkingRunViewInner({ blocks, tools, streaming, subagents, runtimeId }: ThinkingRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const text = useMemo(() => thinkingRunRawText(blocks), [blocks]);
  const groups = useMemo(() => thinkingToolGroups(blocks, toolsById), [blocks, toolsById]);
  const toolCount = useMemo(() => groups.reduce((n, g) => n + g.length, 0), [groups]);
  return (
    <TermThoughtBlock text={text} streaming={streaming} toolCount={toolCount} runtimeId={runtimeId}>
      {groups.length > 0
        ? groups.map((group) => (
            <ToolCallGroup
              key={group[0].id}
              tools={group}
              defaultExpanded={group.some((t) => isRunningStatus(t.status))}
              subagents={subagents}
            />
          ))
        : null}
    </TermThoughtBlock>
  );
}

const ThinkingRunView = React.memo(ThinkingRunViewInner, (prev, next) =>
  sameBlockRefs(prev.blocks, next.blocks) &&
  sameToolRefs(prev.tools, next.tools) &&
  prev.streaming === next.streaming &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId,
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
  useEffect(() => {
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
}: {
  m: ChatMessage;
  isDark: boolean;
  showThoughts: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  onSmoothingChange?: (isSmoothing: boolean) => void;
}) {
  const runs = useMemo(() => splitAssistantRuns(m.blocks), [m.blocks]);
  const byId = useMemo(() => toolMap(m.toolCalls), [m.toolCalls]);
  // Backward scans (no array copy). `runs` is rebuilt every chunk as blocks
  // grow, so the old [...runs].reverse().find() copied+reversed on every
  // streamed token of the actively-rendering message.
  const tailAnswerRunId = useMemo(() => {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].kind === 'answer') return runs[i].id;
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
  useEffect(() => {
    if (!tailAnswerRunId) onSmoothingChange?.(false);
  }, [onSmoothingChange, tailAnswerRunId]);
  return (
    <>
      {runs.map((run: AssistantRun) => {
        const tools = relevantTools(run.blocks, byId);
        if (run.kind === 'image') {
          return <ImageBlockView key={run.id} blocks={run.blocks} />;
        }
        if (run.kind === 'thinking') {
          if (!showThoughts) return null;
          return (
            <ThinkingRunView
              key={run.id}
              blocks={run.blocks}
              tools={tools}
              streaming={run.id === liveThinkingId}
              subagents={subagents}
              runtimeId={runtimeId}
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
      {m.streaming && runs.length === 0 && <ThinkingIndicator />}
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
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clampHeight, setClampHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
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
        style={
          collapsed && clampHeight != null
            ? { maxHeight: clampHeight, overflow: 'hidden' }
            : undefined
        }
      >
        {children}
      </div>
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
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="t-hover-fg"
          style={{
            marginTop: 4,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
            fontSize: 11.5,
            color: 'var(--term-muted)',
            letterSpacing: '.02em',
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

interface MessageBlockProps {
  m: ChatMessage;
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
  usageInfo?: { durationMs: number; credits: number } | null;
  isErrorTail?: boolean;
  errorMessage?: string;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
  editing?: boolean;
  onEditSave?: (newText: string) => void;
  onEditCancel?: () => void;
  /**
   * Child branch anchors whose quotedText was found inside this message.
   * v1: reserved for future quote-underline rendering; not consumed yet.
   * When implemented, these will be rendered as BranchQuoteUnderline spans
   * inside the MarkdownContent render tree rather than as turn markers.
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
  onMentionClick?: (name: string) => void;
  /** Reports whether the visible typewriter is still catching up to raw text. */
  onVisibleSmoothingChange?: (isSmoothing: boolean) => void;
}

function MessageBlockInner({
  m,
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
  subagents,
  runtimeId,
  turnAnchors,
  onOpenBranch,
  contextNames,
  onMentionClick,
  onVisibleSmoothingChange,
  editing,
  onEditSave,
  onEditCancel,
}: MessageBlockProps) {
  const [hover, setHover] = useState(false);
  const [editText, setEditText] = useState(m.text);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);
  const isUser = m.role === 'user';

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
  // Density only adjusts rhythm (leading/tracking), never type size — the
  // slider is the single source of truth for font size. Mirrors the values
  // applied to assistant prose via .terminal-message[data-density=*] in
  // index.css so the two bubbles breathe in sync.
  const dMsgLineHeight = density === 'dense' ? 1.3 : density === 'compact' ? 1.45 : 1.6;
  const dMsgLetterSpacing =
    density === 'dense' ? '-0.005em' : density === 'compact' ? '0' : '0.01em';
  // Assistant-only inline vertical padding. The user bubble's padding lives in
  // index.css (paper-card recipe) and scales via the [data-density] attribute.
  const dPadV = density === 'dense' ? 4 : density === 'compact' ? 5 : 6;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        marginBottom: dMarginBottom,
        animation: 'fadeIn 0.18s ease-out both',
      }}
    >
      {!isUser && (
        <div
          style={{
            color: 'var(--term-muted)',
            fontSize: dLabelFontSize,
            marginBottom: dLabelMarginBottom,
            textAlign: 'left',
          }}
        >
          {'> michi'}
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
            className="terminal-message terminal-message-user"
            data-density={density}
            onClick={onMentionClick ? (e) => {
              const chip = (e.target as HTMLElement).closest('[data-mention]');
              if (chip) onMentionClick((chip as HTMLElement).dataset.mention!);
            } : undefined}
            style={{
              fontFamily: 'var(--ui-font)',
              lineHeight: dMsgLineHeight,
              letterSpacing: dMsgLetterSpacing,
              color: 'var(--term-fg)',
              wordBreak: 'break-word',
            }}
          >
            <span className="bubble-overline">
              <b>you</b>
              {(() => { const t = formatMessageTime(m.createdAt); return t ? ` · ${t}` : ''; })()}
            </span>
            {m.comments && m.comments.length > 0 && <CommentChips comments={m.comments} />}
            {m.quotedText && <QuoteChip text={m.quotedText} />}
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentPills items={m.attachments} />
            )}
            {m.streaming ? (
              <MarkdownContent
                text={userTextToMarkdown(
                  contextNames && contextNames.size > 0 ? highlightMentions(m.text, contextNames) : m.text,
                )}
                size="sm"
                className={isDark ? 'prose-invert' : ''}
                style={proseVars}
              />
            ) : (
              <CollapsibleUserText contentKey={m.text}>
                <MarkdownContent
                  text={userTextToMarkdown(
                    contextNames && contextNames.size > 0 ? highlightMentions(m.text, contextNames) : m.text,
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
                  animation: 'tblink 1s infinite',
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
          {m.streaming && !hasAssistantBlocks(m) && !m.text && !m.thought && m.toolCalls.length === 0 && (
            <ThinkingIndicator />
          )}
          {hasAssistantBlocks(m) ? (
            <BlockAssistantBody
              m={m}
              isDark={isDark}
              showThoughts={showThoughts}
              subagents={subagents}
              runtimeId={runtimeId}
              onSmoothingChange={onVisibleSmoothingChange}
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
      {!isUser && !m.streaming && isErrorTail && (
        <div
          style={{
            marginTop: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 11,
                letterSpacing: '.04em',
                color: 'var(--term-danger)',
              }}
            >
              failed
            </span>
            <span
              style={{
                color: 'var(--term-danger)',
                opacity: 0.5,
              }}
            >
              ·
            </span>
            <button
              type="button"
              data-testid="error-tail-retry"
              onClick={(e) => { e.stopPropagation(); onRetry?.(); }}
              style={{
                border: '1px solid var(--term-danger)',
                color: 'var(--term-danger)',
                padding: '1px 8px',
                font: '600 11px var(--ui-font)',
                letterSpacing: '.04em',
                background: 'transparent',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--term-danger-f, rgba(168,38,26,0.08))';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              ↻ retry
            </button>
          </div>
          {errorMessage && (
            <div
              style={{
                marginTop: 6,
                maxWidth: 720,
                color: 'var(--term-danger)',
                opacity: 0.82,
                font: '11px var(--ui-font)',
                lineHeight: 1.45,
                overflowWrap: 'anywhere',
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>
      )}
      {turnAnchors && turnAnchors.length > 0 && (
        <>
          {turnAnchors.map((a) => (
            <BranchAnchorRow
              key={`anchor-${a.childNodeId}`}
              title={a.title}
              messageCount={a.messageCount ?? 0}
              createdAt={a.createdAt}
              streaming={a.status === 'streaming'}
              onOpen={() => onOpenBranch?.(a.childNodeId)}
            />
          ))}
        </>
      )}
      {!m.streaming && (
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
            onRetry={onRetry}
            onEdit={onEdit}
            onBranch={onBranch}
            usageInfo={usageInfo}
          />
        )
      )}
    </div>
  );
}

function usageEqual(
  a: MessageBlockProps['usageInfo'],
  b: MessageBlockProps['usageInfo'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.durationMs === b.durationMs && a.credits === b.credits;
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
      left.quotedText !== right.quotedText
    ) {
      return false;
    }
  }
  return true;
}

const MessageBlock = React.memo(MessageBlockInner, (prev, next) =>
  prev.m === next.m &&
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
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  childAnchorsEqual(prev.quoteAnchors, next.quoteAnchors) &&
  childAnchorsEqual(prev.turnAnchors, next.turnAnchors) &&
  prev.onOpenBranch === next.onOpenBranch &&
  prev.contextNames === next.contextNames &&
  prev.onMentionClick === next.onMentionClick &&
  prev.onVisibleSmoothingChange === next.onVisibleSmoothingChange,
);

export { MessageBlock };
export type { MessageBlockProps };
