import React, { useMemo, useRef, useState } from 'react';
import type { MichiDatabase, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { ChevronLeftIcon, ChevronRightIcon } from '../../../icons';
import { ThreadStateDot } from '../../ThreadStateDot';
import { threadItemProps, type ThreadItemHandlers } from '../../threads/threadItem';
import { cellEditable, cellOf, dateColumn, isThreadsDb, localDay, rowsInOrder } from '../dbModel';
import { columnName, formatDay } from '../dbLabels';
import { calendarMoveOps } from '../dbOps';
import { rowTitle, useReportDrawn, } from './RowBits';
import { spanOf } from './TimelineView';
import type { DbViewProps } from './viewTypes';

const DAY_LIMIT = 3;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface DbCalendarDay {
  key: string;
  label: string;
  day: number;
  inMonth: boolean;
  today: boolean;
  rows: MichiDbRow[];
}

/** The month as Monday-first weeks, padded with the neighbouring months' days. Rows sit on their date's first day, in view order. */
export function monthWeeks(year: number, month: number, rows: readonly MichiDbRow[], dayOfRow: (row: MichiDbRow) => string | null, now: number): DbCalendarDay[][] {
  const byDay = new Map<string, MichiDbRow[]>();
  for (const r of rows) {
    const day = dayOfRow(r);
    if (!day) continue;
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  }
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const cursor = new Date(year, month, 1 - lead);
  const last = new Date(year, month + 1, 0);
  const trail = 6 - ((last.getDay() + 6) % 7);
  const total = lead + last.getDate() + trail;
  const today = localDay(new Date(now));
  const weeks: DbCalendarDay[][] = [];
  for (let i = 0; i < total; i += 1) {
    if (i % 7 === 0) weeks.push([]);
    const key = localDay(cursor);
    const inMonth = cursor.getMonth() === month;
    weeks[weeks.length - 1].push({
      key,
      label: `${MONTHS_LONG[cursor.getMonth()]} ${cursor.getDate()}`,
      day: cursor.getDate(),
      inMonth,
      today: key === today,
      rows: inMonth ? byDay.get(key) ?? [] : [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return weeks;
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month]} ${year}`;
}

/**
 * One month, Monday first; each day lists the rows dated that day (All
 * threads: the day each thread last moved). Dragging a row to another day
 * sets its date, keeping a range's length.
 */
export function CalendarView({ db, groups, config, edit, handlers, threadOf, notice, now, onDrawn }: DbViewProps) {
  const col = dateColumn(db, config);
  const [month, setMonth] = useState(() => {
    const d = new Date(now);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const rows = useMemo(() => rowsInOrder(groups), [groups]);
  const weeks = useMemo(
    () => monthWeeks(month.year, month.month, rows, (r) => (col ? spanOf(cellOf(r, col.id))?.start ?? null : null), now),
    [month, rows, col, now],
  );
  const days = useMemo(() => weeks.flat().map((day) => day.rows.slice(0, DAY_LIMIT)), [weeks]);
  useReportDrawn(onDrawn, days);
  const drag = useRef<MichiDbRow | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!col) return <p className="michi-db-empty">Add a date column to see a calendar</p>;
  const movable = cellEditable(col);

  const shift = (step: 1 | -1) => setMonth((m) => {
    const d = new Date(m.year, m.month + step, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const drop = (day: string) => {
    const row = drag.current;
    drag.current = null;
    setOver(null);
    if (!row) return;
    const check = calendarMoveOps(db, row, col, day);
    if (!check.ok) {
      notice(check.reason);
      return;
    }
    if (check.ops.length) void edit(check.ops, `Moved to ${formatDay(day)}`);
  };

  return (
    <div className="michi-cal">
      <div className="michi-cal__head">
        <span className="michi-cal__month">{monthTitle(month.year, month.month)}</span>
        <button type="button" className="michi-cal__nav" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeftIcon size={13} />
        </button>
        <button type="button" className="michi-cal__nav" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRightIcon size={13} />
        </button>
        {!isThreadsDb(db) && <span className="michi-cal__by">{columnName(db, col)}</span>}
      </div>
      <div className="michi-cal__grid">
        {WEEKDAYS.map((weekday) => <div key={weekday} className="michi-cal__weekday">{weekday}</div>)}
        {weeks.flat().map((day) => (
          <div
            key={day.key}
            role="group"
            aria-label={day.label}
            className="michi-cal__day"
            data-day={day.day}
            data-in-month={day.inMonth ? 'true' : 'false'}
            data-today={day.today ? 'true' : undefined}
            data-over={over === day.key ? 'true' : undefined}
            onDragOver={(event) => {
              if (!drag.current || !movable) return;
              event.preventDefault();
              if (over !== day.key) setOver(day.key);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((o) => (o === day.key ? null : o));
            }}
            onDrop={(event) => {
              event.preventDefault();
              drop(day.key);
            }}
          >
            <span className="michi-cal__num michi-threads__mono" aria-hidden="true">{day.day}</span>
            {day.rows.slice(0, DAY_LIMIT).map((row) => (
              <CalendarItem
                key={row.id}
                db={db}
                row={row}
                thread={threadOf(row.id)}
                handlers={handlers}
                movable={movable}
                onDragStart={() => { drag.current = row; }}
                onDragEnd={() => { drag.current = null; setOver(null); }}
              />
            ))}
            {day.rows.length > DAY_LIMIT && <span className="michi-cal__more michi-threads__mono">+{day.rows.length - DAY_LIMIT}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarItem({
  db,
  row,
  thread,
  handlers,
  movable,
  onDragStart,
  onDragEnd,
}: {
  db: MichiDatabase;
  row: MichiDbRow;
  thread?: DatabaseRowStatus;
  handlers: ThreadItemHandlers;
  movable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const state = isThreadsDb(db) ? (cellOf(row, 'state') as DatabaseRowStatus['state'] | null) : null;
  const title = rowTitle(db, row);
  return (
    <div
      className="michi-cal__item michi-item"
      title={title}
      draggable={movable}
      onDragStart={(event) => {
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      {...threadItemProps(row.id, handlers, 'button')}
    >
      {state && <ThreadStateDot state={state} doneBy={thread?.doneBy} size={7} />}
      <span className="michi-cal__item-title">{title}</span>

    </div>
  );
}
