import React, { useId } from 'react';
import type { SubagentInfo } from '../../../state/chatTypes';
import { formatDurationMs, isFailedStatus, isRunningStatus, subagentStatusLabel } from '../toolCallGrouping';
import { openBackgroundWork, useBackgroundWorkNodeId } from '../backgroundWork/backgroundWorkEvents';
import { useConversationSubagent } from '../backgroundWork/useConversationSubagent';
import { FadeOnChange, GlyphSwap, RevealList } from '../agentBlockMotion';
import {
  SUBAGENT_TONE_COLOR,
  SUBAGENT_TONE_LABEL,
  shownSubagent,
  subagentDisplayName,
  subagentDurationMs,
  subagentShownDurationMs,
  subagentSummary,
  subagentToolStatus,
  subagentTone,
  type SubagentSummaryTone,
} from './subagentPresentation';

const MONO = 'var(--font-mono)';

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/**
 * Running → breathing dot, failed → red ×, otherwise a muted dot. A change
 * of kind cross-scales.
 */
export function SubagentStatusGlyph({ status }: { status: string | undefined }) {
  const failed = isFailedStatus(status);
  const running = isRunningStatus(status);
  return (
    <GlyphSwap glyph={failed ? 'failed' : running ? 'running' : 'done'} style={{ width: 8, ...(failed ? null : { alignSelf: 'center' }) }}>
      {failed ? (
        <span aria-hidden style={{ color: 'var(--term-danger)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>
      ) : (
        <span aria-hidden className={running ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
      )}
    </GlyphSwap>
  );
}

/**
 * Status word in the tone color, plus how long it took. Nothing while it
 * still runs: a background agent's recorded end is its launch turn's, not
 * its own. `active` is the conversation's view (subagentTone). A new word,
 * and the duration once it appears, fade in.
 */
export function SubagentToneLabel({ subagent, active }: { subagent: SubagentInfo; active?: boolean }) {
  const tone = subagentTone(subagent, active);
  const duration = tone === 'running' || tone === 'background'
    ? undefined
    : active === undefined ? subagentDurationMs(subagent) : subagentShownDurationMs(subagent, active, Date.now());
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexShrink: 0, fontSize: 'var(--fs-xs)' }}>
      <FadeOnChange k={tone} style={{ color: SUBAGENT_TONE_COLOR[tone] }}>{SUBAGENT_TONE_LABEL[tone]}</FadeOnChange>
      <FadeOnChange k={duration !== undefined ? 'duration' : null} style={{ fontFamily: MONO, color: 'var(--term-muted)' }}>
        {duration !== undefined && formatDurationMs(duration)}
      </FadeOnChange>
    </span>
  );
}

const SUMMARY_COLOR: Record<SubagentSummaryTone, string> = {
  now: 'var(--term-accent)',
  status: 'var(--term-muted)',
  result: 'var(--term-mid)',
  error: 'var(--term-danger)',
  mission: 'var(--term-muted)',
};

/** "now ❯ Read src/a.ts", the status line, the result's first line or the mission. */
export function SubagentSummaryText({ summary }: { summary: { tone: SubagentSummaryTone; text: string } }) {
  return (
    <span
      data-testid="subagent-summary-text"
      data-summary-tone={summary.tone}
      style={{ ...ellipsis, flex: 1, fontSize: summary.tone === 'now' ? 'var(--fs-xs)' : 'var(--fs-sm)', fontFamily: summary.tone === 'now' ? MONO : undefined }}
    >
      {/* The ornament stays out of the transcript line's accessible name; "now" reads. */}
      {summary.tone === 'now' && <span style={{ color: 'var(--term-muted)' }}>now <span aria-hidden="true">❯</span> </span>}
      <span style={{ color: SUMMARY_COLOR[summary.tone] }}>{summary.text}</span>
    </span>
  );
}

const lineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 7,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left',
};

const buttonReset: React.CSSProperties = {
  border: 0,
  margin: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

/**
 * One subagent on one line: glyph, name, what it does now (or returned),
 * status. With a roster entry and a conversation to scope to, the whole line
 * opens the Background work drawer on that agent; the transcript itself no
 * longer unfolds task, activity or result.
 *
 * In a conversation the line shows the agent as the conversation knows it,
 * like the drawer: a background agent's launch message reads completed once
 * a later turn brought its completion.
 */
export function SubagentSummaryLine({
  subagent: ownCopy,
  name,
  status: ownStatus,
  fallback,
  glyph,
  nameStyle,
  style,
}: {
  /** The roster entry. Without one there is nothing to open. */
  subagent?: SubagentInfo;
  name: string;
  /** Tool-status vocabulary (a delegation chip's status). */
  status: string | undefined;
  /** Mission from the delegation input when the roster has none. */
  fallback?: string;
  /** Leading glyph; defaults to the status dot (which then moves beside the label). */
  glyph?: React.ReactNode;
  nameStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}) {
  const nodeId = useBackgroundWorkNodeId();
  const hintId = useId();
  // Another turn holds a copy of this agent too (a newer status, or the
  // launch turn's steps): show the folded copy and its status. With one
  // copy only, the caller's status stands (it knows legacy rosters).
  const conversation = useConversationSubagent(nodeId, ownCopy?.sessionId);
  const shown = shownSubagent(ownCopy, conversation);
  const { subagent, active } = shown;
  const status = shown.folded ? subagentToolStatus(shown.subagent, shown.active) : ownStatus;
  const running = isRunningStatus(status);
  const failed = isFailedStatus(status);
  const summary = subagentSummary(subagent, { running, fallback });
  const statusColor = failed ? 'var(--term-danger)' : running ? 'var(--term-accent)' : 'var(--term-muted)';
  const statusLabel = subagentStatusLabel(status);
  const content = (
    <>
      {glyph ?? <SubagentStatusGlyph status={status} />}
      <span style={{ ...ellipsis, flexShrink: 0, maxWidth: '45%', fontSize: 'var(--fs-sm)', fontWeight: 600, color: failed ? 'var(--term-danger)' : 'var(--term-fg)', ...nameStyle }}>
        {name}
      </span>
      {summary ? <SubagentSummaryText summary={summary} /> : <span style={{ flex: 1 }} />}
      <span style={{ flexShrink: 0, paddingLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {/* A custom leading glyph names the kind; the dot still says the state. */}
        {glyph && <SubagentStatusGlyph status={status} />}
        {subagent && status === subagentToolStatus(subagent, active)
          ? <SubagentToneLabel subagent={subagent} active={active} />
          : <FadeOnChange k={statusLabel} style={{ fontSize: 'var(--fs-xs)', color: statusColor }}>{statusLabel}</FadeOnChange>}
      </span>
    </>
  );
  if (!subagent || !nodeId) {
    return <div data-testid="subagent-summary" style={{ ...lineStyle, ...style }}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-testid="subagent-summary"
      data-subagent-id={subagent.sessionId}
      aria-haspopup="dialog"
      aria-describedby={hintId}
      title="Show in background work"
      className="t-hover-bg-alt"
      onClick={() => openBackgroundWork({ nodeId, focus: { kind: 'subagent', sessionId: subagent.sessionId } })}
      style={{ ...buttonReset, ...lineStyle, ...style }}
    >
      {/* The line's content is its name (what the agent does or returned); the hint is its description. */}
      {content}
      <span id={hintId} hidden>Show in background work</span>
    </button>
  );
}

/**
 * One subagent as a compact row. Used where one delegation owns several
 * agents (Kiro crews, Codex spawns) and for agents no chip claims.
 */
export function SubagentRow({ subagent }: { subagent: SubagentInfo }) {
  return (
    <div data-testid="subagent-row" data-subagent-id={subagent.sessionId} style={{ minWidth: 0 }}>
      <SubagentSummaryLine
        subagent={subagent}
        name={subagentDisplayName(subagent)}
        status={subagentToolStatus(subagent)}
        style={{ padding: '1px 0' }}
      />
    </div>
  );
}

/** Subagents in a message that no tool chip claims. */
export function MessageSubagents({ subagents }: { subagents: readonly SubagentInfo[] }) {
  if (subagents.length === 0) return null;
  const working = subagents.filter((subagent) => subagent.status === 'working').length;
  // The counter fades to its new value; an agent joining the roster grows in.
  const counter = working > 0 ? `${working} working` : `${subagents.length} done`;
  return (
    <section
      aria-label={`${subagents.length} subagents`}
      data-testid="message-subagents"
      style={{ margin: '10px 0 6px', fontFamily: 'var(--ui-font)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps-wide)', textTransform: 'uppercase', color: 'var(--term-muted)', fontWeight: 500 }}>
          subagents
        </span>
        <span aria-hidden style={{ flex: 1, borderTop: '1px solid var(--term-line)' }} />
        <FadeOnChange k={counter} style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: working > 0 ? 'var(--term-accent)' : 'var(--term-muted)' }}>
          {counter}
        </FadeOnChange>
      </div>
      <RevealList gap={4} rows={subagents.map((subagent) => ({ key: subagent.sessionId, node: <SubagentRow subagent={subagent} /> }))} />
    </section>
  );
}
