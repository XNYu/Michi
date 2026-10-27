import { describe, expect, it } from 'vitest';
import type { MichiDatabase } from 'michi-shared';
import { answerHasData, applyOpsLocally, mergeDbAnswer } from './dbRead';
import { threadsDatabase, userDatabase } from './dbTestData';

const base = (): MichiDatabase => userDatabase();

describe('mergeDbAnswer', () => {
  it('takes a whole database, keeping rows that did not change', () => {
    const old = base();
    const next = { ...base(), rows: base().rows.map((r) => (r.id === 'r2' ? { ...r, values: { ...r.values, c_effort: 5 }, updatedAt: 2 } : r)) };
    const merged = mergeDbAnswer(old, { version: 'v2', database: next })!;
    expect(merged.rows[0]).toBe(old.rows[0]);
    expect(merged.rows[1]).not.toBe(old.rows[1]);
    expect(merged.rows[1].values.c_effort).toBe(5);
    expect(merged.columns).toBe(old.columns);
  });

  it('keeps the very same object when a whole read changed nothing', () => {
    const old = base();
    expect(mergeDbAnswer(old, { version: 'v1', database: base() })).toBe(old);
  });

  it('takes a whole database with no copy yet', () => {
    const db = base();
    expect(mergeDbAnswer(null, { version: 'v1', database: db })).toBe(db);
  });

  it('applies an incremental answer: upserts, removed ids, new rows in position order', () => {
    const old = base();
    const merged = mergeDbAnswer(old, {
      version: 'v3',
      upserts: [
        { id: 'r1', values: { c_name: 'Book Kanra' }, position: 0, updatedAt: 3 },
        { id: 'r0', values: { c_name: 'First' }, position: -1, updatedAt: 3 },
      ],
      removed: ['r3'],
    })!;
    expect(merged.rows.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
    expect(merged.rows[1].values.c_name).toBe('Book Kanra');
    expect(merged.rows[2]).toBe(old.rows[1]);
  });

  it('replaces columns, views and head when they come', () => {
    const old = base();
    const columns = [...old.columns, { id: 'c_new', name: 'New', type: 'text' as const }];
    const merged = mergeDbAnswer(old, { version: 'v4', upserts: [], removed: [], columns, head: { ...old, title: 'Trip' } as never })!;
    expect(merged.columns).toEqual(columns);
    expect(merged.title).toBe('Trip');
    expect(merged.views).toBe(old.views);
    expect(merged.rows).toBe(old.rows);
  });

  it('keeps the copy when only the version came back', () => {
    const old = base();
    expect(mergeDbAnswer(old, { version: 'v1' })).toBe(old);
    expect(mergeDbAnswer(old, { version: 'v1', upserts: [], removed: [] })).toBe(old);
  });

  it('cannot apply changes to a copy there is none of', () => {
    expect(mergeDbAnswer(null, { version: 'v1', upserts: [], removed: ['x'] })).toBeUndefined();
    expect(mergeDbAnswer(null, { version: 'v1' })).toBeUndefined();
  });

  it('tells a read with data from a version alone', () => {
    expect(answerHasData({ version: 'v' })).toBe(false);
    expect(answerHasData({ version: 'v', upserts: [] })).toBe(true);
    expect(answerHasData({ database: base() })).toBe(true);
  });
});

describe('applyOpsLocally', () => {
  it('draws a cell change and a body change at once', () => {
    const db = applyOpsLocally(base(), [{ op: 'row.update', id: 'r2', values: { c_effort: 8 }, body: 'notes' }], 99);
    expect(db.rows[1].values.c_effort).toBe(8);
    expect(db.rows[1].body).toBe('notes');
    expect(db.rows[1].updatedAt).toBe(99);
  });

  it('on All threads only In progress and Done, and never a computed column', () => {
    const db = threadsDatabase([{ id: 't1', projectId: 'p1', title: 'T', state: 'waiting', lastActivityAt: 1, idleDays: 0, stoppedAt: '', next: null, source: null }]);
    const same = applyOpsLocally(db, [{ op: 'row.update', id: 't1', values: { state: 'stalled', app: 'Codex' } }], 5);
    expect(same.rows[0].values.state).toBe('waiting');
    expect(same.rows[0].values.app).toBeUndefined();
    expect(applyOpsLocally(db, [{ op: 'row.update', id: 't1', values: { state: 'done' } }], 5).rows[0].values.state).toBe('done');
    expect(applyOpsLocally(db, [{ op: 'row.add', id: 'x', values: {} }], 5).rows).toHaveLength(1);
  });

  it('adds and deletes rows of a database a person made', () => {
    const added = applyOpsLocally(base(), [{ op: 'row.add', id: 'r9', values: { c_name: 'New', c_pri: null } }], 5);
    expect(added.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r9']);
    expect(added.rows[3].values).toEqual({ c_name: 'New' });
    expect(applyOpsLocally(base(), [{ op: 'row.delete', id: 'r1' }], 5).rows.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('a deleted column leaves nothing behind in its rows or views', () => {
    const db = { ...base(), views: [{ ...base().views[0], config: { filters: [{ column: 'c_pri', op: 'is' as const, value: 'High' }], match: 'all' as const, sorts: [{ column: 'c_pri', dir: 'asc' as const }], group: 'c_pri', visible: ['c_name', 'c_pri'] } }] };
    const next = applyOpsLocally(db, [{ op: 'column.delete', id: 'c_pri' }], 5);
    expect(next.columns.some((c) => c.id === 'c_pri')).toBe(false);
    expect(next.rows[0].values.c_pri).toBeUndefined();
    expect(next.views[0].config).toEqual({ filters: [], match: 'all', sorts: [], visible: ['c_name'] });
  });

  it('saves a view in place or adds it under its id', () => {
    const db = base();
    const renamed = applyOpsLocally(db, [{ op: 'view.save', view: { id: 'table', name: 'Everything', type: 'table', config: db.views[0].config } }], 5);
    expect(renamed.views[0].name).toBe('Everything');
    const added = applyOpsLocally(db, [{ op: 'view.save', view: { id: 'v-b', name: 'Board', type: 'board', config: db.views[0].config } }], 5);
    expect(added.views.map((v) => v.id)).toEqual(['table', 'v-b']);
  });

  it('adds a column after the one named, and an option to a select', () => {
    const db = applyOpsLocally(base(), [
      { op: 'column.add', column: { id: 'c_x', name: 'X', type: 'text' }, after: 'c_name' },
      { op: 'option.add', id: 'c_pri', option: { value: 'Urgent' } },
    ], 5);
    expect(db.columns.map((c) => c.id).slice(0, 2)).toEqual(['c_name', 'c_x']);
    expect(db.columns.find((c) => c.id === 'c_pri')!.options!.map((o) => o.value)).toContain('Urgent');
  });

  it('returns the same database for ops it cannot place', () => {
    const db = base();
    expect(applyOpsLocally(db, [{ op: 'row.update', id: 'gone', values: { c_name: 'x' } }], 5)).toBe(db);
  });
});
