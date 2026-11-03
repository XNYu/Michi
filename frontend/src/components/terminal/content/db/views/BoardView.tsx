import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DndContext, DragOverlay, KeyboardCode, KeyboardSensor, PointerSensor, closestCorners, pointerWithin, useDroppable, useSensor, useSensors,
  type Active, type Announcements, type CollisionDetection, type DragEndEvent, type Over,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, type SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LayoutGroupContext, motion, useReducedMotionConfig } from 'motion/react';
import { Plus } from 'lucide-react';
import type { MichiDatabase, MichiDbColumn, MichiDbRow, DatabaseRowStatus } from 'michi-shared';
import { isTaskDb } from 'michi-shared';
import { ThreadStateDot } from '../../ThreadStateDot';
import { formatMichiAge } from '../../michiFormat';
import { michiOneLine, michiSameText } from '../../michiPlainText';
import { threadItemProps, type ThreadItemHandlers } from '../../threads/threadItem';
import { AppTag } from '../CellView';
import { composing } from '../CellEditor';
import { applyView, cellEditable, cellOf, isDateValue, isThreadsDb, shownColumns, startValues, titleColumn, type CellValue, type DbGroup } from '../dbModel';
import { groupName, optionName, viewName } from '../dbLabels';
import { linkedConversationWaits, useLiveThreads } from '../liveThreads';
import { addRowOp, boardColumnTakes, boardDropOps, boardDropRefusal, boardKeyValue, boardReorderOps, cellEditLabel, rowMoveBackOp } from '../dbOps';
import { TaskCardBody, taskCardDescribedBy } from './TaskCard';
import { GroupHeading, groupSums, RowFacts, rowTitle, useReportDrawn } from './RowBits';
import type { DbViewProps } from './viewTypes';
import { EASE, SPRING } from '../../../../../motion/tokens';

/** Cards drawn per column before "N more" (Michi pages a column past 200). */
export const BOARD_PAGE = 200;

// As dragging page blocks feels: under 6px a press is a click, which opens the
// card. Space picks a card up, so Enter still opens it; Space or Enter puts it
// down and Esc puts it back.
const POINTER = { activationConstraint: { distance: 6 } };
const KEYBOARD = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space, KeyboardCode.Enter] },
};
const INSTRUCTIONS = {
  draggable: 'Press Space to pick up this card, the arrow keys to move it to another column or place, Space again to drop it, and Esc to cancel. Press Enter to open it.',
};

const CARRIED_KEYS = new Set(['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const slot = (key: string | null) => key ?? '\u0000';
// A column and a card are told apart by their ids' first word, whatever the values.
const columnId = (key: string | null) => `column:${slot(key)}`;
/**
 * A card keeps its id from column to column when every row is drawn once, so
 * the drop settles the carried card where it went. A row with several values
 * (a multi-select, or a list a column kept when it became a select) is drawn
 * in each of its columns: there the id names the column too.
 */
const cardId = (key: string | null, rowId: string, once: boolean) => (once ? `card:\n${rowId}` : `card:${slot(key)}\n${rowId}`);
/** Whether no row is in more than one group. */
export function eachRowOnce(groups: readonly Pick<DbGroup, 'rows'>[]): boolean {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
    }
  }
  return true;
}
/** Cards in a column that keeps its own order (All threads, a sorted view) make no room for a dragged one. */
const still: SortingStrategy = () => null;

/** The carried card settling into its place: as a sheet put down, not a spring. */
const DROP = { duration: 180, easing: `cubic-bezier(${EASE.drawer.join(',')})` };
/** Cards that change column travel there; the rest of each column closes up or makes room. */
const CARD_MOTION = { layout: SPRING.soft };
/** A card travelling to another column passes over the ones it leaves. */
const LIFT: CSSProperties = { position: 'relative', zIndex: 1 };
/** While a card is carried dnd-kit moves the slots; the cards inside do not measure themselves. */
const CARRYING = 'carrying';
/**
 * The cards measure only for their own moves: no layout group, so neither a
 * group around the board nor every card on it measures when one card leaves.
 */
const NO_LAYOUT_GROUP = {};
const NO_LANDINGS: ReadonlyMap<string, BoardLanding> = new Map();
/** A move Michi refused this soon was never seen where it went: the card is simply back, not travelling back. */
const UNSEEN_MS = 100;

/**
 * A card put down on the board: drawn where it went until Michi has the edit.
 * In another column `row` carries its new value; in its own `order` is the
 * column's cards as drawn after the move. `at` is when it was put down.
 */
export type BoardLanding = { row: MichiDbRow; from: string | null; to: string | null; order?: readonly string[]; at?: number };

const inGroup = (groups: readonly Pick<DbGroup, 'key' | 'rows'>[], key: string | null, rowId: string) =>
  groups.find((g) => g.key === key)?.rows.some((row) => row.id === rowId) ?? false;

/**
 * Whether a card put down still describes the board: Michi has it where it came
 * from, or already where it went (in its own column, still there). Moved
 * elsewhere meanwhile, the card is drawn where Michi has it.
 */
export function landingHolds(groups: readonly Pick<DbGroup, 'key' | 'rows'>[], landing: BoardLanding): boolean {
  const id = landing.row.id;
  return landing.order ? inGroup(groups, landing.to, id) : inGroup(groups, landing.from, id) || inGroup(groups, landing.to, id);
}

/** How many cards each group gains or loses while cards put down are drawn where they went. */
export function landingCounts(groups: readonly Pick<DbGroup, 'key' | 'rows'>[], landings: readonly BoardLanding[]): number[] {
  return groups.map((g) => landings.reduce((n, l) => {
    if (l.order || l.from === l.to) return n;
    const here = g.rows.some((row) => row.id === l.row.id);
    return n + (g.key === l.to && !here ? 1 : 0) - (g.key === l.from && here ? 1 : 0);
  }, 0));
}

/** The cards in a column after a card is put down at `overId` in it (the last drawn without one); null when it does not move. */
export function boardLandingOrder(list: readonly string[], rowId: string, overId: string | undefined): string[] | null {
  const from = list.indexOf(rowId);
  const to = overId === undefined ? list.length - 1 : list.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = list.filter((id) => id !== rowId);
  next.splice(to, 0, rowId);
  return next;
}

/**
 * The board's columns with a card that was just put down drawn where it went.
 * A card moved into another column goes where the view orders it (its sorts,
 * else the database's order: `sortRows`) among that column's cards; past the
 * cards a column draws (`limits`) it is one of the "N more", and in among them
 * it pushes the last one there. Once Michi draws it there itself nothing changes.
 */
export function landCard(
  groups: readonly Pick<DbGroup, 'key' | 'rows'>[],
  columns: readonly MichiDbRow[][],
  landing: BoardLanding,
  sortRows: (rows: MichiDbRow[]) => readonly MichiDbRow[],
  limits: readonly number[],
): MichiDbRow[][] {
  const id = landing.row.id;
  return columns.map((rows, i) => {
    const key = groups[i]?.key ?? null;
    if (landing.order) {
      if (key !== landing.to) return rows;
      const byId = new Map(rows.map((row) => [row.id, row] as const));
      const next = landing.order.flatMap((rowId) => byId.get(rowId) ?? []);
      return next.length === rows.length ? next : rows;
    }
    if (key === landing.from && key !== landing.to) return rows.some((row) => row.id === id) ? rows.filter((row) => row.id !== id) : rows;
    if (key !== landing.to || rows.some((row) => row.id === id)) return rows;
    const all = groups[i]?.rows ?? rows;
    const rank = new Map(sortRows([...all.filter((row) => row.id !== id), landing.row]).map((row, j) => [row.id, j] as const));
    const at = rank.get(id) ?? Number.MAX_SAFE_INTEGER;
    const found = rows.findIndex((row) => (rank.get(row.id) ?? Number.MAX_SAFE_INTEGER) > at);
    const before = found < 0 ? rows.length : found;
    const limit = limits[i] ?? Number.MAX_SAFE_INTEGER;
    if (before >= limit) return rows;
    const next = rows.slice();
    next.splice(before, 0, landing.row);
    return next.length > limit ? next.slice(0, limit) : next;
  });
}

type CardData = { row: string; column: string | null };
const dataOf = (x: Active | Over | null | undefined) => x?.data.current as Partial<CardData> | undefined;
/** The column a card or a column stands for; undefined off the board. */
const columnOf = (x: Active | Over | null | undefined): { column: string | null } | undefined => {
  const data = dataOf(x);
  return data && 'column' in data ? { column: data.column ?? null } : undefined;
};

/** The cards drawn in a column, in order. */
const cardsIn = (root: ParentNode | null, column: string | null) =>
  [...(root?.querySelectorAll<HTMLElement>('.michi-card') ?? [])].filter((el) => el.dataset.column === (column ?? ''));

/** The card for a row in a column, where a keyboard move left it; null when it is not drawn. */
export function findBoardCard(root: ParentNode | null, column: string | null, row: string): HTMLElement | null {
  return cardsIn(root, column).find((el) => el.dataset.threadId === row) ?? null;
}

/**
 * Whether a card let go over a column but not over a card was dropped below the
 * column's last card, where the pointer is, not where the carried card's top
 * is: a card grabbed low would otherwise need the whole ghost to clear the
 * last card, which the space under a column rarely allows.
 */
export function droppedBelow(
  lastBottom: number,
  activator: Event | null | undefined,
  rect: { initial: { top: number } | null; translated: { top: number; height: number } | null },
): boolean {
  const { initial, translated } = rect;
  const clientY = (activator as Partial<PointerEvent> | null | undefined)?.clientY;
  const y = typeof clientY === 'number' && initial && translated
    ? clientY + translated.top - initial.top
    : translated ? translated.top + translated.height / 2 : undefined;
  return y !== undefined && y >= lastBottom;
}

/** Over a card, that card; otherwise the column under the pointer, or for the keyboard whichever is nearest. */
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return closestCorners(args);
  const cards = hits.filter((hit) => (hit.data?.droppableContainer as { data?: { current?: Partial<CardData> } } | undefined)?.data?.current?.row !== undefined);
  return cards.length ? cards : hits;
};

/**
 * The board: a column per value of the grouping column, empty ones kept to
 * drop into. Dragging a card (pointer or keyboard) to another column sets
 * that value; inside its column it puts the card in order, unless the view
 * sorts its rows. On All threads only In progress and Done take a card. A
 * column's + adds a card there, except on All tasks, which also keeps the order
 * its cards have on their workspace's own board.
 */
export function BoardView({ db, view, config, groups, groupColumn: by, prefs, edit, handlers, threadOf, now, notice, onDrawn }: DbViewProps) {
  const [shown, setShown] = useState<Record<string, number>>({});
  const limits = useMemo(() => groups.map((g) => shown[slot(g.key)] ?? BOARD_PAGE), [groups, shown]);
  const drawn = useMemo(() => groups.map((g, i) => g.rows.slice(0, limits[i])), [groups, limits]);
  // Another view or grouping is another board: nothing put down, arriving or travelling carries over to it.
  const scope = `${view.id}\n${by?.id ?? ''}`;
  // Cards put down are drawn where they went at once, each until its own edit settles, so a drop settles
  // there rather than back where it came from.
  const [landed, setLanded] = useState<{ scope: string; byRow: ReadonlyMap<string, BoardLanding> }>(() => ({ scope, byRow: new Map() }));
  const pending = landed.scope === scope ? landed.byRow : NO_LANDINGS;
  // Only while Michi has not moved the card elsewhere meanwhile. Put in order where it was just moved to, it is there.
  const live = useMemo(() => {
    const all = [...pending.values()];
    const moved = (l: BoardLanding) => all.some((m) => !m.order && m.row.id === l.row.id && m.to === l.to && landingHolds(groups, m));
    return all.filter((l) => landingHolds(groups, l) || (!!l.order && moved(l)));
  }, [pending, groups]);
  useEffect(() => {
    if (live.length === pending.size) return;
    const kept = new Set(live);
    setLanded((s) => (s.scope !== scope ? s : { scope, byRow: new Map([...s.byRow].filter(([id, l]) => kept.has(l) || pending.get(id) !== l)) }));
  }, [live, pending, scope]);
  const sortRows = useCallback(
    (rows: MichiDbRow[]) => applyView({ id: db.id, kind: db.kind, columns: db.columns, rows }, { filters: [], match: 'all', sorts: config.sorts })[0]?.rows ?? rows,
    [db.id, db.kind, db.columns, config.sorts],
  );
  const columns = useMemo(() => live.reduce<MichiDbRow[][]>((cols, l) => landCard(groups, cols, l, sortRows, limits), drawn), [drawn, groups, limits, live, sortRows]);
  const counts = useMemo(() => (live.length ? landingCounts(groups, live) : null), [groups, live]);
  const movedTo = useMemo(() => new Map(live.filter((l) => !l.order).map((l) => [l.row.id, l.to] as const)), [live]);
  useReportDrawn(onDrawn, columns);
  // Every row in one column: its card keeps its sortable and layout ids from column to column.
  const once = useMemo(() => eachRowOnce(groups), [groups]);
  const boardLayout = useId();
  // The OS setting or the in-app Reduce motion (MotionRoot's MotionConfig): the carried card is simply put down.
  const reduced = useReducedMotionConfig() === true;
  // A card dragged to another column is drawn anew there under the carried card: a new layout id keeps it from also travelling.
  const flights = useRef(new Map<string, number>());
  const flyAnew = (rowId: string) => { flights.current.set(rowId, (flights.current.get(rowId) ?? 0) + 1); };
  const layoutIdOf = (rowId: string) => `${boardLayout}\n${scope}\n${rowId}~${flights.current.get(rowId) ?? 0}`;
  // Where each card was drawn after the last commit, and whether only because it was put down there.
  // A card now drawn in another column arrived there; one drawn back from where it was put down did not.
  const placed = useRef<{ scope: string; at: Map<string, { key: string | null; landed: boolean }> }>({ scope, at: new Map() });
  const arrivals = useMemo(() => {
    const was = placed.current;
    const into = new Map<string, string[]>();
    if (!once || was.scope !== scope || !was.at.size) return into;
    columns.forEach((rows, i) => {
      const key = groups[i]?.key ?? null;
      for (const row of rows) {
        const prev = was.at.get(row.id);
        if (!prev || prev.key === key || (prev.landed && movedTo.get(row.id) !== key)) continue;
        into.set(slot(key), [...(into.get(slot(key)) ?? []), row.id]);
      }
    });
    return into;
  }, [columns, groups, movedTo, once, scope]);
  useLayoutEffect(() => {
    const at = new Map<string, { key: string | null; landed: boolean }>();
    columns.forEach((rows, i) => {
      const key = groups[i]?.key ?? null;
      for (const row of rows) at.set(row.id, { key, landed: movedTo.has(row.id) && movedTo.get(row.id) === key });
    });
    placed.current = { scope, at };
  }, [columns, groups, movedTo, scope]);
  const title = titleColumn(db);
  const tasks = isTaskDb(db);
  // A card shows the view's columns except its title and the grouping; All threads' cards keep to the short facts.
  const facts = useMemo(
    () => (isThreadsDb(db) || tasks ? [] : shownColumns(db, config).filter((c) => c.id !== title?.id && c.id !== by?.id)),
    [db, config, title, by, tasks],
  );
  // A thread is a conversation, not a line to put in order; a sorted view orders its cards itself; All tasks keeps each workspace's order.
  const reorder = !isThreadsDb(db) && !db.merged && !config.sorts.some((s) => db.columns.some((c) => c.id === s.column));
  const movable = reorder || (!!by && cellEditable(by));
  const [drag, setDrag] = useState<{ row: MichiDbRow; from: string | null; over?: { column: string | null } } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // A card moved to another column by keyboard is drawn anew under that column; focus follows it.
  const refocus = useRef<{ row: string; column: string | null } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want) return;
    const el = findBoardCard(boardRef.current, want.column, want.row);
    if (!el) return;
    refocus.current = null;
    el.focus();
  }, [columns]);
  const sensors = useSensors(useSensor(PointerSensor, POINTER), useSensor(KeyboardSensor, KEYBOARD));
  // Each column's sortable ids stay one array while they are the same ids, so its cards are not all drawn again.
  const sortRef = useRef(new Map<string, string[]>());
  const sortIds = useMemo(() => groups.map((g, i) => {
    const ids = columns[i].map((row) => cardId(g.key, row.id, once));
    const was = sortRef.current.get(slot(g.key));
    if (was && was.length === ids.length && was.every((id, j) => id === ids[j])) return was;
    sortRef.current.set(slot(g.key), ids);
    return ids;
  }), [groups, columns, once]);

  /** Draws a card where it was put down until its edit settles; a refused edit puts it back, focus with it. */
  const land = (to: BoardLanding, result: Promise<boolean>, keyboard = false) => {
    const id = to.row.id;
    // A card's move and its place in a column are kept apart: put in order just after it was moved, both are drawn.
    const key = `${id}\n${to.order ? 'order' : 'move'}`;
    setLanded((s) => ({ scope, byRow: new Map(s.scope === scope ? s.byRow : []).set(key, to) }));
    const done = (ok: boolean) => {
      if (!ok && to.from !== to.to) {
        if (keyboard) refocus.current = { row: id, column: to.from };
        // Refused before it could be seen where it went: simply back, not travelling back.
        if (once && performance.now() - (to.at ?? 0) < UNSEEN_MS) flyAnew(id);
      }
      setLanded((s) => {
        if (s.byRow.get(key) !== to) return s;
        const byRow = new Map(s.byRow);
        byRow.delete(key);
        return { scope: s.scope, byRow };
      });
    };
    void result.then(done, () => done(false));
  };

  const label = useCallback((key: string | null) => {
    const group = groups.find((g) => g.key === key);
    return groupName(db, by, key, group?.label ?? key ?? '') || 'All rows';
  }, [db, by, groups]);

  const drop = ({ active, over, activatorEvent }: DragEndEvent) => {
    const d = drag;
    setDrag(null);
    const to = columnOf(over);
    if (!d || !to) return;
    if (to.column !== d.from) {
      if (!by) return;
      const check = boardDropOps(db, by, d.row, d.from, to.column);
      if (!check.ok) {
        notice(check.reason);
        return;
      }
      if (activatorEvent instanceof KeyboardEvent) refocus.current = { row: d.row.id, column: to.column };
      if (check.ops.length) {
        const values = check.ops.reduce<MichiDbRow['values']>((all, op) => (op.op === 'row.update' && op.id === d.row.id ? { ...all, ...op.values } : all), d.row.values);
        if (once) flyAnew(d.row.id);
        const at = performance.now();
        land({ row: { ...d.row, values }, from: d.from, to: to.column, at }, edit(check.ops, cellEditLabel(db, by, to.column), { undo: true }), activatorEvent instanceof KeyboardEvent);
      } else refocus.current = null;
      return;
    }
    if (!reorder) return;
    // Among the cards drawn: let go below them, a card goes after the last one drawn, not to the far end out of sight.
    const list = columns[groups.findIndex((g) => g.key === to.column)]?.map((row) => row.id) ?? [];
    const overRow = dataOf(over)?.row;
    if (overRow === undefined) {
      // On the column but not on a card (its heading, say): only below the cards does it mean "last".
      const last = cardsIn(boardRef.current, to.column).pop();
      if (!last || !droppedBelow(last.getBoundingClientRect().bottom, activatorEvent, active.rect.current)) return;
    }
    const ops = boardReorderOps(db, list, d.row.id, overRow);
    const order = boardLandingOrder(list, d.row.id, overRow);
    if (!ops.length) return;
    const moved = edit(ops, 'Moved a card', { undo: true, undoOps: [rowMoveBackOp(db, d.row.id)] });
    if (order) land({ row: d.row, from: to.column, to: to.column, order }, moved);
    else void moved;
  };

  const add = (key: string | null, text: string) => {
    if (!title) return;
    const values: Record<string, CellValue> = { ...startValues(db, config) };
    if (by) {
      if (key === null) delete values[by.id];
      else values[by.id] = boardKeyValue(by, key);
    }
    values[title.id] = text;
    void edit([addRowOp(values).op], tasks ? 'Added a task' : 'Added a row');
  };

  const accessibility = useMemo(() => {
    const name = (active: Active) => {
      const id = dataOf(active)?.row;
      const row = db.rows.find((r) => r.id === id);
      return row ? rowTitle(db, row) : 'this card';
    };
    const where = (active: Active, over: Over | null) => {
      const to = columnOf(over);
      if (!to) return null;
      const from = columnOf(active)?.column ?? null;
      return { name: label(to.column), no: to.column === from ? null : boardDropRefusal(db, by, to.column) };
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => `Picked up “${name(active)}”`,
      onDragOver: ({ active, over }) => {
        const w = where(active, over);
        return !w ? 'It can’t go here' : w.no ? `It can’t go into “${w.name}”: ${w.no}` : `Over “${w.name}”`;
      },
      onDragEnd: ({ active, over }) => {
        const w = where(active, over);
        return !w ? 'Put back where it was' : w.no ? `Not put into “${w.name}”: ${w.no}` : `Put into “${w.name}”`;
      },
      onDragCancel: () => 'Not moved. Put back where it was',
    };
    return { announcements, screenReaderInstructions: INSTRUCTIONS };
  }, [db, by, label]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      accessibility={accessibility}
      onDragStart={({ active }) => {
        refocus.current = null;
        const data = dataOf(active);
        const row = data?.row === undefined ? undefined : db.rows.find((r) => r.id === data.row);
        setDrag(row ? { row, from: data?.column ?? null } : null);
      }}
      onDragOver={({ over }) => setDrag((d) => (d ? { ...d, over: columnOf(over) } : d))}
      onDragEnd={drop}
      onDragCancel={() => setDrag(null)}
    >
      {/* Layout ids carry this board's id and view; another board on screen, or a layout group around this one, is not involved. */}
      <LayoutGroupContext.Provider value={NO_LAYOUT_GROUP}>
        {/* Another view or grouping draws its cards afresh, settled. */}
        <div key={scope} ref={boardRef} className="michi-db-board" role="region" aria-label={viewName(db, view)}>
          {groups.map((g, i) => {
            const here = !!drag?.over && drag.over.column === g.key && drag.from !== g.key;
            const refused = here ? boardDropRefusal(db, by, g.key) : null;
            // Grouped by its own title column, a new card could not land in the column it was added to.
            const addable = !!title && !isThreadsDb(db) && !db.merged && (!by || (by.id !== title.id && boardColumnTakes(db, by, g.key)));
            // A card just put down counts in its new column at once.
            const count = g.count + (counts?.[i] ?? 0);
            const group = count === g.count ? g : { ...g, count };
            const arrived = arrivals.get(slot(g.key));
            return (
              <BoardColumn
                key={slot(g.key)}
                columnKey={g.key}
                name={label(g.key)}
                head={<GroupHeading db={db} column={by} group={group} showCount={prefs.showCounts} sums={groupSums(db, g, db.columns, prefs.sums)} roll cheer={arrived?.join(' ')} />}
                over={here && !refused}
                refused={refused}
                rest={g.rows.length + (counts?.[i] ?? 0) - columns[i].length}
                onMore={() => setShown((s) => ({ ...s, [slot(g.key)]: (s[slot(g.key)] ?? BOARD_PAGE) + BOARD_PAGE }))}
                addLabel={addable ? (tasks ? 'New task' : 'New') : undefined}
                onAdd={(text) => add(g.key, text)}
              >
                <SortableContext items={sortIds[i]} strategy={reorder ? verticalListSortingStrategy : still}>
                  {columns[i].map((row, j) => (
                    <BoardCard
                      key={row.id}
                      db={db}
                      row={row}
                      column={g.key}
                      sortId={sortIds[i][j]}
                      layoutId={once ? layoutIdOf(row.id) : undefined}
                      layoutKey={drag ? CARRYING : sortIds[i]}
                      lift={!!arrived?.includes(row.id) && !movedTo.has(row.id)}
                      facts={facts}
                      thread={threadOf(row.id)}
                      now={now}
                      handlers={handlers}
                      movable={movable}
                    />
                  ))}
                </SortableContext>
              </BoardColumn>
            );
          })}
        </div>
      </LayoutGroupContext.Provider>
      <DragOverlay dropAnimation={reduced ? null : DROP}>
        {drag && (
          <div className="michi-card michi-db-ghost" aria-hidden="true">
            <span className="michi-card__title"><span>{rowTitle(db, drag.row)}</span></span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/** One column: its heading, its cards (a page at a time), a drop target even when empty, and its + at the foot. While a card it will not take is over it, it says why. */
function BoardColumn({ columnKey, name, head, over, refused, rest, onMore, addLabel, onAdd, children }: {
  columnKey: string | null;
  name: string;
  head: React.ReactNode;
  over: boolean;
  refused: string | null;
  rest: number;
  onMore: () => void;
  /** Set: the column takes a new card; its button and field name the column. */
  addLabel?: string;
  onAdd: (text: string) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: columnId(columnKey), data: { column: columnKey } });
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const addName = addLabel ? `${addLabel} in ${name}` : '';
  return (
    <section
      ref={setNodeRef}
      className="michi-db-col"
      aria-label={name}
      data-column={columnKey ?? ''}
      data-over={over ? 'true' : undefined}
      data-refused={refused ? 'true' : undefined}
    >
      <header className="michi-db-col__head">{head}</header>
      {children}
      {over && <div className="michi-db-col__drop" aria-hidden="true" />}
      {refused && <p className="michi-db-col__note">{refused}</p>}
      {rest > 0 && <button type="button" className="michi-board__more" onClick={onMore}>{rest} more</button>}
      {addLabel && (adding ? (
        <NewCardField label={addName} onDone={(text, refocus) => { setAdding(false); if (refocus) requestAnimationFrame(() => addRef.current?.focus()); if (text) onAdd(text); }} />
      ) : (
        <button ref={addRef} type="button" className="michi-db-col__add" aria-label={addName} onClick={() => setAdding(true)}>
          <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
          {addLabel}
        </button>
      ))}
    </section>
  );
}

/** A new card's title, typed at the foot of its column: Enter adds it, Esc gives up, leaving the field adds what was typed. */
function NewCardField({ label, onDone }: { label: string; onDone: (text: string | null, refocus: boolean) => void }) {
  const [text, setText] = useState('');
  const done = useRef(false);
  // Enter and Esc hand focus back to the column's + button; leaving by blur keeps focus where it went.
  const finish = (save: boolean, refocus = false) => {
    if (done.current) return;
    done.current = true;
    onDone(save && text.trim() ? text.trim() : null, refocus);
  };
  return (
    <input
      autoFocus
      className="michi-db-input michi-db-col__new"
      aria-label={label}
      placeholder="Name it, then press Enter"
      maxLength={2000}
      value={text}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        // The page's keys (Esc leaving it, ↑/↓ moving the peek) stay out of the field.
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false, true);
        } else if (event.key === 'Enter' && !composing(event)) {
          event.preventDefault();
          finish(true, true);
        }
      }}
    />
  );
}

const CardBody = memo(function CardBody({ db, row, facts, now, agentDone, titleId }: {
  db: MichiDatabase;
  row: MichiDbRow;
  facts: MichiDbColumn[];
  now: number;
  agentDone: boolean;
  titleId: string;
}) {
  const threads = isThreadsDb(db);
  const next = threads ? michiOneLine(String(cellOf(row, 'next') ?? '')) : '';
  const stoppedAt = threads ? michiOneLine(String(cellOf(row, 'stoppedAt') ?? '')) : '';
  const line = next ? `Next: ${next}` : michiSameText(stoppedAt, rowTitle(db, row)) ? '' : stoppedAt;
  const projectCol = threads ? db.columns.find((c) => c.id === 'project') : undefined;
  const projectId = cellOf(row, 'project');
  const project = projectCol && typeof projectId === 'string' && projectId ? optionName(db, projectCol, projectId) : '';
  const app = threads ? cellOf(row, 'app') : null;
  const last = threads ? cellOf(row, 'lastActivity') : null;
  const lastAt = isDateValue(last) ? Date.parse(last.start) : NaN;
  return (
    <>
      <span className="michi-card__title">
        {agentDone && <ThreadStateDot state="done" doneBy="agent" size={9} />}
        <span id={titleId}>{rowTitle(db, row)}</span>
      </span>
      {agentDone && <span className="michi-card__agent">Agent says done</span>}
      {threads && line && <span className="michi-card__next">{line}</span>}
      {threads ? (
        <span className="michi-card__foot">
          <span className="michi-card__project">{project}</span>
          {typeof app === 'string' && app && <AppTag name={app} />}
          <span className="michi-threads__mono">{Number.isNaN(lastAt) ? '' : formatMichiAge(lastAt, now)}</span>
        </span>
      ) : (
        <RowFacts db={db} row={row} columns={facts} now={now} />
      )}
    </>
  );
});

/**
 * A card that can be carried. Its wrapper is what dnd-kit moves; the card is
 * what the keyboard picks up, so Space on a button inside stays that button's.
 * The card inside is motion's: one that changes column (marked done in its
 * details, or by an agent) travels there, and its neighbours close up.
 */
const BoardCard = memo(function BoardCard({ db, row, column, sortId, layoutId, layoutKey, lift, facts, thread, now, handlers, movable }: {
  db: MichiDatabase;
  row: MichiDbRow;
  column: string | null;
  sortId: string;
  /** Shared by the card's place in the column it leaves and the one it arrives in; none when a row is drawn in several columns. */
  layoutId?: string;
  /** Changes when the board's cards may have moved; constant while one is carried. */
  layoutKey: unknown;
  /** Arriving from another column: drawn above the cards it passes. */
  lift: boolean;
  facts: MichiDbColumn[];
  thread?: DatabaseRowStatus;
  now: number;
  handlers: ThreadItemHandlers;
  movable: boolean;
}) {
  const sortable = useSortable({
    id: sortId,
    data: { row: row.id, column } satisfies CardData,
    disabled: !movable,
    attributes: { roleDescription: 'draggable card' },
  });
  // Lifted for the trip only; a trip that never starts (reduced motion) drops it soon after.
  const [lifted, setLifted] = useState(lift);
  useEffect(() => {
    if (!lifted) return undefined;
    const timer = window.setTimeout(() => setLifted(false), 600);
    return () => window.clearTimeout(timer);
  }, [lifted]);
  const item = threadItemProps(row.id, handlers, 'button');
  const titleId = useId();
  const agentDone = isThreadsDb(db) && cellOf(row, 'state') === 'done' && thread?.doneBy === 'agent';
  const live = useLiveThreads();
  const tasks = isTaskDb(db);
  const attention = tasks && linkedConversationWaits(row, live);
  const style: CSSProperties = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className="michi-db-slot"
      data-movable={movable ? 'true' : undefined}
      data-dragging={sortable.isDragging ? 'true' : undefined}
      // While carried, Enter and Esc put the card down or back and the arrows move it; nothing else on the page (the peek's ↑/↓) takes them as well.
      onKeyDownCapture={(event) => { if (sortable.isDragging && CARRIED_KEYS.has(event.key)) event.preventDefault(); }}
      {...(movable && sortable.listeners ? sortable.listeners : {})}
    >
      <motion.div
        ref={sortable.setActivatorNodeRef}
        layout="position"
        layoutId={layoutId}
        layoutDependency={layoutKey}
        transition={CARD_MOTION}
        style={lifted ? LIFT : undefined}
        onLayoutAnimationComplete={lifted ? () => setLifted(false) : undefined}
        className="michi-card michi-item"
        data-column={column ?? ''}
        data-agent-done={agentDone ? 'true' : undefined}
        data-attention={attention ? 'true' : undefined}
        {...item}
        aria-labelledby={titleId}
        aria-roledescription={movable ? sortable.attributes['aria-roledescription'] : undefined}
        aria-describedby={[movable ? sortable.attributes['aria-describedby'] : undefined, ...(tasks ? taskCardDescribedBy(titleId) : [])].filter(Boolean).join(' ') || undefined}
        onKeyDown={(event) => {
          // While carried the keys are the drag's; on a card that moves, Space picks it up rather than selecting it.
          if (sortable.isDragging || (movable && event.key === ' ')) return;
          item.onKeyDown(event);
        }}
      >
        {tasks
          ? <TaskCardBody db={db} row={row} now={now} attention={attention} titleId={titleId} />
          : <CardBody db={db} row={row} facts={facts} now={now} agentDone={agentDone} titleId={titleId} />}
      </motion.div>
    </div>
  );
});
