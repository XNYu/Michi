import { describe, expect, it } from 'vitest';
import { columnName, databaseTitle, filterChipText, formatDateValue, groupName, optionName, sortLabel, viewName } from './dbLabels';
import { threadsDatabase, userDatabase } from './dbTestData';

const threads = threadsDatabase([]);
const user = userDatabase();
const tcol = (id: string) => threads.columns.find((c) => c.id === id)!;
const ucol = (id: string) => user.columns.find((c) => c.id === id)!;

describe('names in English', () => {
  it('names All threads and its built-ins', () => {
    expect(databaseTitle(threads)).toBe('All threads');
    expect(['title', 'project', 'state', 'app', 'lastActivity', 'next'].map((id) => columnName(threads, tcol(id)))).toEqual(['Title', 'Workspace', 'Status', 'App', 'Last activity', 'Next']);
    expect(threads.views.map((v) => viewName(threads, v))).toEqual(['By status', 'Table', 'Timeline', 'Calendar']);
  });

  it("reads Michi's default names in English and leaves typed names alone", () => {
    expect(columnName(user, ucol('c_name'))).toBe('Name');
    expect(columnName(user, ucol('c_pri'))).toBe('Priority');
    expect(viewName(user, { ...user.views[0], name: '看板 2' })).toBe('Board 2');
    expect(viewName(user, { ...user.views[0], name: '本周' })).toBe('本周');
    expect(viewName(threads, { ...threads.views[0], name: 'Mine' })).toBe('Mine');
    expect(databaseTitle(user)).toBe('旅行清单');
  });

  it("uses Michi's state names on All threads", () => {
    expect(optionName(threads, tcol('state'), 'waiting')).toBe('Waiting on you');
    expect(optionName(threads, tcol('state'), 'done', 'agent')).toBe('Agent says done');
    expect(optionName(threads, tcol('project'), 'p1')).toBe('agent-desk');
    expect(groupName(threads, tcol('state'), null, '')).toBe('Empty');
    expect(groupName(user, ucol('c_done'), 'true', 'Yes')).toBe('Checked');
  });
});

describe('filter chips and sorts', () => {
  it('says a condition the way it reads', () => {
    expect(filterChipText(threads, threads.columns, { column: 'state', op: 'is', value: 'stalled' })).toBe('Status is Stalled');
    expect(filterChipText(user, user.columns, { column: 'c_due', op: 'empty' })).toBe('Due is empty');
    expect(filterChipText(user, user.columns, { column: 'c_effort', op: 'gt', value: 2 })).toBe('Effort is more than 2');
  });

  it('names sort directions by type', () => {
    expect(sortLabel(user, ucol('c_pri'), 'asc')).toBe('High → Low');
    expect(sortLabel(user, ucol('c_due'), 'desc')).toBe('Newest first');
    expect(sortLabel(user, ucol('c_effort'), 'desc')).toBe('High → low');
    expect(sortLabel(user, ucol('c_name'), 'asc')).toBe('A → Z');
  });
});

describe('dates', () => {
  it('writes days and ranges short', () => {
    const now = new Date(2026, 9, 21);
    expect(formatDateValue({ start: '2026-10-25', end: '2026-10-27' }, now)).toBe('Oct 25 → 27');
    expect(formatDateValue({ start: '2026-10-30', end: '2026-11-02' }, now)).toBe('Oct 30 → Nov 2');
    expect(formatDateValue({ start: '2025-01-03' }, now)).toBe('Jan 3, 2025');
  });
});
