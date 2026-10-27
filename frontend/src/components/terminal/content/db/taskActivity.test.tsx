import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MichiDatabase, MichiDbEditOp, MichiDbRow, PageChangeDto } from 'michi-shared';
import { TASK_VIEW } from 'michi-shared';
import { DatabaseView } from './DatabaseView';
import { applyOpsLocally } from './dbRead';
import { taskDatabase } from './dbTestData';
import { LiveThreadsContext, type LiveThreads } from './liveThreads';
import { originText, suggestionSummary, TaskActivityContext, TaskUpkeepLine, upkeepSummary, type TaskActivityView } from './taskActivity';

const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const live: LiveThreads = { byNode: new Map(), loaded: true, failed: false, workspaceId: 'ws', workspaceName: 'Release work' };
const task = (id: string, values: MichiDbRow['values'], position: number): MichiDbRow => ({ id, values, position, updatedAt: NOW - 60_000 });
const rows = [
  task('t1', { task: 'Ship the release', status: 'done' }, 0),
  task('t2', { task: 'Write the release notes', status: 'todo' }, 1),
  task('t3', { task: 'Review the docs', status: 'doing' }, 2),
];
const suggestion: PageChangeDto = {
  id: 'chg-docs', seq: 7, batchId: 'batch-upkeep', target: { kind: 'row', databaseId: 'db-tasks', rowId: 't3', columnIds: ['next', 'status'] }, op: 'row',
  before: null, after: null,
  forward: { kind: 'row', op: 'patch', id: 't3', values: { status: 'waiting', next: 'Confirm the screenshots' } },
  inverse: { kind: 'row', op: 'patch', id: 't3', values: { status: 'doing', next: null } },
  baseRev: 2, appliedRev: null, previousHeadId: null,
  source: { kind: 'maintenance', nodeId: 'run', turnId: 'run-turn', assistantId: 'run-a', jobId: 'job', runId: 'run-1', evidence: [{ nodeId: 'n1', turnId: 't-1', assistantId: 'a-1' }] },
  proposalState: 'pending', applicationState: null, createdAt: NOW - 120_000, resolvedAt: null,
};

function Harness({ view }: { view: TaskActivityView }) {
  const [db, setDb] = useState<MichiDatabase>(taskDatabase(rows));
  const [viewId, setViewId] = useState<string | null>(TASK_VIEW.board);
  const edit = async (ops: MichiDbEditOp[]) => { setDb((d) => applyOpsLocally(d, ops, 2)); return true; };
  return <TaskActivityContext.Provider value={view}><LiveThreadsContext.Provider value={live}>
    <DatabaseView db={db} edit={edit} viewId={viewId} onViewChange={setViewId} threadOf={() => undefined} now={NOW} services={{}} />
  </LiveThreadsContext.Provider></TaskActivityContext.Provider>;
}
const cardOf = (title: string) => screen.getByText(title).closest('.michi-card') as HTMLElement;

describe('what the Meta agent changed, on a task board', () => {
  it('says it in words', () => {
    expect(upkeepSummary({ added: 1, updated: 1, removed: 0, suggested: 0 })).toBe('Meta agent added 1 task and updated 1');
    expect(upkeepSummary({ added: 0, updated: 2, removed: 1, suggested: 1 })).toBe('Meta agent updated 2 tasks, removed 1 and suggested 1 change');
    expect(upkeepSummary({ added: 0, updated: 0, removed: 0, suggested: 2 })).toBe('Meta agent suggested 2 changes');
    expect(originText({ by: 'meta-agent', conversations: 3 })).toBe('Created by Meta agent from 3 conversations');
    expect(originText({ by: 'agent', conversations: 1 })).toBe('Created by an agent from 1 conversation');
    expect(originText({ by: 'agent', conversations: 0 })).toBe('Created by an agent');
    expect(originText({ by: 'you', conversations: 2 })).toBe('Created by you');
    const db = taskDatabase(rows);
    expect(suggestionSummary(db, suggestion)).toBe('Suggested: Status → Waiting on you · Next step → Confirm the screenshots');
    expect(suggestionSummary(db, { ...suggestion, forward: { kind: 'row', op: 'delete', id: 't3', expectedLocation: { position: 2, after: 't2' } } }))
      .toBe('Suggested: remove this task');
  });

  it('marks a card New, Updated or Suggestion', () => {
    render(<Harness view={{ markOf: (id) => (id === 't1' ? 'updated' : id === 't2' ? 'new' : null), suggestionsOf: (id) => (id === 't3' ? [suggestion] : []) }} />);
    expect(cardOf('Ship the release').querySelector('[data-mark="updated"]')?.textContent).toBe('Updated');
    expect(cardOf('Write the release notes').querySelector('[data-mark="new"]')?.textContent).toBe('New');
    expect(cardOf('Review the docs').querySelector('[data-mark="suggestion"]')?.textContent).toBe('Suggestion');
    expect(cardOf('Review the docs').querySelector('[data-mark="new"], [data-mark="updated"]')).toBeNull();
  });

  it("reads a card's marks out with its title", () => {
    render(<Harness view={{ markOf: (id) => (id === 't1' ? 'updated' : null), suggestionsOf: (id) => (id === 't1' ? [suggestion] : []) }} />);
    const described = (cardOf('Ship the release').getAttribute('aria-describedby') ?? '').split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('SuggestionUpdated');
  });

  it("opens a task's details on its suggestion, its workspace and who made it", async () => {
    const seen = vi.fn();
    const loadOrigin = vi.fn(async () => ({ by: 'meta-agent' as const, conversations: 3, at: Date.now() - 120_000 }));
    render(<Harness view={{
      markOf: (id) => (id === 't3' ? 'updated' : null),
      suggestionsOf: (id) => (id === 't3' ? [suggestion] : []),
      renderSuggestion: (change) => <button type="button">Accept {change.id}</button>,
      seen, loadOrigin,
    }} />);
    fireEvent.click(screen.getByText('Review the docs'));
    const drawer = screen.getByRole('dialog', { name: 'Task' });
    expect(within(drawer).getByText('Suggested: Status → Waiting on you · Next step → Confirm the screenshots')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Accept chg-docs' })).toBeTruthy();
    expect([...drawer.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Workspace', 'Status', 'Next step']);
    expect(within(drawer).getByText('Release work')).toBeTruthy();
    await waitFor(() => expect(drawer.querySelector('.michi-db-peek__origin')?.textContent).toBe('Created by Meta agent from 3 conversations · 2m ago'));
    expect(loadOrigin).toHaveBeenCalledWith('t3');
    expect(seen).toHaveBeenCalledWith('t3');
  });

  it("notes the latest update above the board, with Undo while any of it was written", () => {
    const onUndo = vi.fn();
    const onOpenSource = vi.fn();
    const upkeep = { batchId: 'b1', at: NOW - 300_000, added: 1, updated: 1, removed: 0, suggested: 0,
      source: { nodeId: 'n1', turnId: 't1', assistantId: 'a1', title: 'Release check' } };
    const { rerender } = render(<TaskUpkeepLine upkeep={upkeep} now={NOW} onUndo={onUndo} onOpenSource={onOpenSource} />);
    // Only the summary is announced; the age beside it changes every minute and stays out of the live region.
    expect(screen.getByRole('status').textContent).toBe('Meta agent added 1 task and updated 1');
    const line = screen.getByRole('status').closest('.michi-task-upkeep') as HTMLElement;
    expect(line.textContent).toContain('5m ago');
    fireEvent.click(within(line).getByRole('button', { name: '“Release check”' }));
    expect(onOpenSource).toHaveBeenCalledWith(upkeep.source);
    fireEvent.click(within(line).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    rerender(<TaskUpkeepLine upkeep={{ ...upkeep, added: 0, updated: 0, suggested: 2, source: null }} now={NOW} onUndo={onUndo} />);
    expect(screen.getByRole('status').textContent).toBe('Meta agent suggested 2 changes');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
