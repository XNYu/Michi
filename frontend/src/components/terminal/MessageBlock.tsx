import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AssistantBlock, ChatMessage, ToolCallState, SubagentInfo } from '../../state/chatTypes';
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

const StreamingMarkdownContent = React.lazy(() => import('./StreamingMarkdownContent'));

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
  usageInfo,
}: {
  visible: boolean;
  time: string;
  onCopy: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  usageInfo?: { durationMs: number; credits: number } | null;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const btnStyle: React.CSSProperties = {
    cursor: 'pointer',
    padding: '2px 6px',
    fontSize: 10.5,
    fontFamily: 'var(--ui-font)',
    color: 'var(--term-muted)',
    background: 'transparent',
    border: 'none',
    letterSpacing: '.04em',
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
          gap: 4,
          opacity: visible ? 1 : 0,
          transition: 'opacity 120ms ease-out',
          pointerEvents: visible ? 'auto' : 'none',
        }}
      >
        {time && (
          <span
            style={{ fontSize: 10, fontFamily: 'var(--ui-font)', color: 'var(--term-faint)', marginRight: 4 }}
          >
            {time}
          </span>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            className="t-hover-fg"
            style={btnStyle}
            title="retry this turn"
          >
            ↻ retry
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="t-hover-fg"
            style={btnStyle}
            title="edit and resend"
          >
            ✎ edit
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleCopy(); }}
          className="t-hover-fg"
          style={btnStyle}
          title="copy message"
        >
          {copied ? '✓ copied' : '⎘ copy'}
        </button>
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

function TermThoughtBlock({
  text,
  streaming,
  children,
  toolCount,
}: {
  text: string;
  streaming?: boolean;
  children?: React.ReactNode;
  toolCount?: number;
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
  const headerLabel = mode === 'expanded'
    ? 'HIDE REASONING'
    : toolCount && toolCount > 0
      ? `WORKED THROUGH ${toolCount} ${toolCount === 1 ? 'STEP' : 'STEPS'}`
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
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
            marginTop: 4,
            maxHeight: THOUGHT_TAIL_MAX_HEIGHT,
            overflow: 'hidden',
          }}
        >
          {text}
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
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
            marginTop: 4,
          }}
        >
          {text}
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
}

function AnswerRunViewInner({ blocks, tools, incomingCarry, isDark, subagents, runtimeId }: AnswerRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const { segments, isSmoothing } = useAnswerRunStream(blocks, toolsById, incomingCarry, runtimeId);
  const streaming = blocks.some((b) => b.kind === 'answer' && b.streaming);
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
  prev.runtimeId === next.runtimeId,
);

interface ThinkingRunViewProps {
  blocks: AssistantBlock[];
  tools: ToolCallState[];
  streaming: boolean;
  subagents?: readonly SubagentInfo[];
}

function ThinkingRunViewInner({ blocks, tools, streaming, subagents }: ThinkingRunViewProps) {
  const toolsById = useMemo(() => toolMap(tools), [tools]);
  const text = useMemo(() => thinkingRunRawText(blocks), [blocks]);
  const groups = useMemo(() => thinkingToolGroups(blocks, toolsById), [blocks, toolsById]);
  const toolCount = useMemo(() => groups.reduce((n, g) => n + g.length, 0), [groups]);
  return (
    <TermThoughtBlock text={text} streaming={streaming} toolCount={toolCount}>
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
  prev.subagents === next.subagents,
);

function LegacyAssistantBody({
  m,
  isDark,
  subagents,
  runtimeId,
}: {
  m: ChatMessage;
  isDark: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
}) {
  const { segments, isSmoothing } = useVisibleStream(m, runtimeId);
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
}: {
  m: ChatMessage;
  isDark: boolean;
  showThoughts: boolean;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
}) {
  const runs = useMemo(() => splitAssistantRuns(m.blocks), [m.blocks]);
  const byId = useMemo(() => toolMap(m.toolCalls), [m.toolCalls]);
  const liveThinkingId = useMemo(
    () => [...runs].reverse().find((run) =>
      run.kind === 'thinking' && run.blocks.some((b) => b.kind === 'thinking' && b.streaming),
    )?.id,
    [runs],
  );
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
          />
        );
      })}
      {m.streaming && runs.length === 0 && <ThinkingIndicator />}
    </>
  );
}

interface MessageBlockProps {
  m: ChatMessage;
  index: number;
  isDark: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  onCopy: () => void;
  showThoughts: boolean;
  fontFamily: string;
  density: TerminalDensity;
  usageInfo?: { durationMs: number; credits: number } | null;
  isErrorTail?: boolean;
  errorMessage?: string;
  subagents?: readonly SubagentInfo[];
  runtimeId?: string | null;
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
}

function MessageBlockInner({
  m,
  index,
  isDark,
  onRetry,
  onEdit,
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
}: MessageBlockProps) {
  const [hover, setHover] = useState(false);
  const isUser = m.role === 'user';
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
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            className="terminal-message terminal-message-user"
            data-density={density}
            style={{
              // The paper-card recipe (background, border-right accent, drop
              // shadow, padding, max-width) lives in index.css. Only the
              // typography/density/wrap inline styles stay here.
              fontFamily: 'var(--ui-font)',
              // Font size inherits from .terminal-message (slider-driven).
              // Density only adjusts leading + tracking.
              lineHeight: dMsgLineHeight,
              letterSpacing: dMsgLetterSpacing,
              color: 'var(--term-fg)',
              wordBreak: 'break-word',
            }}
          >
            <span className="bubble-overline">
              <b>you</b>
              {(() => {
                const t = formatMessageTime(m.createdAt);
                return t ? ` · ${t}` : '';
              })()}
            </span>
            {m.comments && m.comments.length > 0 && <CommentChips comments={m.comments} />}
            {m.quotedText && <QuoteChip text={m.quotedText} />}
            {m.attachments && m.attachments.length > 0 && (
              <AttachmentPills items={m.attachments} />
            )}
            <MarkdownContent
              text={userTextToMarkdown(m.text)}
              size="sm"
              className={isDark ? 'prose-invert' : ''}
              style={proseVars}
            />
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
            <TermThoughtBlock text={m.thought} streaming={m.streaming} />
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
            />
          ) : (
            <LegacyAssistantBody m={m} isDark={isDark} subagents={subagents} runtimeId={runtimeId} />
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
  usageEqual(prev.usageInfo, next.usageInfo) &&
  !!prev.isErrorTail === !!next.isErrorTail &&
  prev.errorMessage === next.errorMessage &&
  prev.subagents === next.subagents &&
  prev.runtimeId === next.runtimeId &&
  childAnchorsEqual(prev.quoteAnchors, next.quoteAnchors) &&
  childAnchorsEqual(prev.turnAnchors, next.turnAnchors) &&
  prev.onOpenBranch === next.onOpenBranch,
);

export { MessageBlock };
export type { MessageBlockProps };
