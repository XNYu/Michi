import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MichiDbColumn, ThreadCardItem } from 'michi-shared';
import { CellEditor } from './CellEditor';
import { CellView } from './CellView';
import { LiveThreadsContext, type ConversationChoice, type LiveThreads } from './liveThreads';
import { batchColumns } from './RowsBatchBar';
import { taskDatabase } from './dbTestData';

const db = taskDatabase();
const column = db.columns.find((c) => c.id === 'threads') as MichiDbColumn;
const card = (nodeId: string, state: ThreadCardItem['state'], title: string): ThreadCardItem =>
  ({ nodeId, workspaceId: 'ws', title, state, summary: '', at: 1, messageId: null });
const choices: ConversationChoice[] = [
  { nodeId: 'a', title: 'Schema naming', state: 'waiting', at: 3 },
  { nodeId: 'b', title: 'Migration plan', state: null, at: 2 },
  { nodeId: 'c', title: 'Docs pass', state: 'done', at: 1 },
];
const withLive = (node: React.ReactNode, extra: Partial<LiveThreads> = {}) => (
  <LiveThreadsContext.Provider value={{ byNode: new Map([['a', card('a', 'waiting', 'Schema naming')]]), loaded: true, failed: false, workspaceId: 'ws',
    loadConversations: async () => choices, ...extra }}>{node}</LiveThreadsContext.Provider>
);

describe('a Conversations cell', () => {
  it('reads as conversation pills', () => {
    render(withLive(<CellView db={db} column={column} value={['a']} />, { open: vi.fn() }));
    expect(screen.getByRole('button', { name: /Schema naming/ })).toBeTruthy();
  });

  it('shows a pill that cannot be opened as plain text, so a click goes to the cell around it', () => {
    render(withLive(<CellView db={db} column={column} value={['a']} />));
    expect(screen.queryByRole('button', { name: /Schema naming/ })).toBeNull();
    expect(screen.getByText('Schema naming')).toBeTruthy();
  });

  it('links and unlinks conversations of the workspace, and saves them when the list closes', async () => {
    const onSave = vi.fn();
    render(withLive(<CellEditor db={db} column={column} value={['a']} onSave={onSave} onCancel={vi.fn()} />));
    await waitFor(() => expect(screen.getByRole('option', { name: /Migration plan/ })).toBeTruthy());
    expect(screen.getByRole('option', { name: /Schema naming/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: /Migration plan/ }));
    fireEvent.click(screen.getByRole('option', { name: /Schema naming/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a conversation' }), { target: { value: 'docs' } });
    expect(screen.queryByRole('option', { name: /Migration plan/ })).toBeNull();
    fireEvent.pointerDown(document.body);
    expect(onSave).toHaveBeenCalledWith(['b']);
  });

  it('gives up on Esc', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(withLive(<CellEditor db={db} column={column} value={[]} onSave={onSave} onCancel={onCancel} />));
    fireEvent.click(await screen.findByRole('option', { name: /Docs pass/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows a linked conversation outside the newest ones by its live title, and one gone as no longer here', async () => {
    render(withLive(<CellEditor db={db} column={column} value={['old', 'gone']} onSave={vi.fn()} onCancel={vi.fn()} />, {
      byNode: new Map([['old', card('old', 'done', 'Kickoff notes')]]),
    }));
    expect(await screen.findByRole('option', { name: /Kickoff notes/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /No longer here/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('lets a linked conversation outside the newest ones be unticked and ticked again', async () => {
    render(withLive(<CellEditor db={db} column={column} value={['old']} onSave={vi.fn()} onCancel={vi.fn()} />, {
      byNode: new Map([['old', card('old', 'done', 'Kickoff notes')]]),
    }));
    const option = async () => screen.findByRole('option', { name: /Kickoff notes/ });
    fireEvent.click(await option());
    expect((await option()).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(await option());
    expect((await option()).getAttribute('aria-selected')).toBe('true');
  });

  it('does nothing on Enter when what was typed matches nothing', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(withLive(<CellEditor db={db} column={column} value={['a']} onSave={onSave} onCancel={onCancel} />));
    const input = await screen.findByRole('textbox', { name: 'Find a conversation' });
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("offers the conversations of the row's own workspace", async () => {
    const loadConversations = vi.fn(async () => choices);
    const task = { id: 'db-b/t1', values: { task: 'Plan the launch', workspace: 'ws-b' }, position: 0, updatedAt: 1 };
    render(withLive(<CellEditor db={db} column={column} value={[]} row={task} onSave={vi.fn()} onCancel={vi.fn()} />, { workspaceId: null, loadConversations }));
    expect(await screen.findByRole('option', { name: /Migration plan/ })).toBeTruthy();
    expect(loadConversations).toHaveBeenCalledWith(task);
  });

  it('is linked one conversation at a time, never set for many rows at once', () => {
    expect(batchColumns(db).map((c) => c.id)).not.toContain('threads');
  });
});
