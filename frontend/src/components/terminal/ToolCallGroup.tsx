import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import {
  summarizeTools,
  isTerminalStatus,
  isFailedStatus,
  isRunningStatus,
  subagentHeading,
  subagentStatusLabel,
  subagentToolInfo,
  filterSubagentRelayedTools,
  findOwningSubagent,
  prettifyToolTitle,
  type SubagentToolInfo,
} from './toolCallGrouping';

interface Props {
  tools: ToolCallState[];
  defaultExpanded: boolean;
  subagents?: readonly SubagentInfo[];
}

const FAIL_COLOR = '#e06c75';
const SCROLL_THRESHOLD = 5;
const SCROLL_MAX_HEIGHT = 130;

function allTerminal(tools: ToolCallState[]): boolean {
  return tools.every((t) => isTerminalStatus(t.status));
}

function anyFailed(tools: ToolCallState[]): boolean {
  return tools.some((t) => isFailedStatus(t.status));
}

function ToolCallGroupInner({ tools, defaultExpanded, subagents }: Props) {
  const visibleTools = useMemo(
    () => filterSubagentRelayedTools(tools, subagents),
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

  if (visibleTools.length === 0) return null;

  const failed = anyFailed(visibleTools);
  const headerColor = failed ? FAIL_COLOR : 'var(--term-mauve)';

  const onHeaderClick = () => {
    userInteractedRef.current = true;
    setExpanded((e) => !e);
  };

  const containerStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontFamily: 'var(--ui-font)',
    color: headerColor,
    marginTop: 4,
    padding: '3px 0',
    borderTop: '1px dotted var(--term-line)',
  };

  if (!expanded) {
    return (
      <div style={containerStyle}>
        <button
          type="button"
          data-toolgroup-header
          onClick={onHeaderClick}
          className="t-hover-fg"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            textAlign: 'left',
            width: '100%',
          }}
        >
          <span style={{ opacity: 0.7, flexShrink: 0 }}>↳</span>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {summarizeTools(visibleTools)}
          </span>
          <span style={{ color: 'var(--term-muted)', flexShrink: 0, marginLeft: 8 }}>›</span>
        </button>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <button
        type="button"
        data-toolgroup-header
        onClick={onHeaderClick}
        className="t-hover-fg"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        <span style={{ opacity: 0.7, flexShrink: 0 }}>↳</span>
        <span style={{ flex: 1, color: 'var(--term-muted)', fontSize: 9.5 }}>
          {visibleTools.length} {visibleTools.length === 1 ? 'tool' : 'tools'}
        </span>
        <span style={{ color: 'var(--term-muted)', flexShrink: 0, marginLeft: 8 }}>⌃</span>
      </button>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          stickyRef.current = atBottom;
        }}
        className={visibleTools.length > SCROLL_THRESHOLD ? 'term-scrollbar' : undefined}
        style={{
          marginTop: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
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
  if (subagent) {
    const owner = findOwningSubagent(t, subagents);
    return <SubagentSpineRow t={t} info={subagent} currentTool={owner?.currentTool} />;
  }

  const failed = isFailedStatus(t.status);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        paddingLeft: 16,
        color: failed ? FAIL_COLOR : 'var(--term-mauve)',
      }}
    >
      <span style={{ opacity: 0.7, flexShrink: 0 }}>·</span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
        {prettifyToolTitle(t.title) || t.kind || '(unnamed)'}
        {t.detail && (
          <span
            style={{
              display: 'block',
              fontSize: 9.5,
              color: 'var(--term-muted)',
              fontStyle: 'italic',
              marginTop: 1,
            }}
          >
            {t.detail}
          </span>
        )}
      </span>
      <span style={{ color: 'var(--term-muted)', flexShrink: 0, marginLeft: 8 }}>
        {t.status || 'running'}
      </span>
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
  const accent = failed ? FAIL_COLOR : running ? 'var(--term-accent)' : 'var(--term-mauve)';
  const dot = running ? '●' : failed ? '×' : '✓';
  const mission = info.description ?? info.prompt;
  const showNow = running && !!currentTool;

  return (
    <div
      data-testid="subagent-spine-row"
      style={{
        marginLeft: 16,
        marginTop: 2,
        paddingLeft: 10,
        borderLeft: '1px dotted var(--term-line)',
        color: 'var(--term-fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ color: accent, flexShrink: 0 }}>{dot}</span>
        <span
          style={{
            color: accent,
            fontWeight: 600,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subagentHeading(info)}
        </span>
        {info.model && (
          <span style={{ color: 'var(--term-faint)', flexShrink: 0 }}>{info.model}</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--term-muted)', flexShrink: 0 }}>
          {subagentStatusLabel(t.status)}
        </span>
      </div>
      {mission && (
        <div style={{ marginTop: 2, lineHeight: 1.45, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          <span style={{ color: 'var(--term-muted)' }}>Mission: </span>
          {clampText(mission, 180)}
        </div>
      )}
      {showNow && (
        <div style={{ marginTop: 1, lineHeight: 1.45 }}>
          <span style={{ color: 'var(--term-muted)' }}>Now: </span>
          <span style={{ color: 'var(--term-accent)' }}>{currentTool}</span>
        </div>
      )}
    </div>
  );
}
