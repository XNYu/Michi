import { describe, expect, it } from 'vitest';
import type { MichiDbColumn } from 'michi-shared';
import type { SampleThread as DatabaseRowStatus } from './dbTestData';
import {
  addColumnOps,
  addViewOp,
  AUTO_STATE,
  boardColumnTakes,
  boardDropRefusal,
  boardKeyValue,
  boardReorderOps,
  rowMoveBackOp,
  chunkEditOps,
  boardDropOps,
  calendarMoveOps,
  cellEditLabel,
  cellEditOps,
  columnTypeOp,
  deleteColumnOp,
  filterByColumnOp,
  hideColumnOp,
  renameColumnOp,
  rowContextItem,
  setColumnOps,
  sortByColumnOp,
  toggleColumnOp,
} from './dbOps';
import { threadsDatabase, userDatabase } from './dbTestData';

const thread = (id: string, extra: Partial<DatabaseRowStatus> = {}): DatabaseRowStatus => ({
  id, projectId: 'p1', title: `Thread ${id}`, state: 'waiting', lastActivityAt: 1000, idleDays: 0, stoppedAt: '', next: null, source: null, ...extra,
});

const threads = threadsDatabase([thread('t1'), thread('t2', { state: 'stalled' })]);
const col = (db: typeof threads, id: string) => db.columns.find((c) => c.id === id)!;
const row = (db: typeof threads, id: string) => db.rows.find((r) => r.id === id)!;

describe('cell edits', () => {
  it('lets All threads change only title, status (In progress / Done) and next', () => {
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'title'), 'Renamed')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 't1', values: { title: 'Renamed' } }] });
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'next'), 'Ship it')).toMatchObject({ ok: true });
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'state'), 'done')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 't1', values: { state: 'done' } }] });
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'state'), 'stalled')).toEqual({ ok: false, reason: AUTO_STATE });
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'app'), 'Codex')).toEqual({ ok: false, reason: "App can't be changed" });
    expect(cellEditOps(threads, row(threads, 't1'), col(threads, 'title'), '  ')).toEqual({ ok: false, reason: 'A thread needs a title' });
  });

  it('sends nothing for the same value, and a new option first', () => {
    const db = userDatabase();
    expect(cellEditOps(db, db.rows[0], db.columns[1], 'High')).toEqual({ ok: true, ops: [] });
    const extra = [{ op: 'option.add' as const, id: 'c_pri', option: { value: 'Urgent' } }];
    expect(cellEditOps(db, db.rows[0], db.columns[1], 'Urgent', extra)).toEqual({ ok: true, ops: [...extra, { op: 'row.update', id: 'r1', values: { c_pri: 'Urgent' } }] });
  });

  it('says what a status change did', () => {
    expect(cellEditLabel(threads, col(threads, 'state'), 'doing')).toBe('Marked in progress');
    expect(cellEditLabel(threads, col(threads, 'state'), 'done')).toBe('Marked done');
    expect(cellEditLabel(threads, col(threads, 'next'), 'x')).toBe('Changed Next');
  });

  it('sets one value on many rows in one edit', () => {
    const db = userDatabase();
    expect(setColumnOps(db, db.rows.slice(0, 2), db.columns[3], '5')).toEqual({ ok: true, ops: [
      { op: 'row.update', id: 'r1', values: { c_effort: 5 } },
      { op: 'row.update', id: 'r2', values: { c_effort: 5 } },
    ] });
    expect(setColumnOps(threads, threads.rows, col(threads, 'state'), 'idea')).toEqual({ ok: false, reason: AUTO_STATE });
    expect(setColumnOps(threads, threads.rows, col(threads, 'state'), 'doing')).toMatchObject({ ok: true });
  });
});

describe('board drops', () => {
  it('sets the column value, and on All threads only into In progress or Done', () => {
    const state = col(threads, 'state');
    expect(boardDropOps(threads, state, row(threads, 't2'), 'stalled', 'doing')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 't2', values: { state: 'doing' } }] });
    expect(boardDropOps(threads, state, row(threads, 't1'), 'waiting', 'stalled')).toEqual({ ok: false, reason: AUTO_STATE });
    expect(boardDropOps(threads, state, row(threads, 't1'), 'waiting', null)).toEqual({ ok: false, reason: AUTO_STATE });
    expect(boardDropOps(threads, state, row(threads, 't1'), 'waiting', 'waiting')).toEqual({ ok: true, ops: [] });
    expect(boardColumnTakes(threads, state, 'done')).toBe(true);
    expect(boardColumnTakes(threads, state, 'waiting')).toBe(false);
    expect(boardColumnTakes(threads, col(threads, 'project'), 'p1')).toBe(false);
  });

  it('swaps the option a multi-select card came from', () => {
    const db = userDatabase();
    const tags = db.columns.find((c) => c.id === 'c_tags')!;
    expect(boardDropOps(db, tags, db.rows[0], 'trip', 'desk')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 'r1', values: { c_tags: ['desk'] } }] });
    const done = db.columns.find((c) => c.id === 'c_done')!;
    expect(boardDropOps(db, done, db.rows[0], 'false', 'true')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 'r1', values: { c_done: true } }] });
  });
});

describe('calendar moves', () => {
  it('moves a range keeping its length', () => {
    const db = userDatabase();
    const due = db.columns.find((c) => c.id === 'c_due')!;
    expect(calendarMoveOps(db, db.rows[0], due, '2026-10-30')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 'r1', values: { c_due: { start: '2026-10-30', end: '2026-11-01' } } }] });
    expect(calendarMoveOps(db, db.rows[1], due, '2026-10-30')).toEqual({ ok: true, ops: [{ op: 'row.update', id: 'r2', values: { c_due: { start: '2026-10-30' } } }] });
    expect(calendarMoveOps(threads, row(threads, 't1'), col(threads, 'lastActivity'), '2026-10-30').ok).toBe(false);
  });
});

describe('column menu ops', () => {
  const db = userDatabase();
  const view = db.views[0];
  const pri = db.columns[1];

  it('renames, retypes and deletes a column a person added, never a built-in', () => {
    expect(renameColumnOp(pri, ' Urgency ')).toEqual([{ op: 'column.update', id: 'c_pri', patch: { name: 'Urgency' } }]);
    expect(renameColumnOp(pri, 'Priority')).toEqual([]);
    expect(columnTypeOp(pri, 'text')).toEqual([{ op: 'column.update', id: 'c_pri', patch: { type: 'text' } }]);
    expect(deleteColumnOp(pri)).toEqual([{ op: 'column.delete', id: 'c_pri' }]);
    expect(renameColumnOp(col(threads, 'next'), 'X')).toEqual([]);
    expect(deleteColumnOp(col(threads, 'next'))).toEqual([]);
  });

  it('hides a column in this view only, but never the title', () => {
    expect(hideColumnOp(db, view, pri)).toEqual([{ op: 'view.save', view: { id: 'table', name: '表格', type: 'table', config: { ...view.config, visible: ['c_name', 'c_due', 'c_effort', 'c_tags', 'c_done'] } } }]);
    expect(hideColumnOp(db, view, db.columns[0])).toEqual([]);
  });

  it('sorts and filters by a column', () => {
    const sorted = { ...view, config: { ...view.config, sorts: [{ column: 'c_effort', dir: 'asc' as const }] } };
    expect(sortByColumnOp(sorted, pri, 'desc')).toMatchObject({ view: { config: { sorts: [{ column: 'c_pri', dir: 'desc' }, { column: 'c_effort', dir: 'asc' }] } } });
    expect(filterByColumnOp(view, pri)).toMatchObject({ view: { config: { filters: [{ column: 'c_pri', op: 'is' }] } } });
  });

  it('adds a column after the last shown one, listing it in a view that lists its columns', () => {
    const listed = { ...view, config: { ...view.config, visible: ['c_name', 'c_pri'] } };
    const { id, ops } = addColumnOps(db, listed, '', 'select');
    expect(ops[0]).toEqual({ op: 'column.add', column: { id, name: 'Select', type: 'select', options: [] }, after: 'c_pri' });
    expect(ops[1]).toMatchObject({ op: 'view.save', view: { config: { visible: ['c_name', 'c_pri', id] } } });
  });

  it('shows and hides a column from the Properties panel, starting a list from its defaults', () => {
    const db = userDatabase();
    const list = { ...view, type: 'list' as const };
    const tags = db.columns.find((c) => c.id === 'c_tags')!;
    expect(toggleColumnOp(db, list, tags, true)).toEqual([
      { op: 'view.save', view: { id: 'table', name: '表格', type: 'list', config: { ...view.config, visible: ['c_name', 'c_pri', 'c_due', 'c_tags'] } } },
    ]);
    expect(toggleColumnOp(db, list, pri, false)).toMatchObject([{ view: { config: { visible: ['c_name', 'c_due'] } } }]);
    // Already so, or the title: nothing to save.
    expect(toggleColumnOp(db, list, pri, true)).toEqual([]);
    expect(toggleColumnOp(db, list, db.columns[0], false)).toEqual([]);
    // Hiding in a list keeps its other defaults rather than showing everything.
    expect(hideColumnOp(db, list, pri)).toMatchObject([{ view: { config: { visible: ['c_name', 'c_due'] } } }]);
  });
});

describe('views', () => {
  it('names a new view freely and sets All threads defaults', () => {
    const board = addViewOp(threads, 'board');
    expect(board.op).toMatchObject({ op: 'view.save', view: { id: board.id, name: 'Board', type: 'board', config: { group: 'state' } } });
    const table = addViewOp(threads, 'table');
    expect(table.op).toMatchObject({ view: { name: 'Table 2' } });
    expect(addViewOp(threads, 'calendar').op).toMatchObject({ view: { config: { date: 'lastActivity' } } });
  });
});

describe('handing rows to the assistant', () => {
  it('hands a thread as a thread and any other row with its properties', () => {
    expect(rowContextItem(threads, row(threads, 't1'))).toEqual({ kind: 'thread', id: 't1', title: 'Thread t1', projectId: 'p1' });
    const db = userDatabase();
    expect(rowContextItem(db, db.rows[0])).toEqual({
      kind: 'row',
      id: 'db_trip:r1',
      title: 'Book the hotel',
      text: 'Priority: High\nDue: 2026-10-25 → 2026-10-27\nEffort: 3\nTags: trip\n\nKanra or **Ace**',
    });
  });
});

describe('chunkEditOps', () => {
  const del = (i: number) => ({ op: 'row.delete' as const, id: `r${i}` });

  it('keeps an edit that fits in one part', () => {
    const ops = Array.from({ length: 200 }, (_, i) => del(i));
    expect(chunkEditOps(ops)).toEqual([ops]);
  });

  it("cuts a long edit into parts of Michi's size, in order", () => {
    const ops = Array.from({ length: 450 }, (_, i) => del(i));
    const parts = chunkEditOps(ops);
    expect(parts.map((p) => p.length)).toEqual([200, 200, 50]);
    expect(parts.flat()).toEqual(ops);
  });

  it('cuts by size too, and sends an op over the cap alone', () => {
    const body = (n: number) => ({ op: 'row.update' as const, id: 'r', body: 'x'.repeat(n) });
    const parts = chunkEditOps([body(40), body(40), body(40), body(500), body(10)], 200, 120);
    expect(parts.map((p) => p.map((op) => ('body' in op ? op.body?.length : 0)))).toEqual([[40], [40], [40], [500], [10]]);
    // JSON counted as UTF-8 bytes, as the proxy measures it.
    expect(chunkEditOps([body(30), { op: 'row.update', id: 'r', body: '旅'.repeat(30) }], 200, 180)).toHaveLength(2);
  });
});

describe('board moves', () => {
  const db = userDatabase();

  it('puts a card after the card it lands on, or first just before the card it now leads', () => {
    expect(boardReorderOps(db, ['r1', 'r2', 'r3'], 'r1', 'r3')).toEqual([{ op: 'row.move', id: 'r1', after: 'r3' }]);
    expect(boardReorderOps(db, ['r1', 'r2', 'r3'], 'r3', 'r2')).toEqual([{ op: 'row.move', id: 'r3', after: 'r1' }]);
    expect(boardReorderOps(db, ['r1', 'r2', 'r3'], 'r3', 'r1')).toEqual([{ op: 'row.move', id: 'r3', after: null }]);
    // First in its column, it goes just before the card it leads, in the whole database's order.
    expect(boardReorderOps(db, ['r2', 'r3'], 'r3', 'r2')).toEqual([{ op: 'row.move', id: 'r3', after: 'r1' }]);
    // Let go below the cards, it goes last.
    expect(boardReorderOps(db, ['r1', 'r2'], 'r1', undefined)).toEqual([{ op: 'row.move', id: 'r1', after: 'r2' }]);
    expect(boardReorderOps(db, ['r1', 'r2'], 'r1', 'r1')).toEqual([]);
    expect(boardReorderOps(db, ['r1', 'r2'], 'gone', 'r1')).toEqual([]);
  });

  it('moves a card back after the card that led it, or first', () => {
    const db = userDatabase();
    const ids = [...db.rows].sort((a, b) => a.position - b.position).map((r) => r.id);
    expect(rowMoveBackOp(db, ids[0])).toEqual({ op: 'row.move', id: ids[0], after: null });
    expect(rowMoveBackOp(db, ids[1])).toEqual({ op: 'row.move', id: ids[1], after: ids[0] });
  });

  it('gives a card added at the foot of a column that column\u2019s value', () => {
    const typed = (type: MichiDbColumn['type']): MichiDbColumn => ({ id: 'c', name: 'C', type });
    expect(boardKeyValue(typed('select'), 'High')).toBe('High');
    expect(boardKeyValue(typed('multi'), 'trip')).toEqual(['trip']);
    expect(boardKeyValue(typed('checkbox'), 'true')).toBe(true);
    expect(boardKeyValue(typed('checkbox'), 'false')).toBe(false);
    expect(boardKeyValue(typed('number'), '3')).toBe(3);
    expect(boardKeyValue(typed('date'), '2026-10-26')).toEqual({ start: '2026-10-26' });
    expect(boardKeyValue(typed('select'), null)).toBeNull();
  });

  it('says why a column will not take a card', () => {
    expect(boardDropRefusal(threads, col(threads, 'state'), 'stalled')).toBe(AUTO_STATE);
    expect(boardDropRefusal(threads, col(threads, 'state'), 'done')).toBeNull();
    expect(boardDropRefusal(threads, col(threads, 'app'), 'Codex')).toBe("App can't be changed");
    expect(boardDropRefusal(db, db.columns.find((c) => c.id === 'c_pri'), 'High')).toBeNull();
  });
});
