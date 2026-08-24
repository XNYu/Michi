import React, { useEffect, useRef, useState } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import {
  toolBucketKey,
  prettifyToolTitle,
  isFailedStatus,
  isRunningStatus,
  isTerminalStatus,
  toolDurationMs,
  toolRowDetail,
  toolSpanMs,
  formatDurationMs,
  formatToolPayload,
  subagentToolInfo,
  subagentHeading,
  subagentStatusLabel,
  summarizeToolsBase,
  failedToolCount,
  findOwningSubagent,
  type SubagentToolInfo,
  type BucketKey,
} from './toolCallGrouping';

/**
 * Alternate chromes for the agent blocks (tool groups + subagents), from the
 * 2026-08 "Agent Blocks Redesign" exploration:
 *
 *   'card'     (1b) — every block is a hairline square-corner card on
 *                     --term-surface: type icons on the left, a status column
 *                     (✓ / spinner / FAILED) on the right, hairline row
 *                     separators. Subagents are nested cards with an alt
 *                     header strip.
 *   'terminal' (1d) — bare text, but ordered: ❯ / ✓ / × glyphs in a fixed
 *                     14px column, tracking-caps section headers with leader
 *                     rules, right-aligned mono durations. Only payloads and
 *                     subagents get containers.
 *
 * ToolCallGroup.tsx owns the expand/collapse state machine and dispatches
 * here; MessageBlock.tsx pulls the small shared parts (spinner, sparkle,
 * live timer) for the thinking block chrome.
 */

const MONO = 'var(--font-mono)';
const SCROLL_THRESHOLD = 5;
const SCROLL_MAX_HEIGHT = 160;

/* ── Shared parts ────────────────────────────────────────────────────── */

export function CardSpinner() {
  return <span aria-hidden className="agent-spinner" />;
}

function iconPaths(key: BucketKey | 'subagent'): React.ReactNode {
  switch (key) {
    case 'read':
      return (
        <>
          <path d="M3.5 1.5h4.6l2.4 2.4v8.6h-7z" />
          <path d="M8 1.5v2.6h2.5" />
        </>
      );
    case 'grep':
    case 'glob':
      return (
        <>
          <circle cx="6" cy="6" r="3.6" />
          <path d="M8.8 8.8l3 3" />
        </>
      );
    case 'edit':
    case 'write':
      return <path d="M9.6 2.2l2.2 2.2-7.4 7.4-2.9.7.7-2.9z" />;
    case 'subagent':
      return <path d="M7 1.6L8.3 5.7 12.4 7 8.3 8.3 7 12.4 5.7 8.3 1.6 7 5.7 5.7z" />;
    case 'bash':
    case 'unknown':
    default:
      return (
        <>
          <path d="M2.5 4l3 3-3 3" />
          <path d="M7.5 10.5h4" />
        </>
      );
  }
}

export function ToolTypeIcon({
  kind,
  size = 13,
  color,
}: {
  kind: BucketKey | 'subagent';
  size?: number;
  color: string;
}) {
  return (
    <span aria-hidden style={{ color, display: 'inline-flex', flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
        {iconPaths(kind)}
      </svg>
    </span>
  );
}

/** The 1b sparkle — thinking blocks and subagent headers. */
export function SparkleIcon({ size = 13, color }: { size?: number; color: string }) {
  return <ToolTypeIcon kind="subagent" size={size} color={color} />;
}

function CheckIcon({ color = 'var(--term-muted)' }: { color?: string }) {
  return (
    <span aria-hidden style={{ color, display: 'inline-flex', flexShrink: 0 }}>
      <svg width={10} height={10} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M2.5 7.5l3 3 6-6.5" />
      </svg>
    </span>
  );
}

/** Live "8s" seconds counter for streaming headers (1b thinking card). */
export function LiveTimerLabel({ active }: { active: boolean }) {
  const startRef = useRef<number | null>(null);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (startRef.current == null) startRef.current = Date.now();
    const id = setInterval(() => {
      setSec(Math.floor((Date.now() - startRef.current!) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || sec < 1) return null;
  return (
    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: 'var(--term-faint)', flexShrink: 0 }}>
      {sec}s
    </span>
  );
}

/** Breathing 5px accent dot + status word — subagent header status. */
function SubagentStatus({ status }: { status: string | undefined }) {
  const failed = isFailedStatus(status);
  const running = isRunningStatus(status);
  const color = failed ? 'var(--term-danger)' : running ? 'var(--term-accent)' : 'var(--term-muted)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      {running ? (
        <span className="term-dot-i term-dot-i--run" />
      ) : failed ? (
        <span aria-hidden style={{ color, fontSize: 10, lineHeight: 1 }}>×</span>
      ) : (
        <span className="term-dot-i" />
      )}
      <span style={{ fontSize: 10, color }}>{subagentStatusLabel(status)}</span>
    </span>
  );
}

function clampText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Failed rows auto-open their payload; a user toggle wins (same contract as
 *  the plain variant's ToolRow). */
function usePayloadOpen(failed: boolean, hasPayload: boolean) {
  const [open, setOpen] = useState(failed && hasPayload);
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (failed && hasPayload && !userToggledRef.current) setOpen(true);
  }, [failed, hasPayload]);
  const toggle = () => {
    userToggledRef.current = true;
    setOpen((o) => !o);
  };
  return { open, toggle };
}

/** Keep long expanded lists pinned to the newest row unless the user
 *  scrolled away (same contract as the plain variant). */
function useStickyList(depLen: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [depLen]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };
  return { listRef, onScroll };
}

interface VariantGroupProps {
  tools: ToolCallState[];
  expanded: boolean;
  onToggle: () => void;
  subagents?: readonly SubagentInfo[];
}

function partition(tools: ToolCallState[]) {
  const normal: ToolCallState[] = [];
  const subs: Array<{ t: ToolCallState; info: SubagentToolInfo }> = [];
  for (const t of tools) {
    const info = subagentToolInfo(t);
    if (info) subs.push({ t, info });
    else normal.push(t);
  }
  return { normal, subs };
}

/* ══ 1b · Card variant ═══════════════════════════════════════════════── */

const CARD_BORDER = '1px solid var(--term-line)';
const CAP_LABEL: React.CSSProperties = {
  fontSize: 8.5,
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'var(--term-faint)',
  fontFamily: 'var(--ui-font)',
};

function FailedBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 9,
        letterSpacing: '.06em',
        border: '1px solid var(--term-danger)',
        color: 'var(--term-danger)',
        padding: '1px 5px',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function cardToolName(t: ToolCallState): string {
  const key = toolBucketKey(t);
  if (key !== 'unknown') return key.charAt(0).toUpperCase() + key.slice(1);
  return prettifyToolTitle(t.title) || t.kind || '(unnamed)';
}

function CardPayload({ t }: { t: ToolCallState }) {
  const failed = isFailedStatus(t.status);
  const preStyle: React.CSSProperties = {
    fontFamily: MONO,
    fontSize: 10,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--term-mid)',
    padding: '0 11px 7px',
    margin: 0,
  };
  return (
    <div
      className="term-scrollbar"
      style={{ borderTop: CARD_BORDER, background: 'var(--term-alt)', maxHeight: 200, overflowY: 'auto' }}
    >
      {t.inputJson && (
        <>
          <div style={{ ...CAP_LABEL, padding: '5px 11px 2px' }}>input</div>
          <pre style={preStyle}>{formatToolPayload(t.inputJson)}</pre>
        </>
      )}
      {t.output && (
        <>
          <div style={{ ...CAP_LABEL, padding: '2px 11px 2px', borderTop: t.inputJson ? CARD_BORDER : undefined }}>
            output
          </div>
          <pre style={{ ...preStyle, color: failed ? 'var(--term-danger)' : 'var(--term-mid)', padding: '0 11px 8px' }}>
            {formatToolPayload(t.output)}
          </pre>
        </>
      )}
    </div>
  );
}

function CardToolRow({ t }: { t: ToolCallState }) {
  const failed = isFailedStatus(t.status);
  const running = isRunningStatus(t.status);
  const hasPayload = !!(t.inputJson || t.output);
  const { open, toggle } = usePayloadOpen(failed, hasPayload);
  const durMs = toolDurationMs(t);
  const detail = toolRowDetail(t);
  const iconColor = failed ? 'var(--term-danger)' : running ? 'var(--term-accent)' : 'var(--term-muted)';
  return (
    <div style={{ borderTop: CARD_BORDER }}>
      <div
        onClick={hasPayload ? toggle : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '6px 11px',
          cursor: hasPayload ? 'pointer' : 'default',
          background: running ? 'color-mix(in srgb, var(--term-accent) 5%, transparent)' : undefined,
        }}
      >
        <ToolTypeIcon kind={toolBucketKey(t)} color={iconColor} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: failed ? 'var(--term-danger)' : 'var(--term-fg)',
            flexShrink: 0,
          }}
        >
          {cardToolName(t)}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: running ? 'var(--term-mid)' : 'var(--term-muted)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail ?? ''}
        </span>
        {failed ? (
          <FailedBadge label="FAILED" />
        ) : running ? (
          <CardSpinner />
        ) : (
          <>
            {durMs != null && (
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-faint)', flexShrink: 0 }}>
                {formatDurationMs(durMs)}
              </span>
            )}
            <CheckIcon />
          </>
        )}
      </div>
      {open && hasPayload && <CardPayload t={t} />}
    </div>
  );
}

function CardSubagent({
  t,
  info,
  currentTool,
  embedded,
}: {
  t: ToolCallState;
  info: SubagentToolInfo;
  currentTool: string | undefined;
  embedded?: boolean;
}) {
  const running = isRunningStatus(t.status);
  const mission = clampText(info.description ?? info.prompt, 180);
  const badgeStyle: React.CSSProperties = {
    border: '1px solid var(--term-line-s)',
    color: 'var(--term-muted)',
    padding: '1px 5px',
    flexShrink: 0,
  };
  return (
    <div
      data-testid="subagent-card"
      style={{ border: embedded ? undefined : CARD_BORDER, borderTop: embedded ? CARD_BORDER : undefined, background: 'var(--term-surface)', fontFamily: 'var(--ui-font)' }}
    >
      <div style={{ background: 'var(--term-alt)', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SparkleIcon size={12} color="var(--term-mauve)" />
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: 'var(--term-fg)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {info.agentType ?? 'SubAgent'}
        </span>
        <span style={{ ...badgeStyle, fontSize: 8.5, letterSpacing: '.08em', textTransform: 'uppercase' }}>
          subagent
        </span>
        {info.model && <span style={{ ...badgeStyle, fontFamily: MONO, fontSize: 9 }}>{info.model}</span>}
        <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex' }}>
          <SubagentStatus status={t.status} />
        </span>
      </div>
      <div style={{ padding: '8px 10px' }}>
        {mission && <div style={{ fontSize: 11, color: 'var(--term-mid)', lineHeight: 1.5 }}>{mission}</div>}
        {running && currentTool && (
          <div
            style={{
              marginTop: mission ? 7 : 0,
              border: CARD_BORDER,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: MONO,
              fontSize: 10,
            }}
          >
            <span style={{ color: 'var(--term-faint)' }}>now</span>
            <span
              style={{
                color: 'var(--term-accent)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {currentTool}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function CardToolGroup({ tools, expanded, onToggle, subagents }: VariantGroupProps) {
  const { normal, subs } = partition(tools);
  const failed = failedToolCount(tools);
  const running = tools.some((t) => !isTerminalStatus(t.status));
  const doneCount = tools.filter((t) => isTerminalStatus(t.status)).length;
  const spanMs = running ? undefined : toolSpanMs(tools);
  const { listRef, onScroll } = useStickyList(tools.length);

  const container: React.CSSProperties = {
    fontFamily: 'var(--ui-font)',
    marginTop: 12,
    marginBottom: 10,
  };

  // Pure subagent groups (the spawn_branches case) render as standalone
  // subagent cards — a "1 tool calls" header card around them is noise.
  if (normal.length === 0 && subs.length > 0) {
    if (!expanded) {
      return (
        <div style={container}>
          <CollapsedCardRow tools={tools} onToggle={onToggle} failed={failed} running={running} doneCount={doneCount} spanMs={spanMs} />
        </div>
      );
    }
    return (
      <div style={{ ...container, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {subs.map(({ t, info }) => (
          <CardSubagent key={t.id} t={t} info={info} currentTool={findOwningSubagent(t, subagents)?.currentTool} />
        ))}
      </div>
    );
  }

  if (!expanded) {
    return (
      <div style={container}>
        <CollapsedCardRow tools={tools} onToggle={onToggle} failed={failed} running={running} doneCount={doneCount} spanMs={spanMs} />
      </div>
    );
  }

  const scroll = tools.length > SCROLL_THRESHOLD;
  return (
    <div style={container}>
      <div style={{ border: CARD_BORDER, background: 'var(--term-surface)' }}>
        <button
          type="button"
          data-toolgroup-header
          onClick={onToggle}
          className="t-hover-fg"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 11px',
            width: '100%',
            background: 'transparent',
            border: 'none',
            font: 'inherit',
            color: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {running && <CardSpinner />}
          <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--term-fg)' }}>
            {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}
          </span>
          {failed > 0 && <FailedBadge label={`${failed} FAILED`} />}
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: 'var(--term-faint)', flexShrink: 0 }}>
            {running ? `${doneCount}/${tools.length}` : spanMs != null ? formatDurationMs(spanMs) : ''}
          </span>
          <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', flexShrink: 0 }}>▾</span>
        </button>
        <div
          ref={listRef}
          onScroll={onScroll}
          className={`tool-rows-in${scroll ? ' term-scrollbar' : ''}`}
          style={scroll ? { maxHeight: SCROLL_MAX_HEIGHT, overflowY: 'auto' } : undefined}
        >
          {normal.map((t) => (
            <CardToolRow key={t.id} t={t} />
          ))}
          {subs.map(({ t, info }) => (
            <CardSubagent key={t.id} t={t} info={info} currentTool={findOwningSubagent(t, subagents)?.currentTool} embedded />
          ))}
        </div>
      </div>
    </div>
  );
}

function CollapsedCardRow({
  tools,
  onToggle,
  failed,
  running,
  doneCount,
  spanMs,
}: {
  tools: ToolCallState[];
  onToggle: () => void;
  failed: number;
  running: boolean;
  doneCount: number;
  spanMs: number | undefined;
}) {
  return (
    <button
      type="button"
      data-toolgroup-header
      onClick={onToggle}
      className="t-hover-fg"
      style={{
        border: CARD_BORDER,
        background: 'var(--term-surface)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 11px',
        width: '100%',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {running ? <CardSpinner /> : <ToolTypeIcon kind="bash" color="var(--term-muted)" />}
      <span style={{ fontSize: 11.5, color: 'var(--term-mid)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summarizeToolsBase(tools)}
        {failed > 0 && (
          <span style={{ color: 'var(--term-danger)' }}>
            {' '}· {tools.length === 1 ? 'failed' : `${failed} failed`}
          </span>
        )}
      </span>
      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: 'var(--term-faint)', flexShrink: 0 }}>
        {running ? `${doneCount}/${tools.length}` : spanMs != null ? formatDurationMs(spanMs) : ''}
      </span>
      <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', flexShrink: 0 }}>▸</span>
    </button>
  );
}

/* ══ 1d · Terminal variant ═══════════════════════════════════════════── */

function termToolName(t: ToolCallState): string {
  const key = toolBucketKey(t);
  if (key !== 'unknown') return key;
  return prettifyToolTitle(t.title) || t.kind || '(unnamed)';
}

function TermPayload({ t }: { t: ToolCallState }) {
  const failed = isFailedStatus(t.status);
  const preStyle: React.CSSProperties = {
    fontFamily: MONO,
    fontSize: 10,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--term-mid)',
    margin: 0,
  };
  return (
    <div
      className="term-scrollbar"
      style={{
        marginLeft: 22,
        marginTop: 5,
        background: 'var(--term-alt)',
        borderLeft: `2px solid ${failed ? 'var(--term-danger)' : 'var(--term-line-s)'}`,
        padding: '6px 9px 7px',
        maxHeight: 200,
        overflowY: 'auto',
      }}
    >
      {t.inputJson && (
        <>
          <div style={{ ...CAP_LABEL, marginBottom: 2 }}>in</div>
          <pre style={preStyle}>{formatToolPayload(t.inputJson)}</pre>
        </>
      )}
      {t.output && (
        <>
          <div style={{ ...CAP_LABEL, margin: t.inputJson ? '6px 0 2px' : '0 0 2px' }}>out</div>
          <pre style={{ ...preStyle, color: failed ? 'var(--term-danger)' : 'var(--term-mid)' }}>
            {formatToolPayload(t.output)}
          </pre>
        </>
      )}
    </div>
  );
}

function TermToolRow({ t }: { t: ToolCallState }) {
  const failed = isFailedStatus(t.status);
  const running = isRunningStatus(t.status);
  const hasPayload = !!(t.inputJson || t.output);
  const { open, toggle } = usePayloadOpen(failed, hasPayload);
  const durMs = toolDurationMs(t);
  const detail = toolRowDetail(t);
  const nameColor = failed ? 'var(--term-danger)' : running ? 'var(--term-fg)' : 'var(--term-muted)';
  const detailColor = failed ? 'var(--term-danger)' : running ? 'var(--term-fg)' : 'var(--term-mid)';
  return (
    <div>
      <div
        onClick={hasPayload ? toggle : undefined}
        className={hasPayload ? 't-hover-fg' : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: '14px 1fr auto',
          gap: 8,
          alignItems: 'baseline',
          cursor: hasPayload ? 'pointer' : 'default',
        }}
      >
        {failed ? (
          <span aria-hidden style={{ fontFamily: MONO, fontSize: 10, color: 'var(--term-danger)', textAlign: 'center' }}>×</span>
        ) : running ? (
          <span aria-hidden className="agent-glyph-run" style={{ fontFamily: MONO, fontSize: 10, color: 'var(--term-accent)', textAlign: 'center' }}>❯</span>
        ) : (
          <span aria-hidden style={{ fontFamily: MONO, fontSize: 10, color: 'var(--term-muted)', textAlign: 'center' }}>✓</span>
        )}
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 11, color: nameColor }}>{termToolName(t)}</span>
          {detail && (
            <>
              {' '}
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: detailColor }}>{detail}</span>
            </>
          )}
        </span>
        {failed ? (
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-danger)' }}>failed</span>
        ) : running ? (
          <span className="term-shimmer term-shimmer--accent" style={{ fontSize: 9.5 }}>running</span>
        ) : durMs != null ? (
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-faint)' }}>{formatDurationMs(durMs)}</span>
        ) : (
          <span />
        )}
      </div>
      {open && hasPayload && <TermPayload t={t} />}
    </div>
  );
}

function TermSubagent({
  t,
  info,
  currentTool,
}: {
  t: ToolCallState;
  info: SubagentToolInfo;
  currentTool: string | undefined;
}) {
  const running = isRunningStatus(t.status);
  const mission = clampText(info.description ?? info.prompt, 180);
  return (
    <div data-testid="subagent-card" style={{ border: CARD_BORDER, fontFamily: 'var(--ui-font)' }}>
      <div style={{ padding: '5px 9px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: CARD_BORDER }}>
        <span aria-hidden style={{ color: 'var(--term-mauve)', fontSize: 10, flexShrink: 0 }}>◆</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--term-fg)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subagentHeading(info)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {info.model && <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-faint)' }}>{info.model}</span>}
          <SubagentStatus status={t.status} />
        </span>
      </div>
      <div style={{ padding: '7px 9px' }}>
        {mission && <div style={{ fontSize: 10.5, color: 'var(--term-muted)', lineHeight: 1.5 }}>{mission}</div>}
        {running && currentTool && (
          <div style={{ marginTop: mission ? 5 : 0, fontFamily: MONO, fontSize: 10, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--term-faint)' }}>now ❯ </span>
            <span style={{ color: 'var(--term-accent)' }}>{currentTool}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TermToolGroup({ tools, expanded, onToggle, subagents }: VariantGroupProps) {
  const { normal, subs } = partition(tools);
  const failed = failedToolCount(tools);
  const running = tools.some((t) => !isTerminalStatus(t.status));
  const doneCount = tools.filter((t) => isTerminalStatus(t.status)).length;
  const spanMs = running ? undefined : toolSpanMs(tools);
  const { listRef, onScroll } = useStickyList(tools.length);

  const container: React.CSSProperties = {
    fontFamily: 'var(--ui-font)',
    marginTop: 12,
    marginBottom: 10,
  };
  const headerBtn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  };
  const rightMeta = running
    ? `${doneCount}/${tools.length}`
    : `${tools.length}${spanMs != null ? ` · ${formatDurationMs(spanMs)}` : ''}`;

  // Pure subagent groups render as standalone boxes — a "tools" section
  // header around a single subagent card is noise (mirrors CardToolGroup).
  if (normal.length === 0 && subs.length > 0 && expanded) {
    return (
      <div style={{ ...container, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {subs.map(({ t, info }) => (
          <TermSubagent key={t.id} t={t} info={info} currentTool={findOwningSubagent(t, subagents)?.currentTool} />
        ))}
      </div>
    );
  }

  if (!expanded) {
    return (
      <div style={container}>
        <button
          type="button"
          data-toolgroup-header
          onClick={onToggle}
          className="t-hover-fg"
          style={{ ...headerBtn, alignItems: 'baseline' }}
        >
          <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', flexShrink: 0 }}>▸</span>
          <span style={{ fontSize: 10.5, color: 'var(--term-muted)', minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summarizeToolsBase(tools)}
            {failed > 0 && (
              <span style={{ color: 'var(--term-danger)' }}>
                {' '}· {tools.length === 1 ? 'failed' : `${failed} failed`}
              </span>
            )}
          </span>
          <span aria-hidden style={{ flex: 1, borderBottom: '1px dotted var(--term-line)', transform: 'translateY(-3px)' }} />
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-faint)', flexShrink: 0 }}>
            {running ? `${doneCount}/${tools.length}` : spanMs != null ? formatDurationMs(spanMs) : ''}
          </span>
        </button>
      </div>
    );
  }

  const scroll = tools.length > SCROLL_THRESHOLD;
  return (
    <div style={container}>
      <button type="button" data-toolgroup-header onClick={onToggle} className="t-hover-fg" style={headerBtn}>
        <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', flexShrink: 0 }}>▾</span>
        <span style={{ fontSize: 9, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--term-muted)', fontWeight: 500, flexShrink: 0 }}>
          tools
        </span>
        <span aria-hidden style={{ flex: 1, borderTop: '1px solid var(--term-line)', transform: 'translateY(1px)' }} />
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--term-faint)', flexShrink: 0 }}>
          {rightMeta}
          {failed > 0 && <span style={{ color: 'var(--term-danger)' }}> · {failed} failed</span>}
        </span>
      </button>
      <div
        ref={listRef}
        onScroll={onScroll}
        className={`tool-rows-in${scroll ? ' term-scrollbar' : ''}`}
        style={{
          marginTop: 7,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          ...(scroll ? { maxHeight: SCROLL_MAX_HEIGHT, overflowY: 'auto' } : null),
        }}
      >
        {normal.map((t) => (
          <TermToolRow key={t.id} t={t} />
        ))}
        {subs.map(({ t, info }) => (
          <TermSubagent key={t.id} t={t} info={info} currentTool={findOwningSubagent(t, subagents)?.currentTool} />
        ))}
      </div>
    </div>
  );
}
