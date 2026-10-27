import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '../../state/chatTypes';
import { PageReceipt, resetPageReceiptInvalidationForTests } from './PageReceipt';

const openPagePane = vi.hoisted(() => vi.fn());
vi.mock('../../state/chatStore', () => ({ useOptionalChatActions: () => ({ openPagePane }) }));

function write(id: string, title: string, michiPageWrite: Record<string, unknown>, applied: unknown[] = []): ToolCallState {
  return {
    id, title, status: 'completed', kind: 'other', inputJson: '{}',
    output: JSON.stringify({
      result: { resource: { kind: michiPageWrite.resourceKind, id: michiPageWrite.resourceId }, applied, proposed: [], rejected: [] },
      michiPageWrite: { kind: 'michiPageWrite', ...michiPageWrite },
    }),
  } as ToolCallState;
}

afterEach(() => {
  cleanup();
  openPagePane.mockReset();
  resetPageReceiptInvalidationForTests();
});

describe('PageReceipt', () => {
  it('counts the tasks a write made and opens the page the same reply put the board on', () => {
    const tasks = write('t1', 'edit_database', {
      resourceKind: 'database', resourceId: 'db-t', title: 'Tasks', originatingPageIds: [],
      appliedCount: 3, proposedCount: 1, affectedTargetIds: ['row-1'], tasks: { added: 2, updated: 1, removed: 0 },
    });
    const board = write('t2', 'edit_page', { resourceKind: 'page', resourceId: 'pg-r', title: 'rabbitholes', appliedCount: 1, proposedCount: 0, affectedTargetIds: ['b-board'] },
      [{ id: 'c9', seq: 9, op: 'insert', after: { kind: 'block', exists: true, block: { type: 'task-view' } } }]);
    render(<PageReceipt tools={[tasks, board]} workspaceId="ws-r" backendConnectionId="local" />);
    expect([...document.querySelectorAll('.assistant-receipt__label')].map((label) => label.textContent))
      .toEqual(['Created 2 tasks, updated 1 · 1 waiting for you', 'Added a task board to rabbitholes']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
    expect(openPagePane).toHaveBeenCalledWith({ pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local', title: 'Tasks' });
  });

  it('keeps the place count under a reply for other writes', () => {
    const edit = write('t3', 'edit_page', { resourceKind: 'page', resourceId: 'pg-r', title: 'rabbitholes', appliedCount: 2, proposedCount: 0, affectedTargetIds: ['b1'] });
    render(<PageReceipt tools={[edit]} workspaceId="ws-r" backendConnectionId="local" variant="conversation" />);
    expect(document.querySelector('.assistant-receipt__label')!.textContent).toBe('Updated rabbitholes · 2 places');
  });
});
