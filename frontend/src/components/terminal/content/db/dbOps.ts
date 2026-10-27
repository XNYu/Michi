import type {
  MichiContextItem,
  MichiDatabase,
  MichiDbColumn,
  MichiDbColumnType,
  MichiDbEditOp,
  MichiDbRow,
  MichiDbView,
  MichiDbViewConfig,
  MichiDbViewType,
} from 'michi-shared';
import { MICHI_DB_LIMITS } from 'michi-shared';
import {
  byPosition,
  cellEditable,
  cellOf,
  cellText,
  convertValue,
  dayOf,
  emptyConfig,
  isDateValue,
  isThreadState,
  isThreadsDb,
  newDbId,
  OPS_FOR,
  sameValue,
  shownColumns,
  timeOf,
  titleColumn,
  writableOptions,
  type CellValue,
} from './dbModel';
import { columnName, COLUMN_TYPE_LABEL, optionName, VIEW_TYPE_LABEL, viewName } from './dbLabels';

// Every change the database UI makes, as the ops Michi's edit endpoint takes.
// Pure, so each is tested on its own; the views only call these.

export const AUTO_STATE = 'Michi works out this status from the conversation';

const utf8 = new TextEncoder();

/**
 * An edit cut, in order, into parts one request can carry: at most Michi's
 * ops per edit and Michi's byte cap each (counted as the JSON the proxy
 * measures). One op over the cap goes alone, for Michi's proxy to refuse.
 */
export function chunkEditOps(ops: readonly MichiDbEditOp[], maxOps: number = MICHI_DB_LIMITS.editOps, maxBytes: number = MICHI_DB_LIMITS.editBytes): MichiDbEditOp[][] {
  const parts: MichiDbEditOp[][] = [];
  let part: MichiDbEditOp[] = [];
  let bytes = 2;
  for (const op of ops) {
    const size = utf8.encode(JSON.stringify(op)).length + 1;
    if (part.length && (part.length >= maxOps || bytes + size > maxBytes)) {
      parts.push(part);
      part = [];
      bytes = 2;
    }
    part.push(op);
    bytes += size;
  }
  if (part.length) parts.push(part);
  return parts;
}

export const viewSave = (view: MichiDbView, config: MichiDbViewConfig): MichiDbEditOp => ({
  op: 'view.save',
  view: { id: view.id, name: view.name, type: view.type, config },
});

/** `Board`, then `Board 2`…: a name the views do not have yet. */
export function freeViewName(db: MichiDatabase, base: string): string {
  const taken = new Set(db.views.map((v) => viewName(db, v)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** All threads switched to a board splits by status and a date view by last activity, as its own views do. */
export function configForType(db: MichiDatabase, type: MichiDbViewType, config: MichiDbViewConfig): MichiDbViewConfig {
  if (!isThreadsDb(db)) return config;
  if (type === 'board' && config.group === undefined) return { ...config, group: 'state' };
  if ((type === 'timeline' || type === 'calendar') && config.date === undefined) return { ...config, date: 'lastActivity' };
  return config;
}

export function addViewOp(db: MichiDatabase, type: MichiDbViewType): { id: string; op: MichiDbEditOp } {
  const id = newDbId('v');
  const base = isThreadsDb(db) ? { ...emptyConfig(), sorts: [{ column: 'lastActivity', dir: 'desc' as const }] } : emptyConfig();
  return { id, op: { op: 'view.save', view: { id, name: freeViewName(db, VIEW_TYPE_LABEL[type]), type, config: configForType(db, type, base) } } };
}

export function duplicateViewOp(db: MichiDatabase, view: MichiDbView): { id: string; op: MichiDbEditOp } {
  const id = newDbId('v');
  return { id, op: { op: 'view.save', view: { id, name: freeViewName(db, `${viewName(db, view)} copy`), type: view.type, config: view.config } } };
}

export const renameViewOp = (view: MichiDbView, name: string): MichiDbEditOp => ({
  op: 'view.save',
  view: { id: view.id, name, type: view.type, config: view.config },
});

// ── Cells ────────────────────────────────────────────────────────────

/** The undo toast's words for a cell change: a thread's status says what it became. */
export function cellEditLabel(db: MichiDatabase, column: MichiDbColumn, value: CellValue): string {
  if (isThreadState(db, column)) return value === 'done' ? 'Marked done' : value === 'doing' ? 'Marked in progress' : 'Changed Status';
  return `Changed ${columnName(db, column)}`;
}

export type EditCheck = { ok: true; ops: MichiDbEditOp[] } | { ok: false; reason: string };

/**
 * One cell set to `value`. `extra` go first (a new option has to exist before
 * a cell can hold it). Refused for cells that cannot change: built-in thread
 * columns other than title, status and next, an empty title, and any status
 * but In progress / Done.
 */
export function cellEditOps(db: MichiDatabase, row: MichiDbRow, column: MichiDbColumn, value: CellValue, extra: MichiDbEditOp[] = []): EditCheck {
  if (!cellEditable(column)) return { ok: false, reason: `${columnName(db, column)} can't be changed` };
  const allowed = writableOptions(db, column);
  if (allowed && (typeof value !== 'string' || !allowed.has(value))) return { ok: false, reason: AUTO_STATE };
  if (isThreadsDb(db) && column.builtin && column.id === 'title' && (value === null || (typeof value === 'string' && !value.trim()))) {
    return { ok: false, reason: 'A thread needs a title' };
  }
  if (!extra.length && sameValue(cellOf(row, column.id), value)) return { ok: true, ops: [] };
  return { ok: true, ops: [...extra, { op: 'row.update', id: row.id, values: { [column.id]: value } }] };
}

/** A row's body (Markdown), saved when it changed. */
export function bodyEditOps(row: MichiDbRow, body: string): MichiDbEditOp[] {
  return (row.body ?? '') === body ? [] : [{ op: 'row.update', id: row.id, body }];
}

/** Every picked row given one value, in one edit (one receipt undoes it, up to the rows one request carries). */
export function setColumnOps(db: MichiDatabase, rows: readonly MichiDbRow[], column: MichiDbColumn, value: CellValue): EditCheck {
  if (!cellEditable(column)) return { ok: false, reason: `${columnName(db, column)} can't be changed` };
  const allowed = writableOptions(db, column);
  if (allowed && (typeof value !== 'string' || !allowed.has(value))) return { ok: false, reason: AUTO_STATE };
  const converted = convertValue(value, column.type, column.options);
  if (!converted.ok) return { ok: false, reason: `That doesn't fit ${columnName(db, column)}` };
  return { ok: true, ops: rows.map((r) => ({ op: 'row.update', id: r.id, values: { [column.id]: converted.value } })) };
}

export const deleteRowsOps = (rows: readonly Pick<MichiDbRow, 'id'>[]): MichiDbEditOp[] => rows.map((r) => ({ op: 'row.delete', id: r.id }));

/** A new row meeting the view's simple conditions, under an id made here. */
export function addRowOp(values: Record<string, CellValue>): { id: string; op: MichiDbEditOp } {
  const id = newDbId('r');
  return { id, op: { op: 'row.add', id, values } };
}

// ── Board ────────────────────────────────────────────────────────────

/** Why a board column will not take a card, or null when it will. On All threads only In progress and Done take one. */
export function boardDropRefusal(db: MichiDatabase, by: MichiDbColumn | undefined, to: string | null): string | null {
  if (!by) return null;
  if (!cellEditable(by)) return `${columnName(db, by)} can't be changed`;
  if (isThreadState(db, by) && (to === null || !writableOptions(db, by)!.has(to))) return AUTO_STATE;
  return null;
}

/**
 * A card dropped on another board column: that column's value. For a
 * multi-select the target option replaces the one it came from.
 */
export function boardDropOps(db: MichiDatabase, by: MichiDbColumn | undefined, row: MichiDbRow, from: string | null, to: string | null): EditCheck {
  if (!by || from === to) return { ok: true, ops: [] };
  const refused = boardDropRefusal(db, by, to);
  if (refused) return { ok: false, reason: refused };
  let value: CellValue;
  if (by.type === 'checkbox') value = to === 'true';
  else if (by.type !== 'multi') value = to;
  else {
    const now = cellOf(row, by.id);
    const list = Array.isArray(now) ? now : [];
    const next = [...list.filter((v) => v !== from), ...(to !== null && !list.includes(to) ? [to] : [])];
    value = next.length ? next : null;
  }
  return { ok: true, ops: [{ op: 'row.update', id: row.id, values: { [by.id]: value } }] };
}

/** Whether a board column takes cards at all (All threads: only In progress and Done). */
export function boardColumnTakes(db: MichiDatabase, by: MichiDbColumn | undefined, key: string | null): boolean {
  return !!by && boardDropRefusal(db, by, key) === null;
}

/**
 * A card moved inside its column onto `overId` (`list`: the column's cards
 * as drawn): after the card before it there, or, first in the column, just
 * before the card it now leads in the database's own order.
 */
export function boardReorderOps(db: Pick<MichiDatabase, 'rows'>, list: readonly string[], rowId: string, overId: string | undefined): MichiDbEditOp[] {
  const from = list.indexOf(rowId);
  const to = overId === undefined ? list.length - 1 : list.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [];
  const next = list.filter((id) => id !== rowId);
  next.splice(to, 0, rowId);
  const at = next.indexOf(rowId);
  if (at > 0) return [{ op: 'row.move', id: rowId, after: next[at - 1] }];
  const order = [...db.rows].sort(byPosition).map((row) => row.id).filter((id) => id !== rowId);
  const lead = order.indexOf(next[1]);
  return [{ op: 'row.move', id: rowId, after: lead > 0 ? order[lead - 1] : null }];
}

/** The op that puts a moved card back: after the card that led it in the database's own order, or first. */
export function rowMoveBackOp(db: Pick<MichiDatabase, 'rows'>, rowId: string): MichiDbEditOp {
  const order = [...db.rows].sort(byPosition).map((row) => row.id);
  const at = order.indexOf(rowId);
  return { op: 'row.move', id: rowId, after: at > 0 ? order[at - 1] : null };
}

/** The value a card added to a board column starts with: that column's. */
export function boardKeyValue(by: MichiDbColumn, key: string | null): CellValue {
  if (key === null) return null;
  switch (by.type) {
    case 'checkbox': return key === 'true';
    case 'multi': return [key];
    case 'number':
    case 'progress': return Number(key);
    case 'date': return { start: key };
    default: return key;
  }
}

// ── Calendar ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(y, m - 1, d + by);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function dayCount(a: string, b: string): number {
  return Math.round((timeOf(b) - timeOf(a)) / DAY_MS);
}

/** A row's date moved to `day`: a range keeps its length. Times become plain days. */
export function calendarMoveOps(db: MichiDatabase, row: MichiDbRow, column: MichiDbColumn, day: string): EditCheck {
  if (!cellEditable(column)) return { ok: false, reason: `${columnName(db, column)} can't be changed` };
  const v = cellOf(row, column.id);
  const start = isDateValue(v) ? dayOf(v.start) : typeof v === 'string' ? dayOf(v) : null;
  if (start === day) return { ok: true, ops: [] };
  const end = isDateValue(v) && v.end ? dayOf(v.end) : null;
  const value = start && end ? { start: day, end: shiftDay(day, dayCount(start, end)) } : { start: day };
  return { ok: true, ops: [{ op: 'row.update', id: row.id, values: { [column.id]: value } }] };
}

// ── Columns ──────────────────────────────────────────────────────────

/** A new column after the last one shown; a view that lists its columns lists the new one too, or it would be added out of sight. */
export function addColumnOps(db: MichiDatabase, view: MichiDbView, name: string, type: MichiDbColumnType): { id: string; ops: MichiDbEditOp[] } {
  const id = newDbId('c');
  const shown = shownColumns(db, view.config, view.type);
  const last = shown[shown.length - 1]?.id;
  const ops: MichiDbEditOp[] = [{
    op: 'column.add',
    column: { id, name: name.trim() || COLUMN_TYPE_LABEL[type], type, ...(type === 'select' || type === 'multi' ? { options: [] } : {}) },
    ...(last ? { after: last } : {}),
  }];
  if (view.config.visible || view.type === 'list') ops.push(viewSave(view, { ...view.config, visible: [...shown.map((c) => c.id), id] }));
  return { id, ops };
}

export const renameColumnOp = (column: MichiDbColumn, name: string): MichiDbEditOp[] =>
  column.builtin || !name.trim() || name.trim() === column.name ? [] : [{ op: 'column.update', id: column.id, patch: { name: name.trim() } }];

export const columnTypeOp = (column: MichiDbColumn, type: MichiDbColumnType): MichiDbEditOp[] =>
  column.builtin || column.type === type ? [] : [{ op: 'column.update', id: column.id, patch: { type } }];

export const deleteColumnOp = (column: MichiDbColumn): MichiDbEditOp[] => (column.builtin ? [] : [{ op: 'column.delete', id: column.id }]);

/** Hide a column in this view only. The title column is never hidden. */
export function hideColumnOp(db: MichiDatabase, view: MichiDbView, column: MichiDbColumn): MichiDbEditOp[] {
  if (titleColumn(db)?.id === column.id) return [];
  const shown = shownColumns(db, view.config, view.type);
  return [viewSave(view, { ...view.config, visible: shown.filter((c) => c.id !== column.id).map((c) => c.id) })];
}

/** Show or hide one column in this view (the Properties panel). The title always shows. */
export function toggleColumnOp(db: MichiDatabase, view: MichiDbView, column: MichiDbColumn, on: boolean): MichiDbEditOp[] {
  if (titleColumn(db)?.id === column.id) return [];
  const shown = new Set(shownColumns(db, view.config, view.type).map((c) => c.id));
  if (shown.has(column.id) === on) return [];
  if (on) shown.add(column.id);
  else shown.delete(column.id);
  return [viewSave(view, { ...view.config, visible: db.columns.filter((c) => shown.has(c.id)).map((c) => c.id) })];
}

/** Sort the view by one column first; other sorts follow. */
export function sortByColumnOp(view: MichiDbView, column: MichiDbColumn, dir: 'asc' | 'desc'): MichiDbEditOp {
  const rest = view.config.sorts.filter((s) => s.column !== column.id);
  return viewSave(view, { ...view.config, sorts: [{ column: column.id, dir }, ...rest] });
}

/** A new condition on a column, with the operator that suits it best and no value yet. */
export function filterByColumnOp(view: MichiDbView, column: MichiDbColumn): MichiDbEditOp {
  return viewSave(view, { ...view.config, filters: [...view.config.filters, { column: column.id, op: OPS_FOR[column.type][0] }] });
}

// ── Handing rows to the assistant ────────────────────────────────────

/**
 * A row as material for the assistant. A thread goes as a thread (the
 * assistant can read it); any other row as `row` with id `<db>:<row>` and its
 * properties as `Column: value` lines.
 */
export function rowContextItem(db: MichiDatabase, row: MichiDbRow): MichiContextItem {
  const title = titleColumn(db);
  const name = (title ? cellText(title, cellOf(row, title.id)) : '').trim() || 'Untitled';
  if (isThreadsDb(db)) {
    const project = cellOf(row, 'project');
    return { kind: 'thread', id: row.id, title: name, ...(typeof project === 'string' && project ? { projectId: project } : {}) };
  }
  const lines = db.columns
    .filter((c) => c.id !== title?.id)
    .flatMap((c) => {
      const text = cellText(c, cellOf(row, c.id), (col, v) => optionName(db, col, v)).trim();
      return text ? [`${columnName(db, c)}: ${text}`] : [];
    });
  const body = row.body?.trim();
  const text = [...lines, ...(body ? ['', body] : [])].join('\n');
  return { kind: 'row', id: `${db.id}:${row.id}`, title: name, ...(text ? { text } : {}), ...(db.projectId ? { projectId: db.projectId } : {}) };
}
