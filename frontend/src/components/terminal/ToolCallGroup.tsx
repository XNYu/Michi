import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import { useAgentBlockStyle } from '../../state/prefs';
import { CardToolGroup, CollapsedToolSummary, TermToolGroup } from './AgentBlockVariants';
import { useMetaChatDecorations } from '../../state/metaChat/metaChatDecorations';
import {
  failedToolCount,
  toolDurationMs,
  toolSpanMs,
  formatDurationMs,
  formatToolPayload,
  isTerminalStatus,
  isFailedStatus,
  isRunningStatus,
  subagentStatusLabel,
  delegationToolInfo,
  filterSubagentRelayedTools,
  toolDisplayTitle,
  isHiddenInternalTool,
  toolPurpose,
  toolRowDetail,
  type SubagentToolInfo,
} from './toolCallGrouping';
import { SubagentRow, SubagentSummaryLine } from './subagents/SubagentRoster';
import {
  delegationHeading,
  delegationStatus,
  subagentsForTool,
  withConversationTone,
  withDelegationStatus,
} from './subagents/subagentPresentation';
import { useDelegationStatusLabel } from './subagents/useDelegationStatusLabel';
import { FadeOnChange, FailFlash, GlyphSwap, LabelSwap, Reveal, RevealList, ScrollingRevealList } from './agentBlockMotion';

interface Props {
  tools: ToolCallState[];
  defaultExpanded: boolean;
  subagents?: readonly SubagentInfo[];
  /** false: the caller shows Michi receipts itself (a collapsible thought block keeps them outside). */
  receipts?: boolean;
}

const FAIL_COLOR = 'var(--term-danger)';
const SCROLL_THRESHOLD = 5;

function allTerminal(tools: ToolCallState[]): boolean {
  return tools.every((t) => isTerminalStatus(t.status));
}

/**
 * Status marker — the single glyph language for tool rows:
 *   running → breathing accent dot
 *   failed  → red ×
 *   done    → muted dot
 * Rows with an openable payload swap the dot for a ▸/▾ disclosure chevron
 * once terminal (running/failed keep their state glyph). A change of kind
 * cross-scales (GlyphSwap); the chevron's ▸/▾ turn is not a change of kind.
 */
function StatusDot({ status, chevron }: { status: string | undefined; chevron?: { open: boolean } }) {
  const failed = isFailedStatus(status);
  const running = isRunningStatus(status);
  const glyph = chevron ? 'chevron' : failed ? 'failed' : running ? 'running' : 'done';
  return (
    <GlyphSwap glyph={glyph} style={{ width: 8, ...(chevron || failed ? null : { alignSelf: 'center' }) }}>
      {chevron ? (
        <span aria-hidden style={{ fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)' }}>{chevron.open ? '▾' : '▸'}</span>
      ) : failed ? (
        <span aria-hidden style={{ color: FAIL_COLOR, fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>
      ) : (
        <span aria-hidden className={running ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
      )}
    </GlyphSwap>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden style={{ fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)', width: 8, flexShrink: 0 }}>
      {open ? '▾' : '▸'}
    </span>
  );
}

function DurLabel({ ms }: { ms: number | undefined }) {
  if (ms == null) return null;
  return (
    <span style={{ marginLeft: 'auto', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', flexShrink: 0, paddingLeft: 8 }}>
      {formatDurationMs(ms)}
    </span>
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
    fontSize: 'var(--fs-2xs)',
    letterSpacing: 'var(--ls-caps-wide)',
    color: 'var(--term-muted)',
    fontFamily: 'var(--ui-font)',
  };
  const ruleStyle: React.CSSProperties = { flex: 1, borderTop: '1px solid var(--term-line)' };
  const preStyle: React.CSSProperties = {
    fontSize: 'var(--fs-xs)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--term-mid)',
    padding: '2px 10px 8px',
    margin: 0,
    fontVariantLigatures: 'none',
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
        maxHeight: 480,
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

function SubagentSpineRow({
  t,
  info,
  linked,
}: {
  t: ToolCallState;
  info: SubagentToolInfo;
  /** Roster entries this delegation spawned (usually one). */
  linked: readonly SubagentInfo[];
}) {
  const status = delegationStatus(t, linked);
  const heading = delegationHeading(t, info, linked);
  const spine: React.CSSProperties = {
    marginLeft: 14,
    marginTop: 2,
    paddingLeft: 10,
    borderLeft: '1px dotted var(--term-line-s)',
    color: 'var(--term-muted)',
  };
  if (linked.length > 1) {
    const failed = isFailedStatus(status);
    const running = isRunningStatus(status);
    const label = subagentStatusLabel(status);
    return (
      <div data-testid="subagent-spine-row" style={spine}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
          <StatusDot status={status} />
          <span style={{ color: failed ? FAIL_COLOR : 'var(--term-fg)', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {heading}
          </span>
          <FadeOnChange
            k={label}
            style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 'var(--fs-xs)', paddingLeft: 8, color: failed ? FAIL_COLOR : running ? 'var(--term-accent)' : 'var(--term-muted)' }}
          >
            {label}
          </FadeOnChange>
        </div>
        <div style={{ marginTop: 4 }}>
          <RevealList gap={4} rows={linked.map((entry) => ({ key: entry.sessionId, node: <SubagentRow subagent={entry} /> }))} />
        </div>
      </div>
    );
  }
  return (
    <div data-testid="subagent-spine-row" style={spine}>
      <SubagentSummaryLine
        subagent={linked[0]}
        name={heading}
        status={status}
        fallback={info.description ?? info.prompt}
      />
    </div>
  );
}

/**
 * Memoised: tool updates replace only the tool that changed (see
 * withDelegationStatus), so a streaming update re-renders one row.
 */
const ToolRow = React.memo(function ToolRow({ t, subagents, label }: { t: ToolCallState; subagents?: readonly SubagentInfo[]; label?: string | null }) {
  const subagent = delegationToolInfo(t, subagents);
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
    return <SubagentSpineRow t={t} info={subagent} linked={subagentsForTool(t, subagents)} />;
  }

  const titleColor = failed ? FAIL_COLOR : running ? 'var(--term-fg)' : 'var(--term-muted)';
  const durMs = toolDurationMs(t);
  const purpose = label ? undefined : toolPurpose(t);
  const detail = label ?? toolRowDetail(t);

  return (
    <div style={{ paddingLeft: label ? 0 : 14, position: 'relative' }} data-tool-line={label ? '' : undefined}>
      <FailFlash failed={failed} />
      <div
        style={{
          display: 'flex',
          alignItems: purpose ? 'flex-start' : 'baseline',
          gap: 7,
          cursor: hasPayload ? 'pointer' : 'default',
          color: titleColor,
        }}
        className={hasPayload ? 't-hover-fg' : undefined}
        onClick={hasPayload ? () => { userToggledRef.current = true; setOpen((o) => !o); } : undefined}
      >
        <StatusDot status={t.status} chevron={hasPayload && !running && !failed ? { open } : undefined} />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {purpose ? (
            <>
              <span>{purpose}</span>
              {failed && ' · failed'}
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--fs-xs)',
                  fontFamily: 'var(--font-mono)',
                  color: failed ? FAIL_COLOR : 'var(--term-muted)',
                  opacity: failed ? 0.8 : 1,
                  marginTop: 1,
                }}
              >
                {toolDisplayTitle(t) || t.kind || '(unnamed)'}
                {detail && ` ${detail}`}
              </span>
            </>
          ) : (
            <>
              {detail || toolDisplayTitle(t) || t.kind || '(unnamed)'}
              {failed && ' · failed'}
            </>
          )}
        </span>
        {!label && <DurLabel ms={durMs} />}
      </div>
      <Reveal show={open && hasPayload}>
        <PayloadBlock inputJson={t.inputJson} output={t.output} />
      </Reveal>
    </div>
  );
});

/** The header's label + right-hand meta, one cross-faded layer per mode. */
const HEADER_LAYER: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 7 };

function ToolCallGroupInner({ tools, defaultExpanded, subagents }: Props) {
  const ownTools = useMemo(
    () => withDelegationStatus(
      filterSubagentRelayedTools(tools, subagents).filter((t) => !isHiddenInternalTool(t.title)),
      subagents,
    ),
    [tools, subagents],
  );
  // A lone delegation's status as its conversation presents the agent: the
  // collapsed label's word, and the chrome (spinner, counter, failure,
  // auto-collapse) agrees with it.
  const delegation = useDelegationStatusLabel(ownTools, subagents);
  const tone = delegation?.tone;
  const visibleTools = useMemo(() => withConversationTone(ownTools, tone), [ownTools, tone]);
  const subagentStatus = delegation?.label;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const userInteractedRef = useRef(false);
  const startedExpandedRef = useRef(defaultExpanded);
  const hadRunningRef = useRef(!allTerminal(visibleTools));

  // The end-of-batch auto-collapse; the body animates closed in 160ms (Reveal).
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
  const toolLine = useMetaChatDecorations()?.toolLine;

  if (visibleTools.length === 0) return null;

  if (toolLine) {
    return (
      <div data-tool-lines style={{ fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)', lineHeight: '16px', color: 'var(--term-muted)', margin: '0 0 6px', display: 'flex', flexDirection: 'column' }}>
        <RevealList gap={3} rows={visibleTools.map((t) => ({ key: t.id, node: <ToolRow t={t} subagents={subagents} label={toolLine(t)} /> }))} />
      </div>
    );
  }

  const onToggle = () => {
    userInteractedRef.current = true;
    setExpanded((e) => !e);
  };

  if (variant === 'card') {
    return <CardToolGroup tools={visibleTools} expanded={expanded} onToggle={onToggle} subagents={subagents} subagentStatus={subagentStatus} />;
  }
  if (variant === 'terminal') {
    return <TermToolGroup tools={visibleTools} expanded={expanded} onToggle={onToggle} subagents={subagents} subagentStatus={subagentStatus} />;
  }

  // Single non-subagent tool: the row alone, without a group header, so the
  // user needs only one click to open the payload. The container, the list
  // and the row stay mounted when a second tool arrives: the header grows in
  // above the row instead of the block swapping structure.
  const single = visibleTools.length === 1 && !delegationToolInfo(visibleTools[0], subagents);
  const failed = failedToolCount(visibleTools);
  const running = !allTerminal(visibleTools);
  const doneCount = visibleTools.filter((t) => isTerminalStatus(t.status)).length;
  const spanMs = running ? undefined : toolSpanMs(visibleTools);
  const mode = !expanded ? 'collapsed' : running ? 'running' : 'done';

  const containerStyle: React.CSSProperties = {
    fontSize: 'var(--fs-sm)',
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

  return (
    <div style={containerStyle}>
      <Reveal show={!single} preset="arrive">
        <button
          type="button"
          data-toolgroup-header
          onClick={onToggle}
          className="t-hover-fg"
          style={headerBtnStyle}
        >
          <Chevron open={expanded} />
          <LabelSwap k={mode} style={{ flex: 1 }} layerStyle={HEADER_LAYER}>
            {mode === 'collapsed' ? (
              <>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                  <CollapsedToolSummary tools={visibleTools} failed={failed} subagentStatus={subagentStatus} />
                </span>
                <DurLabel ms={spanMs} />
              </>
            ) : mode === 'running' ? (
              <>
                <span className="term-shimmer">running tools</span>
                <span style={{ marginLeft: 'auto', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', flexShrink: 0, paddingLeft: 8 }}>
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
          </LabelSwap>
        </button>
      </Reveal>
      <Reveal show={single || expanded} preset="group">
        <div style={{ paddingTop: single ? 0 : 3, paddingLeft: 2 }}>
          <ScrollingRevealList
            gap={3}
            scroll={visibleTools.length > SCROLL_THRESHOLD}
            rows={visibleTools.map((t) => ({ key: t.id, node: <ToolRow t={t} subagents={subagents} /> }))}
          />
        </div>
      </Reveal>
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

/** The group, then a receipt card for each Michi write in it (only the ⌘J assistant makes those). */
function ToolCallGroupWithReceipts({ receipts = true, ...props }: Props) {
  return (
    <>
      <ToolCallGroupInner {...props} />
    </>
  );
}

export const ToolCallGroup = React.memo(ToolCallGroupWithReceipts, (prev, next) =>
  prev.defaultExpanded === next.defaultExpanded &&
  prev.receipts === next.receipts &&
  sameTools(prev.tools, next.tools) &&
  prev.subagents === next.subagents,
);
