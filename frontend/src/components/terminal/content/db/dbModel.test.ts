import { describe, expect, it } from 'vitest';
import type { MichiDatabase, MichiDbViewConfig } from 'michi-shared';
import { applyView, convertValue, effectiveConfig, emptyConfig, limitGroups, listDefaultColumns, rowsInOrder, shownColumns, startValues, titleColumn } from './dbModel';
import { threadsDatabase, userDatabase } from './dbTestData';

const cfg = (extra: Partial<MichiDbViewConfig> = {}): MichiDbViewConfig => ({ ...emptyConfig(), ...extra });
const ids = (groups: ReturnType<typeof applyView>) => rowsInOrder(groups).map((r) => r.id);

describe('applyView filters', () => {
  const db = userDatabase();

  it('matches by column type', () => {
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_name', op: 'contains', value: 'hotel' }] })))).toEqual(['r1']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_pri', op: 'is', value: 'high' }] })))).toEqual(['r1']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_pri', op: 'is-not', value: 'High' }] })))).toEqual(['r2', 'r3']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_done', op: 'checked' }] })))).toEqual(['r3']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_effort', op: 'gt', value: 2 }] })))).toEqual(['r1']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_due', op: 'after', value: '2026-10-24' }] })))).toEqual(['r1']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_due', op: 'empty' }] })))).toEqual(['r2', 'r3']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_tags', op: 'contains', value: 'trip' }] })))).toEqual(['r1']);
  });

  it('needs all conditions, or any with match any', () => {
    const filters = [{ column: 'c_pri', op: 'is' as const, value: 'High' }, { column: 'c_done', op: 'checked' as const }];
    expect(ids(applyView(db, cfg({ filters })))).toEqual([]);
    expect(ids(applyView(db, cfg({ filters, match: 'any' })))).toEqual(['r1', 'r3']);
  });

  it('leaves out conditions on a missing column or still waiting for a value', () => {
    expect(ids(applyView(db, cfg({ filters: [{ column: 'gone', op: 'is', value: 'x' }, { column: 'c_pri', op: 'is' }] })))).toEqual(['r1', 'r2', 'r3']);
  });

  it('leaves out a waiting condition on a column that holds no conversations', () => {
    expect(ids(applyView(db, cfg({ filters: [{ column: 'c_pri', op: 'waiting' }] })))).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('applyView on agent one-liners', () => {
  const thread = (id: string, stoppedAt: string) => ({ id, projectId: 'p1', title: `T ${id}`, state: 'doing' as const, lastActivityAt: 1, idleDays: 0, stoppedAt, next: null, source: null });
  const db = threadsDatabase([thread('a', '**Zed** shipped'), thread('b', 'Approve with `comments`'), thread('c', '## Merged')]);

  it('filters Stopped at by the words it shows, not its Markdown', () => {
    expect(ids(applyView(db, cfg({ filters: [{ column: 'stoppedAt', op: 'contains', value: 'zed shipped' }] })))).toEqual(['a']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'stoppedAt', op: 'contains', value: 'with comments' }] })))).toEqual(['b']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'stoppedAt', op: 'contains', value: '##' }] })))).toEqual([]);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'stoppedAt', op: 'not-contains', value: '**' }] })))).toEqual(['a', 'b', 'c']);
  });

  it('sorts Stopped at by the words it shows', () => {
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'stoppedAt', dir: 'asc' }] })))).toEqual(['b', 'c', 'a']);
  });

  it('leaves a text column of one’s own database as written', () => {
    const own = userDatabase();
    own.rows[0].values.c_name = '**Book** the hotel';
    expect(ids(applyView(own, cfg({ filters: [{ column: 'c_name', op: 'contains', value: '**book**' }] })))).toEqual(['r1']);
  });
});

describe('applyView sorts', () => {
  const db = userDatabase();

  it('puts empty cells last whichever way', () => {
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'c_effort', dir: 'asc' }] })))).toEqual(['r2', 'r1', 'r3']);
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'c_effort', dir: 'desc' }] })))).toEqual(['r1', 'r2', 'r3']);
  });

  it('orders a select by its options, not its words', () => {
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'c_pri', dir: 'asc' }] })))).toEqual(['r1', 'r2', 'r3']);
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'c_pri', dir: 'desc' }] })))).toEqual(['r2', 'r1', 'r3']);
  });

  it('breaks ties by position', () => {
    expect(ids(applyView(db, cfg({ sorts: [{ column: 'c_done', dir: 'asc' }] })))).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('applyView groups', () => {
  const db = userDatabase();

  it('keeps every option group (empty ones too), then the empty cells', () => {
    const groups = applyView(db, cfg({ group: 'c_pri' }));
    expect(groups.map((g) => [g.key, g.count])).toEqual([['High', 1], ['Normal', 0], ['Low', 1], [null, 1]]);
  });

  it('sums number columns per group', () => {
    const groups = applyView(db, cfg({ group: 'c_pri' }));
    expect(groups[0].sums.c_effort).toBe(3);
    expect(groups[2].sums.c_effort).toBe(2);
  });

  it('splits checkboxes into checked and not', () => {
    expect(applyView(db, cfg({ group: 'c_done' })).map((g) => [g.key, g.count])).toEqual([['true', 1], ['false', 2]]);
  });

  it('puts a multi-select row in each of its groups', () => {
    const multi = { ...db, rows: [...db.rows, { id: 'r4', values: { c_name: 'Both', c_tags: ['trip', 'desk'] }, position: 3, updatedAt: 1 }] };
    const groups = applyView(multi, cfg({ group: 'c_tags' }));
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([['trip', ['r1', 'r4']], ['desk', ['r4']], [null, ['r2', 'r3']]]);
    expect(rowsInOrder(groups).map((r) => r.id)).toEqual(['r1', 'r4', 'r2', 'r3']);
  });

  it('groups All threads by status in Michi order', () => {
    const threads = threadsDatabase([
      { id: 'a', projectId: 'p1', title: 'A', state: 'doing', lastActivityAt: 2, idleDays: 0, stoppedAt: '', next: null, source: null },
      { id: 'b', projectId: 'p1', title: 'B', state: 'waiting', lastActivityAt: 1, idleDays: 0, stoppedAt: '', next: null, source: null },
    ]);
    expect(applyView(threads, cfg({ group: 'state' })).map((g) => [g.key, g.count])).toEqual([['waiting', 1], ['stalled', 0], ['doing', 1], ['done', 0], ['idea', 0]]);
  });
});

describe('convertValue', () => {
  it('turns typed text into the column type, or refuses', () => {
    expect(convertValue('example.com/a', 'url')).toEqual({ value: 'https://example.com/a', ok: true });
    expect(convertValue('javascript:alert(1)', 'url').ok).toBe(false);
    expect(convertValue('http://x.dev/a.png', 'image').ok).toBe(false);
    expect(convertValue('40%', 'progress')).toEqual({ value: 0.4, ok: true });
    expect(convertValue('2026-10-27 → 2026-10-25', 'date')).toEqual({ value: { start: '2026-10-25', end: '2026-10-27' }, ok: true });
    expect(convertValue('5', 'date').ok).toBe(false);
    expect(convertValue('yes', 'checkbox')).toEqual({ value: true, ok: true });
    expect(convertValue('trip, desk', 'multi', [{ value: 'trip' }, { value: 'desk' }])).toEqual({ value: ['trip', 'desk'], ok: true });
    expect(convertValue('   ', 'number')).toEqual({ value: null, ok: true });
  });
});

describe('columns and views', () => {
  it('names a thread by its title and anything else by its first text column', () => {
    expect(titleColumn(threadsDatabase([]))?.id).toBe('title');
    expect(titleColumn(userDatabase())?.id).toBe('c_name');
  });

  it('shows the listed columns plus the title', () => {
    expect(shownColumns(userDatabase(), cfg({ visible: ['c_pri'] })).map((c) => c.id)).toEqual(['c_name', 'c_pri']);
    expect(shownColumns(userDatabase(), cfg())).toHaveLength(6);
  });

  it('starts a list with the title and a few short columns, not every column', () => {
    expect(listDefaultColumns(threadsDatabase([]))).toEqual(['state', 'project', 'app', 'lastActivity']);
    expect(shownColumns(threadsDatabase([]), cfg(), 'list').map((c) => c.id)).toEqual(['title', 'project', 'state', 'app', 'lastActivity']);
    // A database's first two short columns: Priority (select) and Due (date), not Tags or long text.
    expect(shownColumns(userDatabase(), cfg(), 'list').map((c) => c.id)).toEqual(['c_name', 'c_pri', 'c_due']);
    // Once the view picks its columns, those are what it shows; other view types still show all.
    expect(shownColumns(userDatabase(), cfg({ visible: ['c_tags'] }), 'list').map((c) => c.id)).toEqual(['c_name', 'c_tags']);
    expect(shownColumns(userDatabase(), cfg(), 'table')).toHaveLength(6);
  });

  it('a board without a grouping splits by the first select', () => {
    const db = userDatabase();
    expect(effectiveConfig(db, { ...db.views[0], type: 'board' }).group).toBe('c_pri');
    expect(effectiveConfig(db, db.views[0]).group).toBeUndefined();
  });

  it('a new row starts out meeting simple conditions', () => {
    const db = userDatabase();
    expect(startValues(db, cfg({ filters: [{ column: 'c_pri', op: 'is', value: 'High' }, { column: 'c_effort', op: 'gt', value: 1 }] }))).toEqual({ c_pri: 'High' });
    expect(startValues(db, cfg({ match: 'any', filters: [{ column: 'c_pri', op: 'is', value: 'High' }] }))).toEqual({});
  });
});

describe('limitGroups', () => {
  it('cuts the groups to the first rows in reading order', () => {
    const groups = applyView(userDatabase(), cfg({ group: 'c_pri' }));
    const { groups: cut, rest } = limitGroups(groups, 2);
    expect(cut.map((g) => g.rows.map((r) => r.id))).toEqual([['r1'], [], ['r2'], []]);
    expect(rest).toBe(1);
    expect(cut[0]).toBe(groups[0]);
    expect(limitGroups(groups, 10).rest).toBe(0);
  });

  it('counts a multi-select row once, wherever it shows', () => {
    const db = userDatabase();
    const multi = { ...db, rows: [...db.rows, { id: 'r4', values: { c_name: 'Both', c_tags: ['trip', 'desk'] }, position: 3, updatedAt: 1 }] };
    const groups = applyView(multi, cfg({ group: 'c_tags' }));
    // trip: r1 r4 · desk: r4 · empty: r2 r3
    const { groups: cut, rest } = limitGroups(groups, 2);
    expect(cut.map((g) => g.rows.map((r) => r.id))).toEqual([['r1', 'r4'], ['r4'], []]);
    expect(rest).toBe(2);
    expect(limitGroups(groups, 3).rest).toBe(1);
    expect(limitGroups(groups, 4).rest).toBe(0);
  });
});

describe('a Conversations column', () => {
  const db: Pick<MichiDatabase, 'id' | 'kind' | 'columns' | 'rows'> = {
    id: 'db-tasks', kind: 'user',
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'threads', name: 'Conversations', type: 'threads' }],
    rows: [
      { id: 'a', values: { task: 'Ship', threads: ['n1', 'n2'] }, position: 0, updatedAt: 1 },
      { id: 'b', values: { task: 'Docs', threads: ['n3'] }, position: 1, updatedAt: 1 },
      { id: 'c', values: { task: 'Idea' }, position: 2, updatedAt: 1 },
    ],
  };
  const TITLES: Record<string, string> = { n1: 'Schema naming', n2: 'Migration plan', n3: 'Docs pass' };
  const live = (waiting: string[]) => (nodeId: string) =>
    (TITLES[nodeId] === undefined ? undefined : { waiting: waiting.includes(nodeId), title: TITLES[nodeId] });

  it('keeps the rows with a conversation waiting on the person, as they stand now', () => {
    const waiting = cfg({ filters: [{ column: 'threads', op: 'waiting' }] });
    expect(ids(applyView(db, waiting, { conversation: live(['n2']) }))).toEqual(['a']);
    expect(ids(applyView(db, waiting, { conversation: live(['n3']) }))).toEqual(['b']);
    // Without live states nothing waits.
    expect(ids(applyView(db, waiting))).toEqual([]);
  });

  it('finds a linked conversation by its title or id, and knows an empty cell', () => {
    expect(ids(applyView(db, cfg({ filters: [{ column: 'threads', op: 'contains', value: 'migration' }] }), { conversation: live([]) }))).toEqual(['a']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'threads', op: 'contains', value: 'n3' }] })))).toEqual(['b']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'threads', op: 'not-contains', value: 'docs' }] }), { conversation: live([]) }))).toEqual(['a', 'c']);
    expect(ids(applyView(db, cfg({ filters: [{ column: 'threads', op: 'empty' }] })))).toEqual(['c']);
  });

  it('holds conversation ids only, each once', () => {
    expect(convertValue(['n1', 'n1', 'n2'], 'threads')).toEqual({ value: ['n1', 'n2'], ok: true });
    expect(convertValue('n1', 'threads')).toEqual({ value: null, ok: false });
    expect(convertValue(null, 'threads')).toEqual({ value: null, ok: true });
  });
});
