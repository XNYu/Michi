import React, { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion, useIsPresent, type Variants } from 'motion/react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { DUR, EASE } from '../../../../../motion/tokens';
import { FolderIcon } from '../../../icons';
import { isTaskDb, TASK_COLUMN } from 'michi-shared';
import { ThreadStateDot } from '../../ThreadStateDot';
import { TaskStatusGlyph } from '../TaskStatusGlyph';
import { CellView, OptionPill } from '../CellView';
import { cellOf, cellText, isBlank, isThreadsDb, titleColumn, type DbGroup } from '../dbModel';
import { columnName, groupName, optionName } from '../dbLabels';

export const UNTITLED = 'Untitled';

/** Tells the page which rows a view draws, in reading order and each once (a multi-select row shows in several places). */
export function useReportDrawn(onDrawn: ((ids: string[]) => void) | undefined, lists: ReadonlyArray<readonly MichiDbRow[]>): void {
  const ids = useMemo(() => {
    const seen = new Set<string>();
    for (const list of lists) for (const row of list) seen.add(row.id);
    return Array.from(seen);
  }, [lists]);
  useEffect(() => { onDrawn?.(ids); }, [onDrawn, ids]);
}

/** The words that name a row. */
export function rowTitle(db: MichiDatabase, row: MichiDbRow): string {
  const title = titleColumn(db);
  return (title ? cellText(title, cellOf(row, title.id), (c, v) => optionName(db, c, v)) : '').trim() || UNTITLED;
}

// The count rolls the way it changed: up as a column fills, down as it empties.
const ROLL: Variants = {
  enter: (dir: number) => ({ y: `${dir * 100}%`, opacity: 0 }),
  shown: { y: 0, opacity: 1, transition: { duration: 0.2, ease: EASE.out, delay: 0.04 } },
  exit: (dir: number) => ({ y: `${-dir * 100}%`, opacity: 0, transition: { duration: DUR.collapse, ease: EASE.out } }),
};
const ROLL_STAGE: React.CSSProperties = { display: 'inline-grid', overflow: 'hidden' };
const ROLL_LAYER: React.CSSProperties = { gridArea: '1 / 1' };

function RollingDigits({ value, dir }: { value: number; dir: number }) {
  // The number on its way out is not read out alongside the new one.
  const present = useIsPresent();
  return <motion.span style={ROLL_LAYER} custom={dir} variants={ROLL} initial="enter" animate="shown" exit="exit" aria-hidden={present ? undefined : true}>{value}</motion.span>;
}

/** A count that rolls to its new value; it is drawn settled the first time. */
export function RollingCount({ value, className }: { value: number; className?: string }) {
  const last = useRef(value);
  const dir = useRef(1);
  if (value !== last.current) {
    dir.current = value > last.current ? 1 : -1;
    last.current = value;
  }
  return (
    <span className={className} style={ROLL_STAGE}>
      <AnimatePresence initial={false} custom={dir.current}>
        <RollingDigits key={value} value={value} dir={dir.current} />
      </AnimatePresence>
    </span>
  );
}

/** A group's heading: its option (with a thread's state dot) or value, its count and sums. */
export function GroupHeading({
  db,
  column,
  group,
  showCount,
  sums,
  roll = false,
  cheer,
}: {
  db: MichiDatabase;
  column?: MichiDbColumn;
  group: DbGroup;
  showCount: boolean;
  sums: string[];
  /** A board column's heading: its count rolls as cards come and go. */
  roll?: boolean;
  /** Changes when cards arrive in the group: a Done heading's check settles again. */
  cheer?: string;
}) {
  const threadState = column && isThreadsDb(db) && column.builtin && column.id === 'state' && group.key !== null;
  const taskStatus = !!column && isTaskDb(db) && column.id === TASK_COLUMN.status && group.key !== null;
  const option = column && group.key !== null && (column.type === 'select' || column.type === 'multi' || column.type === 'app') && !threadState && !taskStatus;
  return (
    <span className="michi-db-group">
      {threadState && (
        <span className="michi-db-group__dot" aria-hidden="true">
          <ThreadStateDot state={group.key as DatabaseRowStatus['state']} size={8} />
        </span>
      )}
      {taskStatus && (
        <span className="michi-db-group__dot" aria-hidden="true">
          <TaskStatusGlyph status={group.key!} cheer={cheer} />
        </span>
      )}
      {option ? (
        <OptionPill db={db} column={column!} value={group.key!} />
      ) : (
        <span className="michi-db-group__label">{groupName(db, column, group.key, group.label)}</span>
      )}
      {showCount && (roll
        ? <RollingCount className="michi-db-group__count michi-db-mono" value={group.count} />
        : <span className="michi-db-group__count michi-db-mono">{group.count}</span>)}
      {sums.map((s) => <span key={s} className="michi-db-group__sum michi-db-mono">· {s}</span>)}
    </span>
  );
}

const SUM = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** The chosen number columns' sums (progress: the average) as a group heading says them. Empty cells count for neither. */
export function groupSums(db: MichiDatabase, group: DbGroup, columns: readonly MichiDbColumn[], wanted: readonly string[]): string[] {
  return columns.flatMap((c) => {
    if (!wanted.includes(c.id)) return [];
    const sum = group.sums[c.id];
    const filled = group.rows.filter((r) => typeof r.values[c.id] === 'number').length;
    if (sum === undefined || !filled) return [];
    return c.type === 'progress' ? [`${columnName(db, c)} avg ${Math.round((sum / filled) * 100)}%`] : [`${columnName(db, c)} ${SUM.format(sum)}`];
  });
}

/**
 * A row's other properties as small facts on a card (values only, skipping
 * empty ones). `line`: on one line after a list row's title, each fact
 * truncated rather than wrapped; All threads' project reads as its folder.
 */
export function RowFacts({
  db,
  row,
  columns,
  thread,
  now,
  line = false,
}: {
  db: MichiDatabase;
  row: MichiDbRow;
  columns: readonly MichiDbColumn[];
  thread?: DatabaseRowStatus;
  now: number;
  line?: boolean;
}) {
  const facts = columns.filter((c) => c.type === 'checkbox' ? cellOf(row, c.id) === true : !isBlank(cellOf(row, c.id)));
  if (!facts.length) return null;
  return (
    <span className={line ? 'michi-db-facts michi-db-facts--line' : 'michi-db-facts'}>
      {facts.map((c) => {
        const value = cellOf(row, c.id);
        const place = line && isThreadsDb(db) && c.builtin && c.id === 'project' && typeof value === 'string';
        return (
          <span key={c.id} className="michi-db-fact" data-column={c.builtin ? c.id : undefined} title={place ? optionName(db, c, value) : columnName(db, c)}>
            {place ? (
              <span className="michi-db-place">
                <FolderIcon size={12} />
                <span className="michi-db-text">{optionName(db, c, value)}</span>
              </span>
            ) : (
              <CellView db={db} column={c} value={value} thread={thread} now={now} />
            )}
          </span>
        );
      })}
    </span>
  );
}
