import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { ThreadStateDot } from '../../ThreadStateDot';
import { threadItemProps, type ThreadItemHandlers } from '../../threads/threadItem';
import { cellOf, dateColumn, dateColumns, dayOf, isDateValue, isThreadsDb, localDay, planColumn } from '../dbModel';
import { columnName, formatDay, viewName } from '../dbLabels';
import { viewSave } from '../dbOps';
import { GroupHeading, rowTitle, } from './RowBits';
import type { DbViewProps } from './viewTypes';

const DAY_MS = 86_400_000;
const MIN_DAYS = 14;
const MAX_DAYS = 92;

export interface Span { start: string; end: string }

/** A cell's dates as a span of local days; null when it holds none. */
export function spanOf(value: unknown): Span | null {
  if (isDateValue(value)) {
    const start = dayOf(value.start);
    const end = value.end ? dayOf(value.end) : start;
    return start && end ? (end < start ? { start: end, end: start } : { start, end }) : null;
  }
  if (typeof value === 'string') {
    const day = dayOf(value);
    return day ? { start: day, end: day } : null;
  }
  return null;
}

const dayNum = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(new Date(y, m - 1, d).getTime() / DAY_MS);
};

export interface Axis { first: number; days: number; today: number; labels: Array<{ day: string; n: number }> }

/**
 * The days the timeline draws: every span (and today), padded a day each
 * side, at least two weeks; past three months only the latest three.
 */
export function timelineAxis(spans: readonly Span[], now: number): Axis {
  const today = dayNum(localDay(new Date(now)));
  let lo = today;
  let hi = today;
  for (const s of spans) {
    lo = Math.min(lo, dayNum(s.start));
    hi = Math.max(hi, dayNum(s.end));
  }
  lo -= 1;
  hi += 1;
  if (hi - lo + 1 < MIN_DAYS) lo = hi - MIN_DAYS + 1;
  if (hi - lo + 1 > MAX_DAYS) lo = hi - MAX_DAYS + 1;
  const days = hi - lo + 1;
  const labels = Array.from({ length: days }, (_, i) => {
    const d = new Date((lo + i) * DAY_MS);
    // dayNum went through local midnight; step back to the local calendar day.
    const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return { day: localDay(local), n: local.getDate() };
  });
  return { first: lo, days, today, labels };
}

/** The axis's narrowest day (the timeline's min-width), and the mono label's width per character, in px. */
export const AXIS_MIN_DAY_PX = 22;
const LABEL_CHAR_PX = 6.2;
const LABEL_PAD_PX = 6;

/**
 * Which days of the axis carry a label at `dayPx` per day, so none overlap:
 * a month's first day (and the first day drawn) reads `Oct 1` and may take
 * the next days' room, a day number takes its own; a day whose room is taken
 * goes unlabelled (null). Its tick line stays either way. No other label takes
 * a month start's room: the first day drawn falls back to its number, and a
 * number that would still run into the month start goes.
 */
export function axisLabels(labels: Axis['labels'], dayPx: number): Array<{ text: string; span: number } | null> {
  const label = (text: string) => ({ text, span: Math.max(1, Math.ceil((text.length * LABEL_CHAR_PX + LABEL_PAD_PX) / Math.max(1, dayPx))) });
  // For each day, the index of the next month start after it (or past the end).
  const nextStart = new Array<number>(labels.length);
  for (let i = labels.length - 1, next = labels.length; i >= 0; i -= 1) {
    nextStart[i] = next;
    if (labels[i].n === 1) next = i;
  }
  let free = 0;
  return labels.map((l, i) => {
    if (i < free) return null;
    let out = label(l.n === 1 || i === 0 ? formatDay(l.day) : String(l.n));
    if (l.n !== 1 && i + out.span > nextStart[i]) {
      if (i === 0) out = label(String(l.n));
      if (i + out.span > nextStart[i]) return null;
    }
    free = i + out.span;
    return out;
  });
}

/** Where a span sits on the axis, as percentages; clipped spans say which end ran off. */
export function placeSpan(axis: Axis, span: Span): { left: number; width: number; before: boolean; after: boolean } | null {
  const a = dayNum(span.start) - axis.first;
  const b = dayNum(span.end) - axis.first;
  if (b < 0 || a >= axis.days) return null;
  const from = Math.max(0, a);
  const to = Math.min(axis.days - 1, b);
  return { left: (from / axis.days) * 100, width: ((to - from + 1) / axis.days) * 100, before: a < 0, after: b >= axis.days };
}

/**
 * The timeline: a lane per row, its actual dates filled and its plan (a
 * second date column) outlined underneath; an actual that runs past its plan
 * turns amber. All threads draws each thread at its last activity. A line
 * marks today.
 */
export function TimelineView({ db, view, config, groups, groupColumn, prefs, edit, handlers, threadOf, now }: DbViewProps) {
  const actualCol = dateColumn(db, config);
  const planCol = planColumn(db, config);
  const lanes = useMemo(() => groups.map((g) => ({
    group: g,
    rows: g.rows.map((row) => ({
      row,
      actual: actualCol ? spanOf(cellOf(row, actualCol.id)) : null,
      plan: planCol ? spanOf(cellOf(row, planCol.id)) : null,
    })),
  })), [groups, actualCol, planCol]);
  const axis = useMemo(
    () => timelineAxis(lanes.flatMap((l) => l.rows.flatMap((r) => [r.actual, r.plan].filter((s): s is Span => !!s))), now),
    [lanes, now],
  );
  const dates = dateColumns(db);
  // How wide a day is right now, so the day labels thin out rather than overlap.
  const daysRef = useRef<HTMLSpanElement>(null);
  const [dayPx, setDayPx] = useState(AXIS_MIN_DAY_PX);
  useLayoutEffect(() => {
    const el = daysRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setDayPx((prev) => (Math.abs(prev - width / axis.days) < 0.5 ? prev : width / axis.days));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [axis.days, actualCol]);
  const shownLabels = useMemo(() => axisLabels(axis.labels, dayPx), [axis.labels, dayPx]);
  if (!actualCol) {
    return <p className="michi-db-empty">Add a date column to see a timeline</p>;
  }
  const todayAt = ((axis.today - axis.first + 0.5) / axis.days) * 100;
  const grouped = config.group !== undefined && !!groupColumn;
  const style = { '--days': axis.days } as React.CSSProperties;
  return (
    <div className="michi-db-timeline">
      {!isThreadsDb(db) && (
        <div className="michi-db-dates" role="group" aria-label="Timeline dates">
          <label>
            <span>Dates</span>
            <select
              className="michi-db-select"
              value={actualCol.id}
              onChange={(event) => { void edit([viewSave(view, { ...view.config, date: event.currentTarget.value })], 'Changed the timeline'); }}
            >
              {dates.map((c) => <option key={c.id} value={c.id}>{columnName(db, c)}</option>)}
            </select>
          </label>
          <label>
            <span>Plan</span>
            <select
              className="michi-db-select"
              value={planCol?.id ?? ''}
              onChange={(event) => {
                const next = event.currentTarget.value;
                const { planDate: _drop, ...rest } = view.config;
                void edit([viewSave(view, next ? { ...rest, planDate: next } : rest)], 'Changed the timeline');
              }}
            >
              <option value="">None</option>
              {dates.filter((c) => c.id !== actualCol.id).map((c) => <option key={c.id} value={c.id}>{columnName(db, c)}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="michi-db-tl" style={style} role="grid" aria-label={viewName(db, view)}>
        <div className="michi-db-tl__head" role="row">
          <span className="michi-db-tl__name" role="columnheader">{isThreadsDb(db) ? 'Thread' : columnName(db, db.columns[0] ?? actualCol)}</span>
          <span ref={daysRef} className="michi-db-tl__days" role="columnheader">
            {axis.labels.map((l, i) => {
              const label = shownLabels[i];
              return (
                <span
                  key={l.day}
                  data-today={axis.first + i === axis.today ? 'true' : undefined}
                  data-wide={label && label.span > 1 ? 'true' : undefined}
                  title={formatDay(l.day)}
                >
                  {label && <span className="michi-db-tl__label">{label.text}</span>}
                </span>
              );
            })}
          </span>
        </div>
        {lanes.map(({ group, rows }) => (
          <React.Fragment key={group.key ?? '\u0000'}>
            {grouped && rows.length > 0 && (
              <div className="michi-db-tl__group" role="row">
                <GroupHeading db={db} column={groupColumn} group={group} showCount={prefs.showCounts} sums={[]} />
              </div>
            )}
            {rows.map(({ row, actual, plan }) => (
              <Lane
                key={`${group.key ?? ''}\n${row.id}`}
                db={db}
                row={row}
                thread={threadOf(row.id)}
                axis={axis}
                actual={actual}
                plan={plan}
                todayAt={todayAt}
                handlers={handlers}
                actualCol={actualCol}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function Lane({
  db,
  row,
  thread,
  axis,
  actual,
  plan,
  todayAt,
  handlers,
  actualCol,
}: {
  db: MichiDatabase;
  row: MichiDbRow;
  thread?: DatabaseRowStatus;
  axis: Axis;
  actual: Span | null;
  plan: Span | null;
  todayAt: number;
  handlers: ThreadItemHandlers;
  actualCol: MichiDbColumn;
}) {
  const a = actual ? placeSpan(axis, actual) : null;
  const p = plan ? placeSpan(axis, plan) : null;
  const state = isThreadsDb(db) ? (cellOf(row, 'state') as DatabaseRowStatus['state'] | null) : null;
  const over = !!(actual && plan && actual.end > plan.end);
  const point = !!actual && actual.start === actual.end && !plan;
  const title = rowTitle(db, row);
  const when = actual ? (actual.start === actual.end ? formatDay(actual.start) : `${formatDay(actual.start)} → ${formatDay(actual.end)}`) : 'No date';
  return (
    <div className="michi-db-tl__lane michi-item" role="row" {...threadItemProps(row.id, handlers, 'row')}>
      <span className="michi-db-tl__name" role="rowheader">
        {state && <ThreadStateDot state={state} doneBy={thread?.doneBy} size={8} />}
        <span className="michi-db-tl__title">{title}</span>

      </span>
      <span className="michi-db-tl__track" role="gridcell" aria-label={`${columnName(db, actualCol)}: ${when}`}>
        {p && <i className="michi-db-tl__plan" style={{ left: `${p.left}%`, width: `${p.width}%` }} />}
        {a && (
          <i
            className="michi-db-tl__actual"
            data-over={over ? 'true' : undefined}
            data-state={state ?? undefined}
            data-point={point ? 'true' : undefined}
            // A single day of All threads' activity is a mark in the middle of its day.
            style={point ? { left: `${a.left + a.width / 2}%` } : { left: `${a.left}%`, width: `${a.width}%` }}
          />
        )}
        {actual && !a && <span className="michi-db-tl__off">‹ {formatDay(actual.end)}</span>}
        <i className="michi-db-tl__now" style={{ left: `${todayAt}%` }} aria-hidden="true" />
      </span>
    </div>
  );
}
