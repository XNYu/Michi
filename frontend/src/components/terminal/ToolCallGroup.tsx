import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import { useAgentBlockStyle } from '../../state/prefs';
import { CardToolGroup, TermToolGroup } from './AgentBlockVariants';
import {
  summarizeToolsBase,
  failedToolCount,
  toolDurationMs,
  toolSpanMs,
  formatDurationMs,
  formatToolPayload,
  isTerminalStatus,
  isFailedStatus,
  isRunningStatus,
  subagentHeading,
  subagentStatusLabel,
  subagentToolInfo,
  filterSubagentRelayedTools,
  findOwningSubagent,
  prettifyToolTitle,
  isHiddenInternalTool,
  type SubagentToolInfo,
} from './toolCallGrouping';

interface Props {
  tools: ToolCallState[];
  defaultExpanded: boolean;
  subagents?: readonly SubagentInfo[];
}

const FAIL_COLOR = 'var(--term-danger)';
const SCROLL_THRESHOLD = 5;
const SCROLL_MAX_HEIGHT = 130;

function allTerminal(tools: ToolCallState[]): boolean {
  return tools.every((t) => isTerminalStatus(t.status));
}

/**
 * Status marker — the single glyph language for tool rows:
 *   running → breathing accent dot
 *   failed  → red ×
 *   done    → muted dot
 * Rows with an openable payload swap the dot for a ▸/▾ disclosure chevron
 * once terminal (running/failed keep their state glyph).
 */
function StatusDot({ status }: { status: string | undefined }) {
  if (isFailedStatus(status)) {
    return (
      <span aria-hidden style={{ color: FAIL_COLOR, fontSize: 10, width: 8, flexShrink: 0, lineHeight: 1 }}>×</span>
    );
  }
  const running = isRunningStatus(status);
  return (
    <span
      aria-hidden
      style={{ width: 8, display: 'inline-flex', justifyContent: 'flex-start', flexShrink: 0, alignSelf: 'center' }}
    >
      <span className={running ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden style={{ fontSize: 9, color: 'var(--term-faint)', width: 8, flexShrink: 0 }}>
      {open ? '▾' : '▸'}
    </span>
  );
}

function DurLabel({ ms }: { ms: number | undefined }) {
  if (ms == null) return null;
  return (
    <span style={{ marginLeft: 'auto', color: 'var(--term-faint)', fontSize: 10, flexShrink: 0, paddingLeft: 8 }}>
      {formatDurationMs(ms)}
    </span>
  );
}

function ToolCallGroupInner({ tools, defaultExpanded, subagents }: Props) {
  const visibleTools = useMemo(
    () => filterSubagentRelayedTools(tools, subagents).filter((t) => !isHiddenInternalTool(t.title)),
    [tools, subagents],
  );
  const [expanded, setExpanded] = useState(defaultExpanded);
  const userInteractedRef = useRef(false);
  const startedExpandedRef = useRef(defaultExpanded);
  const hadRunningRef = useRef(!allTerminal(visibleTools));
  const listRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!stickyRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleTools.length, expanded]);

  useEffect(() => {
    if (!allTerminal(visibleTools)) {
      hadRunningRef.current = true;
      return;
    }
    if (userInteractedRef.current) return;
    if (!startedExpandedRef.current) return;
    if (!hadRunningRef.current) return;
    setExpanded(false);
  }, [visibleTools]);

  const variant = useAgentBlockStyle();

  if (visibleTools.length === 0) return null;

  const onToggle = () => {
    userInteractedRef.current = true;
    setExpanded((e) => !e);
  };

  if (variant === 'card') {
    return <CardToolGroup tools={visibleTools} expanded={expanded} onToggle={onToggle} subagents={subagents} />;
  }
  if (variant === 'terminal') {
    return <TermToolGroup tools={visibleTools} expanded={expanded} onToggle={onToggle} subagents={subagents} />;
  }

  const failed = failedToolCount(visibleTools);
  const running = !allTerminal(visibleTools);
  const doneCount = visibleTools.filter((t) => isTerminalStatus(t.status)).length;
  const spanMs = running ? undefined : toolSpanMs(visibleTools);

  const containerStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontFamily: 'var(--ui-font)',
    color: 'var(--term-muted)',
    marginTop: 14,
    marginBottom: 14,
    padding: '3px 0',
  };

  const headerBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 7,
    background: 'transparent',
    border: 'none',
    padding: 0,
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
  };

  if (!expanded) {
    return (
      <div style={containerStyle}>
        <button
          type="button"
          data-toolgroup-header
          onClick={onToggle}
          className="t-hover-fg"
          style={headerBtnStyle}
        >
          <Chevron open={false} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {summarizeToolsBase(visibleTools)}
            {failed > 0 && (
              <span style={{ color: FAIL_COLOR }}>
                {' '}· {visibleTools.length === 1 ? 'failed' : `${failed} failed`}
              </span>
            )}
          </span>
          <DurLabel ms={spanMs} />
        </button>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <button
        type="button"
        data-toolgroup-header
        onClick={onToggle}
        className="t-hover-fg"
        style={headerBtnStyle}
      >
        <Chevron open />
        {running ? (
          <>
            <span className="term-shimmer">running tools</span>
            <span style={{ marginLeft: 'auto', color: 'var(--term-faint)', fontSize: 10, flexShrink: 0, paddingLeft: 8 }}>
              {doneCount}/{visibleTools.length}
            </span>
          </>
        ) : (
          <>
            <span>
              {visibleTools.length} {visibleTools.length === 1 ? 'tool' : 'tools'}
              {failed > 0 && <span style={{ color: FAIL_COLOR }}> · {failed} failed</span>}
            </span>
            <DurLabel ms={spanMs} />
          </>
        )}
      </button>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          stickyRef.current = atBottom;
        }}
        className={`tool-rows-in${visibleTools.length > SCROLL_THRESHOLD ? ' term-scrollbar' : ''}`}
        style={{
          marginTop: 3,
          paddingLeft: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          ...(visibleTools.length > SCROLL_THRESHOLD
            ? { maxHeight: SCROLL_MAX_HEIGHT, overflowY: 'auto' }
            : null),
        }}
      >
        {visibleTools.map((t) => (
          <ToolRow key={t.id} t={t} subagents={subagents} />
        ))}
      </div>
    </div>
  );
}

function sameTools(a: ToolCallState[], b: ToolCallState[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const ToolCallGroup = React.memo(ToolCallGroupInner, (prev, next) =>
  prev.defaultExpanded === next.defaultExpanded &&
  sameTools(prev.tools, next.tools) &&
  prev.subagents === next.subagents,
);

function ToolRow({ t, subagents }: { t: ToolCallState; subagents?: readonly SubagentInfo[] }) {
  const subagent = subagentToolInfo(t);
  const hasPayload = !!(t.inputJson || t.output);
  const failed = isFailedStatus(t.status);
  const running = isRunningStatus(t.status);
  // Failed rows with output auto-open so the error is visible without a click.
  // Failure usually arrives via a later tool-call-update, so an effect (not
  // just the initial state) handles the live transition. A user toggle wins.
  const [open, setOpen] = useState(failed && hasPayload);
  const userToggledRef = useRef(false);
  useEffect(() => {
    if (failed && hasPayload && !userToggledRef.current) setOpen(true);
  }, [failed, hasPayload]);

  if (subagent) {
    const owner = findOwningSubagent(t, subagents);
    return <SubagentSpineRow t={t} info={subagent} currentTool={owner?.currentTool} />;
  }

  const titleColor = failed ? FAIL_COLOR : running ? 'var(--term-fg)' : 'var(--term-muted)';
  const durMs = toolDurationMs(t);

  return (
    <div style={{ paddingLeft: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 7,
          cursor: hasPayload ? 'pointer' : 'default',
          color: titleColor,
        }}
        className={hasPayload ? 't-hover-fg' : undefined}
        onClick={hasPayload ? () => { userToggledRef.current = true; setOpen((o) => !o); } : undefined}
      >
        {hasPayload && !running && !failed ? <Chevron open={open} /> : <StatusDot status={t.status} />}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {t.detail || prettifyToolTitle(t.title) || t.kind || '(unnamed)'}
          {failed && ' · failed'}
          {t.detail && (
            <span
              style={{
                display: 'block',
                fontSize: 9.5,
                color: failed ? FAIL_COLOR : 'var(--term-faint)',
                opacity: failed ? 0.8 : 1,
                marginTop: 1,
              }}
            >
              {prettifyToolTitle(t.title)}
            </span>
          )}
        </span>
        <DurLabel ms={durMs} />
      </div>
      {open && hasPayload && (
        <PayloadBlock inputJson={t.inputJson} output={t.output} />
      )}
    </div>
  );
}

/**
 * Stacked in/out payload — one mono block with hairline section labels,
 * replacing the old Input/Output tab buttons.
 */
function PayloadBlock({ inputJson, output }: { inputJson?: string; output?: string }) {
  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '3px 8px 2px',
    fontSize: 9,
    letterSpacing: '.12em',
    color: 'var(--term-faint)',
    fontFamily: 'var(--ui-font)',
  };
  const ruleStyle: React.CSSProperties = { flex: 1, borderTop: '1px solid var(--term-line)' };
  const preStyle: React.CSSProperties = {
    fontSize: 10,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--term-mid)',
    padding: '2px 10px 8px',
    margin: 0,
  };
  return (
    <div
      className="term-scrollbar"
      style={{
        marginLeft: 15,
        marginTop: 4,
        marginBottom: 2,
        border: '1px solid var(--term-line)',
        background: 'var(--term-alt)',
        maxHeight: 200,
        overflowY: 'auto',
      }}
    >
      {inputJson && (
        <>
          <div style={labelStyle}><span>in</span><span style={ruleStyle} /></div>
          <pre style={preStyle}>{formatToolPayload(inputJson)}</pre>
        </>
      )}
      {output && (
        <>
          <div style={labelStyle}><span>out</span><span style={ruleStyle} /></div>
          <pre style={preStyle}>{formatToolPayload(output)}</pre>
        </>
      )}
    </div>
  );
}

function clampText(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function SubagentSpineRow({
  t,
  info,
  currentTool,
}: {
  t: ToolCallState;
  info: SubagentToolInfo;
  currentTool: string | undefined;
}) {
  const failed = isFailedStatus(t.status);
  const running = isRunningStatus(t.status);
  const accent = failed ? FAIL_COLOR : running ? 'var(--term-accent)' : 'var(--term-muted)';
  const mission = info.description ?? info.prompt;
  const showNow = running && !!currentTool;

  return (
    <div
      data-testid="subagent-spine-row"
      style={{
        marginLeft: 14,
        marginTop: 2,
        paddingLeft: 10,
        borderLeft: '1px dotted var(--term-line-s)',
        color: 'var(--term-muted)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
        <StatusDot status={t.status} />
        <span
          style={{
            color: failed ? FAIL_COLOR : 'var(--term-fg)',
            fontWeight: 600,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subagentHeading(info)}
        </span>
        {info.model && (
          <span style={{ color: 'var(--term-faint)', flexShrink: 0, fontSize: 10 }}>{info.model}</span>
        )}
        <span style={{ marginLeft: 'auto', color: failed ? FAIL_COLOR : accent, flexShrink: 0, fontSize: 10, paddingLeft: 8 }}>
          {subagentStatusLabel(t.status)}
        </span>
      </div>
      {mission && (
        <div style={{ marginTop: 2, lineHeight: 1.45, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          <span style={{ color: 'var(--term-faint)' }}>mission: </span>
          {clampText(mission, 180)}
        </div>
      )}
      {showNow && (
        <div style={{ marginTop: 1, lineHeight: 1.45 }}>
          <span style={{ color: 'var(--term-faint)' }}>now: </span>
          <span style={{ color: 'var(--term-accent)' }}>{currentTool}</span>
        </div>
      )}
    </div>
  );
}
