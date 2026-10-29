import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MichiDatabase, MichiDbEditOp, MichiDbRow, ThreadCardItem } from 'michi-shared';
import { TASK_VIEW } from 'michi-shared';
import { DatabaseView } from './DatabaseView';
import { applyOpsLocally, taskDatabase } from './dbTestData';
import { LiveThreadsContext, type ConversationChoice, type LiveThreads } from './liveThreads';

const NOW = new Date(2026, 9, 26, 15, 0).getTime();
const edits = vi.fn();
const open = vi.fn();
const card = (nodeId: string, state: ThreadCardItem['state'], title: string, summary = ''): ThreadCardItem =>
  ({ nodeId, workspaceId: 'ws', title, state, summary, at: NOW - 120_000, messageId: null });
const choices: ConversationChoice[] = [
  { nodeId: 'a', title: 'Schema naming', state: 'waiting', at: 3 },
  { nodeId: 'b', title: 'Migration plan', state: null, at: 2 },
];
const states: LiveThreads = {
  byNode: new Map([['a', card('a', 'waiting', 'Schema naming', 'Asked: Which one?')]]),
  loaded: true, failed: false, workspaceId: 'ws', open, loadConversations: async () => choices,
};

function Harness({ initial }: { initial: MichiDatabase }) {
  const [db, setDb] = useState(initial);
  const [view, setView] = useState<string | null>(TASK_VIEW.board);
  const edit = async (ops: MichiDbEditOp[], label: string) => {
    edits(ops, label);
    setDb((d) => applyOpsLocally(d, ops, 2));
    return true;
  };
  return <LiveThreadsContext.Provider value={states}>
    <DatabaseView db={db} edit={edit} viewId={view} onViewChange={setView} threadOf={() => undefined} now={NOW} services={{}} />
  </LiveThreadsContext.Provider>;
}

const task = (values: MichiDbRow['values'], edited?: Record<string, number>): MichiDbRow =>
  ({ id: 't1', values, position: 0, updatedAt: NOW - 60_000, ...(edited ? { edited } : {}) });
const details = (title: string) => {
  fireEvent.click(screen.getByText(title));
  return screen.getByRole('dialog', { name: 'Task' });
};

beforeEach(() => { edits.mockReset(); open.mockReset(); window.localStorage.clear(); });

describe('a task’s details', () => {
  it('shows a waiting conversation\'s own line without adding "Asked:"', () => {
    const approval: LiveThreads = { ...states, byNode: new Map([['a', card('a', 'waiting', 'Schema naming', 'Waiting for your approval: Run the migration')]]) };
    render(<LiveThreadsContext.Provider value={approval}>
      <DatabaseView db={taskDatabase([task({ task: 'Pick a schema naming rule', status: 'doing', threads: ['a'] }, { status: 1 })])} edit={async () => true} viewId={TASK_VIEW.board} onViewChange={() => {}} threadOf={() => undefined} now={NOW} services={{}} />
    </LiveThreadsContext.Provider>);
    const links = within(details('Pick a schema naming rule')).getByRole('region', { name: 'Conversations' });
    const text = within(links).getByRole('button', { name: /Schema naming/ }).textContent ?? '';
    expect(text).toContain('Waiting for your approval: Run the migration');
    expect(text).not.toContain('Asked:');
  });

  it('list its conversations as they stand, open one, and unlink one no longer here', () => {
    render(<Harness initial={taskDatabase([task({ task: 'Pick a schema naming rule', status: 'doing', threads: ['a', 'gone'] }, { status: 1 })])} />);
    const drawer = details('Pick a schema naming rule');
    // The links are a section of their own, not one of the properties.
    expect([...drawer.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Status', 'Next step']);
    expect(within(drawer).getByText('Set by you · the agent only suggests changes')).toBeTruthy();
    const links = within(drawer).getByRole('region', { name: 'Conversations' });
    const live = within(links).getByRole('button', { name: /Schema naming/ });
    expect(live.textContent).toContain('Asked: Which one?');
    fireEvent.click(live);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'a' }));
    expect(within(links).getByText('This conversation is no longer here')).toBeTruthy();
    fireEvent.click(within(links).getByRole('button', { name: 'Unlink' }));
    expect(edits).toHaveBeenLastCalledWith([{ op: 'row.update', id: 't1', values: { threads: ['a'] } }], 'Unlinked a conversation');
  });

  it('link conversations of the workspace from Link', async () => {
    render(<Harness initial={taskDatabase([task({ task: 'Write the migration', status: 'todo', threads: ['a'] })])} />);
    const links = within(details('Write the migration')).getByRole('region', { name: 'Conversations' });
    fireEvent.click(within(links).getByRole('button', { name: 'Link' }));
    fireEvent.click(await screen.findByRole('option', { name: /Migration plan/ }));
    fireEvent.pointerDown(document.body);
    expect(edits).toHaveBeenLastCalledWith([{ op: 'row.update', id: 't1', values: { threads: ['a', 'b'] } }], 'Linked conversations');
  });

  it('say an agent set a status a person has not changed, and nothing for one not set', () => {
    const { unmount } = render(<Harness initial={taskDatabase([task({ task: 'Ship docs', status: 'done' })])} />);
    expect(within(details('Ship docs')).getByText('Set by an agent from the conversations')).toBeTruthy();
    unmount();
    render(<Harness initial={taskDatabase([task({ task: 'Idea for later' })])} />);
    const drawer = details('Idea for later');
    expect(within(drawer).queryByText(/^Set by/)).toBeNull();
    expect(within(drawer).getByText('No conversations yet')).toBeTruthy();
  });
});
