import React, { useState } from 'react';
import type { SubagentActivity, SubagentInfo } from '../../../state/chatTypes';
import MarkdownContent from '../../MarkdownContent';
import { formatDurationMs, isFailedStatus, isRunningStatus } from '../toolCallGrouping';
import { useLiveNow } from '../workflows/WorkflowRunCard';
import {
  formatTokenCount,
  subagentDurationMs,
  subagentShownDurationMs,
  subagentToolCount,
  subagentTone,
} from './subagentPresentation';

/**
 * The expanded body of a subagent: what it was asked (task), what it did
 * (activity trail), what it returned (result / error) and what it cost.
 *
 * Visual language follows the tool payload block: hairline-ruled caps labels
 * on --term-alt, mono for machine detail, the shared status glyphs.
 */

const MONO = 'var(--font-mono)';
const ACTIVITY_PREVIEW = 12;
const TASK_PREVIEW_CHARS = 600;

const resultProseVars: React.CSSProperties = {
  '--tw-prose-body': 'var(--term-mid)',
  '--tw-prose-headings': 'var(--term-fg)',
  '--tw-prose-bold': 'var(--term-fg)',
  '--tw-prose-code': 'var(--term-fg)',
  '--tw-prose-quotes': 'var(--term-mid)',
  '--tw-prose-links': 'var(--term-accent)',
  '--tw-prose-counters': 'var(--term-muted)',
  '--tw-prose-bullets': 'var(--term-muted)',
} as React.CSSProperties;

const labelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px 3px',
  fontSize: 'var(--fs-2xs)',
  letterSpacing: 'var(--ls-caps-wide)',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
  fontFamily: 'var(--ui-font)',
};

const textButtonStyle: React.CSSProperties = {
  border: 0,
  padding: 0,
  background: 'transparent',
  color: 'var(--term-muted)',
  font: 'inherit',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
};

function SectionLabel({ children, tone, aside }: { children: React.ReactNode; tone?: string; aside?: React.ReactNode }) {
  return (
    <div style={{ ...labelRowStyle, ...(tone ? { color: tone } : null) }}>
      <span>{children}</span>
      <span aria-hidden style={{ flex: 1, borderTop: '1px solid var(--term-line)' }} />
      {aside}
    </div>
  );
}

function ActivityGlyph({ item }: { item: SubagentActivity }) {
  if (item.kind === 'message') {
    return <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-faint)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>›</span>;
  }
  if (isFailedStatus(item.status) || item.status === 'interrupted') {
    return <span aria-hidden style={{ width: 8, flexShrink: 0, color: 'var(--term-danger)', fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>;
  }
  return (
    <span aria-hidden style={{ width: 8, flexShrink: 0, display: 'inline-flex', alignSelf: 'center' }}>
      <span className={isRunningStatus(item.status) ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} />
    </span>
  );
}

function ActivityRow({ item }: { item: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const hasOutput = item.kind === 'tool' && !!item.output;
  const failed = isFailedStatus(item.status) || item.status === 'interrupted';
  const duration = item.startedAt !== undefined && item.endedAt !== undefined && item.endedAt >= item.startedAt
    ? item.endedAt - item.startedAt
    : undefined;
  const message = item.kind === 'message';
  return (
    <li data-testid="subagent-activity-row" data-activity-kind={item.kind} style={{ listStyle: 'none' }}>
      <div
        role={hasOutput ? 'button' : undefined}
        tabIndex={hasOutput ? 0 : undefined}
        aria-expanded={hasOutput ? open : undefined}
        onClick={hasOutput ? () => setOpen((value) => !value) : undefined}
        onKeyDown={hasOutput ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value); }
        } : undefined}
        className={hasOutput ? 't-hover-fg' : undefined}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 7,
          padding: '2px 10px',
          cursor: hasOutput ? 'pointer' : 'default',
          minWidth: 0,
        }}
      >
        <ActivityGlyph item={item} />
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          <span style={{
            fontSize: 'var(--fs-sm)',
            lineHeight: 1.45,
            color: failed ? 'var(--term-danger)' : message ? 'var(--term-mid)' : 'var(--term-fg)',
          }}>
            {item.title || item.toolKind || 'tool'}
          </span>
          {item.detail && item.detail !== item.title && (
            <span style={{ display: 'block', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.toolKind ? `${item.toolKind} ` : ''}{item.detail}
            </span>
          )}
        </span>
        {duration !== undefined && (
          <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
            {formatDurationMs(duration)}
          </span>
        )}
        {hasOutput && (
          <span aria-hidden style={{ flexShrink: 0, fontSize: 'var(--fs-2xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>
        )}
      </div>
      {open && hasOutput && (
        <pre
          className="term-scrollbar"
          style={{
            margin: '2px 10px 4px 25px',
            padding: '5px 8px',
            maxHeight: 220,
            overflowY: 'auto',
            borderLeft: `2px solid ${failed ? 'var(--term-danger)' : 'var(--term-line-s)'}`,
            background: 'var(--term-surface)',
            fontFamily: MONO,
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            color: 'var(--term-mid)',
            fontVariantLigatures: 'none',
          }}
        >
          {item.output}
        </pre>
      )}
    </li>
  );
}

function ActivityList({ subagent }: { subagent: SubagentInfo }) {
  const [showAll, setShowAll] = useState(false);
  const activity = subagent.activity ?? [];
  const hidden = showAll ? 0 : Math.max(0, activity.length - ACTIVITY_PREVIEW);
  const visible = hidden > 0 ? activity.slice(hidden) : activity;
  const dropped = subagent.activityDropped ?? 0;
  return (
    <>
      {(hidden > 0 || dropped > 0) && (
        <div style={{ padding: '0 10px 2px 25px', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
          {hidden > 0 ? (
            <button type="button" className="t-hover-fg" style={textButtonStyle} onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
            </button>
          ) : (
            <span>{dropped} earlier {dropped === 1 ? 'step' : 'steps'} not kept</span>
          )}
        </div>
      )}
      <ol aria-label="Subagent activity" style={{ margin: 0, padding: '0 0 4px' }}>
        {visible.map((item) => <ActivityRow key={item.id} item={item} />)}
      </ol>
    </>
  );
}

function TaskText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TASK_PREVIEW_CHARS;
  const shown = expanded || !long ? text : `${text.slice(0, TASK_PREVIEW_CHARS).trimEnd()}…`;
  return (
    <div style={{ padding: '0 10px 6px' }}>
      <div data-testid="subagent-task" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {shown}
      </div>
      {long && (
        <button type="button" className="t-hover-fg" style={{ ...textButtonStyle, marginTop: 3 }} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show full task'}
        </button>
      )}
    </div>
  );
}

/** `active` given: the shown duration, on a live clock while it runs (subagentShownDurationMs). */
function MetaLine({ subagent, active }: { subagent: SubagentInfo; active?: boolean }) {
  const now = useLiveNow(active === true);
  const duration = active === undefined ? subagentDurationMs(subagent) : subagentShownDurationMs(subagent, active, now);
  const tools = subagentToolCount(subagent);
  const parts = [
    subagent.model,
    subagent.usage?.totalTokens !== undefined ? formatTokenCount(subagent.usage.totalTokens) : undefined,
    tools > 0 ? `${tools} ${tools === 1 ? 'tool' : 'tools'}` : undefined,
    duration !== undefined ? formatDurationMs(duration) : undefined,
    subagent.source,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div data-testid="subagent-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '5px 10px 7px', borderTop: '1px solid var(--term-line)', fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>
      {parts.map((part, index) => (
        <React.Fragment key={`${part}-${index}`}>
          {index > 0 && <span aria-hidden>·</span>}
          <span>{part}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** Stable DOM id tying a Background work row to the detail it expands. */
export function subagentDetailDomId(subagent: SubagentInfo): string {
  return `subagent-detail-${subagent.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function SubagentDetail({ subagent, active, embedded = false, bounded = true }: {
  subagent: SubagentInfo;
  /**
   * Whether the conversation counts it as running (isSubagentRunningIn). A
   * `working` entry it does not count shows no live step; without it,
   * `working` is taken at its word.
   */
  active?: boolean;
  embedded?: boolean;
  /** Cap the height with its own scroll; off where the container scrolls (the drawer). */
  bounded?: boolean;
}) {
  const activityCount = (subagent.activity?.length ?? 0) + (subagent.activityDropped ?? 0);
  const running = subagent.status === 'working' && active !== false;
  // Reads "stopped" (SUBAGENT_TONE_LABEL), so its error is a reason, not a failure.
  const stopped = subagentTone(subagent, active) === 'cancelled';
  return (
    <div
      id={subagentDetailDomId(subagent)}
      data-testid="subagent-detail"
      className={bounded ? 'term-scrollbar' : undefined}
      style={{
        ...(embedded ? { borderTop: '1px solid var(--term-line)' } : { border: '1px solid var(--term-line)' }),
        background: 'var(--term-alt)',
        ...(bounded ? { maxHeight: 560, overflowY: 'auto' as const } : null),
        fontFamily: 'var(--ui-font)',
      }}
    >
      {subagent.prompt && (
        <>
          <SectionLabel>task</SectionLabel>
          <TaskText text={subagent.prompt} />
        </>
      )}
      {activityCount > 0 && (
        <>
          <SectionLabel aside={running && subagent.currentTool ? (
            <span style={{ textTransform: 'none', letterSpacing: 0, fontFamily: MONO, color: 'var(--term-accent)', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              now ❯ {subagent.currentTool}
            </span>
          ) : undefined}>
            activity · {activityCount}
          </SectionLabel>
          <ActivityList subagent={subagent} />
        </>
      )}
      {subagent.error && (
        <>
          {stopped
            ? <SectionLabel>why it stopped</SectionLabel>
            : <SectionLabel tone="var(--term-danger)">error</SectionLabel>}
          <pre
            data-testid="subagent-error"
            data-error-tone={stopped ? 'stopped' : 'error'}
            style={{ margin: 0, padding: '0 10px 7px', fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: stopped ? 'var(--term-mid)' : 'var(--term-danger)' }}
          >
            {subagent.error}
          </pre>
        </>
      )}
      {subagent.result && (
        <>
          <SectionLabel>result</SectionLabel>
          <div data-testid="subagent-result" style={{ padding: '0 10px 8px' }}>
            {/* Typography has no prose-xs; the wrapper size scales its em-based children. */}
            <MarkdownContent text={subagent.result} size="sm" style={{ ...resultProseVars, fontSize: 'var(--fs-md)', lineHeight: 1.55 }} />
          </div>
        </>
      )}
      {subagent.background && subagent.status !== 'working' && !subagent.outcome && (
        <div style={{ padding: '7px 10px', fontSize: 'var(--fs-sm)', color: 'var(--term-mid)' }}>
          Still running after this turn ended. Its result arrives with a later reply.
        </div>
      )}
      {!subagent.prompt && activityCount === 0 && !subagent.result && !subagent.error && !subagent.background && (
        <div style={{ padding: '7px 10px', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>
          {running ? 'Waiting for the first step…' : 'The runtime reported no detail for this subagent.'}
        </div>
      )}
      <MetaLine subagent={subagent} active={active} />
    </div>
  );
}
