import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import TerminalTrash from './Trash';
import { buildTrashSections, filterTrashSections, remainingDays, trashItemCount } from './trashModel';

const state = vi.hoisted(() => ({
  nodes: {} as Record<string, ChatNodeState>,
  projects: [] as Project[],
  ttl: 30,
  hydrated: true,
  restoreDeletion: vi.fn(), restoreProject: vi.fn(), purgeDeletionAsync: vi.fn(),
  emptyTrashAsync: vi.fn(), purgeProject: vi.fn(), selectProject: vi.fn(), openPane: vi.fn(),
  confirm: vi.fn(), success: vi.fn(), fetchWorkspace: vi.fn(),
}));
vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => state,
  useChatNodesSnapshot: () => state.nodes,
  chatLabel: (node: ChatNodeState) => node.messages[0]?.text || 'Untitled thread',
}));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => ({ prefs: { trashTTLDays: state.ttl } }) }));
vi.mock('../../../services/api', () => ({ fetchWorkspace: (...args: unknown[]) => state.fetchWorkspace(...args) }));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmDialog: (...args: unknown[]) => state.confirm(...args) }));
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => state.success(...args) } }));

const now = Date.now();
const day = 86_400_000;
function node(nodeId: string, projectId: string, group: string | undefined, age: number, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, projectId, title: nodeId, kind: 'chat', chatId: null, status: 'idle', messages: [], messagesLoaded: true, followUps: [], deletionGroupId: group, deletedAt: group ? now - age * day : undefined, ...extra } as ChatNodeState;
}
function project(id: string, name: string, deletedAt?: number): Project {
  return { id, name, chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1, deletedAt, cwd: `~/projects/${name}` };
}
function fixture() {
  state.projects = [project('m', 'michi'), project('f', 'designlab'), project('empty', 'TestCloud2', now - 8 * day), project('dead', 'Research', now - 3 * day)];
  state.nodes = {
    a: node('a', 'm', 'del-a', 0.01, { title: 'DeepSeek models', messages: [{ id: 'a-user', role: 'user', text: 'Compare these models.', toolCalls: [] }, { id: 'a-answer', role: 'assistant', text: '', blocks: [{ kind: 'answer', id: 'answer', rawText: 'A persisted answer.' }], toolCalls: [] }] }),
    child: node('child', 'm', 'del-a', 28, { parentNodeId: 'a', messagesLoaded: false, messageCount: 7 }),
    b: node('b', 'm', 'del-b', 1, { title: 'michi notes' }),
    c: node('c', 'f', 'del-c', 0.2, { title: 'Design review' }),
    archived: node('archived', 'm', 'arch-never-trash', 3),
    gone: node('gone', 'dead', 'del-gone', 2, { title: 'Research thread' }),
    live: node('live', 'dead', undefined, 0, { title: 'Still in workspace' }),
  };
  state.projects.forEach(item => { item.chatIds = Object.values(state.nodes).filter(node => node.projectId === item.id).map(node => node.nodeId); });
  state.projects[3].trees = [{ id: 'live-tree', rootNodeId: 'live', createdAt: 1, lastActiveAt: 1 }];
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture();
  state.ttl = 30;
  state.hydrated = true;
  state.confirm.mockResolvedValue(true);
  state.purgeDeletionAsync.mockResolvedValue({ purged: 1 });
  state.emptyTrashAsync.mockResolvedValue({ purged: 3 });
  state.purgeProject.mockResolvedValue(undefined);
  state.restoreDeletion.mockImplementation((id: string) => Object.values(state.nodes).find(node => node.deletionGroupId === id)?.nodeId ?? null);
});

describe('Trash data projection', () => {
  it('excludes archive groups, identifies subtree roots, and counts lazy messages without treating them as empty', () => {
    const sections = buildTrashSections(state.projects, state.nodes);
    const group = sections[0].groups.find(group => group.id === 'del-a')!;
    expect(group.root.nodeId).toBe('a');
    expect(group.members).toHaveLength(2);
    expect(group.messageCount).toBe(9);
    expect(sections.flatMap(section => section.groups).some(group => group.id.startsWith('arch-'))).toBe(false);
    expect(trashItemCount(sections)).toBe(5);
    expect(remainingDays(group, 30, now)).toBe(2);
    expect(remainingDays(group, 0, now)).toBeNull();
  });
  it('sorts within workspaces and retains a deleted workspace when its nested thread matches', () => {
    const sections = buildTrashSections(state.projects, state.nodes);
    const sorted = filterTrashSections(sections, '', true);
    expect(sorted.find(section => section.project.id === 'm')!.groups.map(group => group.id)).toEqual(['del-b', 'del-a']);
    expect(filterTrashSections(sections, 'research thread', false).map(section => section.project.id)).toEqual(['dead']);
    expect(filterTrashSections(sections, '~/projects/michi', false)).toHaveLength(1);
  });
});

describe('Trash page', () => {
  it('renders the grouped list, separate workspaces, totals, and retention', () => {
    render(<TerminalTrash />);
    expect(screen.getByRole('heading', { name: 'Trash', level: 1 })).toBeTruthy();
    expect(screen.getByLabelText('5 items')).toBeTruthy();
    expect(document.querySelectorAll('[data-trash-key]')).toHaveLength(5);
    expect(screen.getByText('Threads are kept for 30 days')).toBeTruthy();
    expect(screen.queryByText('archived')).toBeNull();
    expect(screen.getByText('9 messages')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Preview Research thread' })).toBeNull();
  });
  it('finds collapsed groups, highlights matches, retains collapse state and input identity', () => {
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'michi 2' }));
    expect(screen.queryByRole('button', { name: 'Preview DeepSeek models' })).toBeNull();
    const input = screen.getByRole('searchbox', { name: 'Search trash' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'DeepSeek' } });
    fireEvent.compositionEnd(input);
    expect(screen.getByRole('searchbox')).toBe(input);
    expect(document.querySelector('mark')?.textContent).toBe('DeepSeek');
    expect(screen.getByRole('status').textContent).toBe('1 result');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('button', { name: 'michi 2' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('sorts oldest-first and shows a separate no-results state', () => {
    render(<TerminalTrash />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort deleted items' }), { target: { value: 'oldest' } });
    expect(document.querySelector('[data-trash-key]')?.getAttribute('data-trash-key')).toBe('thread:del-b');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '<no match>' } });
    expect(screen.getByRole('heading', { name: 'No matching items' })).toBeTruthy();
    expect(screen.getByText('Nothing matches "<no match>".')).toBeTruthy();
  });
  it('previews persisted assistant blocks read-only without opening a pane or fetching loaded messages', () => {
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview DeepSeek models' }));
    const dialog = screen.getByRole('dialog', { name: 'Trash preview' });
    expect(within(dialog).getByText('A persisted answer.')).toBeTruthy();
    expect(within(dialog).getByText('Read only')).toBeTruthy();
    expect(state.fetchWorkspace).not.toHaveBeenCalled();
    expect(state.openPane).not.toHaveBeenCalled();
  });
  it('restores a nested deletion together with its workspace but only opens it on the toast action', () => {
    const onNav = vi.fn();
    render(<TerminalTrash onNav={onNav} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview Research' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }));
    expect(state.restoreProject).toHaveBeenCalledWith('dead');
    expect(state.restoreDeletion).toHaveBeenCalledWith('del-gone');
    expect(onNav).not.toHaveBeenCalled();
    state.success.mock.calls[0][1].action.onClick();
    expect(state.selectProject).toHaveBeenCalledWith('dead');
    expect(state.openPane).toHaveBeenCalledWith('gone');
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });
  it('restores a workspace without restoring its independently trashed threads', () => {
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Research' }));
    expect(state.restoreProject).toHaveBeenCalledWith('dead');
    expect(state.restoreDeletion).not.toHaveBeenCalled();
  });
  it('guards destructive operations, retains a failed thread row, and shows an inline error', async () => {
    let reject!: (error: Error) => void;
    state.purgeDeletionAsync.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for michi notes' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently...' }));
    await waitFor(() => expect(state.purgeDeletionAsync).toHaveBeenCalledWith('del-b'));
    expect((screen.getByRole('button', { name: 'Restore Design review' }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.confirm.mock.calls[0][0].message).toContain('This cannot be undone');
    await act(async () => reject(new Error('Connection unavailable')));
    expect(screen.getByRole('alert').textContent).toContain('Connection unavailable');
    expect(screen.getByRole('button', { name: 'Preview michi notes' })).toBeTruthy();
    expect(state.success).not.toHaveBeenCalled();
  });
  it('does not delete on cancellation and returns to a preview without stacking modals', async () => {
    state.confirm.mockResolvedValue(false);
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview michi notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete michi notes permanently' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(state.purgeDeletionAsync).not.toHaveBeenCalled();
  });
  it('empties threads before whole workspaces and stops when a backend operation fails', async () => {
    const calls: string[] = [];
    state.emptyTrashAsync.mockImplementation(async () => { calls.push('threads'); });
    state.purgeProject.mockImplementation(async (id: string) => { calls.push(id); });
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }));
    await waitFor(() => expect(state.success).toHaveBeenCalledWith('Trash emptied'));
    expect(calls).toEqual(['threads', 'empty', 'dead']);
    state.emptyTrashAsync.mockRejectedValue(new Error('Purge unavailable'));
    state.purgeProject.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Purge unavailable'));
    expect(state.purgeProject).not.toHaveBeenCalled();
  });
  it('shows loading until hydration finishes and never invents a retention deadline when disabled', () => {
    state.hydrated = false;
    state.ttl = 0;
    const view = render(<TerminalTrash />);
    expect(screen.getByRole('status', { name: 'Loading trash' })).toBeTruthy();
    expect(screen.queryByText('Trash is empty')).toBeNull();
    expect(screen.getByText('Automatic deletion is off')).toBeTruthy();
    state.hydrated = true;
    state.nodes = {};
    state.projects = [];
    view.rerender(<TerminalTrash />);
    expect(screen.getByRole('heading', { name: 'Trash is empty' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Empty trash' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a retryable preview error instead of claiming unloaded messages are empty', async () => {
    state.nodes.b = { ...state.nodes.b, messagesLoaded: false, messageCount: 4 };
    state.fetchWorkspace.mockRejectedValueOnce(new Error('Preview unavailable')).mockReturnValue(new Promise(() => {}));
    render(<TerminalTrash />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview michi notes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Preview unavailable'));
    expect(screen.queryByText('No messages in this thread.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.fetchWorkspace).toHaveBeenCalledTimes(2));
    const signal = state.fetchWorkspace.mock.calls[1][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});
