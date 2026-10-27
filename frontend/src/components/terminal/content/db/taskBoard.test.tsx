import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MichiDatabase, MichiDbEditOp, MichiDbRow, ThreadCardItem } from 'michi-shared';
import { TASK_VIEW } from 'michi-shared';
import { DatabaseView } from './DatabaseView';
import { applyOpsLocally } from './dbRead';
import { taskDatabase } from './dbTestData';
import { LiveThreadsContext, type LiveThreads } from './liveThreads';

const NOW = new Date(2026, 9, 26, 15, 0).getTime();
const edits = vi.fn();
const card = (nodeId: string, state: ThreadCardItem['state'], title: string, at = NOW - 120_000, workspaceId = 'ws'): ThreadCardItem =>
  ({ nodeId, workspaceId, title, state, summary: state === 'waiting' ? 'Which one?' : '', at, messageId: null });
const live = (items: ThreadCardItem[], extra: Partial<LiveThreads> = {}): LiveThreads =>
  ({ byNode: new Map(items.map((item) => [item.nodeId, item])), loaded: true, failed: false, workspaceId: 'ws', open: () => undefined, ...extra });
const task = (id: string, values: MichiDbRow['values'], position = 0): MichiDbRow => ({ id, values, position, updatedAt: NOW - 60_000 });

function Harness({ initial, states, viewId = TASK_VIEW.board }: { initial: MichiDatabase; states: LiveThreads; viewId?: string }) {
  const [db, setDb] = useState(initial);
  const [view, setView] = useState<string | null>(viewId);
  const edit = async (ops: MichiDbEditOp[], label: string) => {
    edits(ops, label);
    setDb((d) => applyOpsLocally(d, ops, 2));
    return true;
  };
  return <LiveThreadsContext.Provider value={states}>
    <DatabaseView db={db} edit={edit} viewId={view} onViewChange={setView} threadOf={() => undefined} now={NOW} services={{}} />
  </LiveThreadsContext.Provider>;
}

const rows = [
  task('t1', { task: 'Pick a schema naming rule', status: 'doing', next: 'Decide camelCase or snake_case', threads: ['a', 'b', 'c', 'd'] }, 0),
  task('t2', { task: 'Write the migration', status: 'waiting', threads: ['a'] }, 1),
  task('t3', { task: 'Ship docs', status: 'done', next: 'Nothing left', threads: ['c'] }, 2),
  task('t4', { task: 'Idea for later', status: 'todo' }, 3),
];
const states = live([card('a', 'waiting', 'Schema naming'), card('b', 'running', 'Tests'), card('c', 'done', 'Docs pass'), card('d', 'idle', 'Kickoff')]);
const cardOf = (title: string) => screen.getByText(title).closest('.michi-card') as HTMLElement;

beforeEach(() => { edits.mockReset(); window.localStorage.clear(); });

describe('the task board', () => {
  it('splits by status in its own order, and each card says what is next and which conversations it has', () => {
    render(<Harness initial={taskDatabase(rows)} states={states} />);
    expect([...document.querySelectorAll('section.michi-db-col')].map((col) => col.getAttribute('aria-label'))).toEqual(['To do', 'In progress', 'Waiting on you', 'Done']);
    const first = cardOf('Pick a schema naming rule');
    expect(first.textContent).toContain('Next: Decide camelCase or snake_case');
    expect(within(first).getAllByRole('button').map((button) => button.textContent)).toEqual(['Schema naming', 'Tests', 'Docs pass']);
    expect(within(first).getByText('+1')).toBeTruthy();
    expect(cardOf('Ship docs').textContent).not.toContain('Next:');
    expect(within(screen.getByRole('region', { name: 'To do' })).getByText('No conversations yet')).toBeTruthy();
    // Status heads draw the task status glyph, apart from conversation dots.
    expect(screen.getByRole('region', { name: 'Waiting on you' }).querySelector('.michi-task-status[data-status="waiting"]')).not.toBeNull();
  });

  it('marks a card whose conversation waits on you, unless the task already waits on you', () => {
    render(<Harness initial={taskDatabase(rows)} states={states} />);
    expect(cardOf('Pick a schema naming rule').getAttribute('data-attention')).toBe('true');
    expect(cardOf('Pick a schema naming rule').textContent).toContain('Waiting on you');
    expect(cardOf('Write the migration').getAttribute('data-attention')).toBeNull();
  });

  it('adds a task at the foot of a column with that status', () => {
    render(<Harness initial={taskDatabase(rows)} states={states} />);
    const todo = () => screen.getByRole('region', { name: 'To do' });
    fireEvent.click(within(todo()).getByRole('button', { name: 'New task in To do' }));
    const field = within(todo()).getByRole('textbox', { name: 'New task in To do' });
    fireEvent.change(field, { target: { value: 'Plan the launch' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(edits).toHaveBeenLastCalledWith([{ op: 'row.add', id: expect.any(String), values: { status: 'todo', task: 'Plan the launch' } }], 'Added a task');
    expect(within(todo()).getByText('Plan the launch')).toBeTruthy();
  });

  it('lists in Needs you the tasks waiting on you and the ones with a waiting conversation, as they stand now', () => {
    const { unmount } = render(<Harness initial={taskDatabase(rows)} states={states} viewId={TASK_VIEW.needsYou} />);
    expect(screen.getByText('Pick a schema naming rule')).toBeTruthy();
    expect(screen.getByText('Write the migration')).toBeTruthy();
    expect(screen.queryByText('Ship docs')).toBeNull();
    expect(screen.queryByText('Idea for later')).toBeNull();
    unmount();
    // Once the conversation stops waiting, only the task that waits itself stays.
    render(<Harness initial={taskDatabase(rows)} states={live([card('a', 'done', 'Schema naming')])} viewId={TASK_VIEW.needsYou} />);
    expect(screen.queryByText('Pick a schema naming rule')).toBeNull();
    expect(screen.getByText('Write the migration')).toBeTruthy();
  });
});

describe('a task database’s core columns', () => {
  const withOwner = (): MichiDatabase => {
    const db = taskDatabase(rows);
    return { ...db, columns: [...db.columns, { id: 'owner', name: 'Owner', type: 'text' }] };
  };
  const header = (name: string) => within(screen.getByRole('columnheader', { name: new RegExp(name) })).getByRole('button', { name });

  it('take a new name but keep their type and stay', () => {
    render(<Harness initial={withOwner()} states={states} viewId={TASK_VIEW.table} />);
    fireEvent.click(header('Status'));
    const menu = screen.getByRole('menu', { name: 'Status column' });
    expect(within(menu).queryByRole('menuitem', { name: /^Type/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Delete column' })).toBeNull();
    const name = within(menu).getByRole('textbox', { name: 'Column name' });
    fireEvent.change(name, { target: { value: 'Stage' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(edits).toHaveBeenLastCalledWith([{ op: 'column.update', id: 'status', patch: { name: 'Stage' } }], 'Renamed column');
  });

  it('leave a column a person added free to change', () => {
    render(<Harness initial={withOwner()} states={states} viewId={TASK_VIEW.table} />);
    fireEvent.click(header('Owner'));
    const menu = screen.getByRole('menu', { name: 'Owner column' });
    expect(within(menu).getByRole('menuitem', { name: /^Type/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete column' })).toBeTruthy();
  });
});
