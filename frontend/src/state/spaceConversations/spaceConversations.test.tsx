import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCardDto } from 'michi-shared';
import type { ChatNodeState } from '../chatTypes';

const mocks = vi.hoisted(() => ({
  activeProjectId: 'w1' as string | null,
  focusedPane: null as string | null,
  nodes: {} as Record<string, unknown>,
  cards: [] as unknown[],
  refresh: vi.fn(),
  selectProject: vi.fn(),
  createThread: vi.fn(),
  sendMessage: vi.fn(),
  createProgressCard: vi.fn(),
  markProgressCardSeen: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../chatStore', () => ({
  useChatProjects: () => ({ activeProjectId: mocks.activeProjectId, activeProject: mocks.activeProjectId ? { id: mocks.activeProjectId } : null }),
  useChatPanes: () => ({ focusedPane: mocks.focusedPane }),
  useChatActions: () => ({ selectProject: mocks.selectProject, createThread: mocks.createThread, sendMessage: mocks.sendMessage }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector(mocks.nodes),
  useChatNodesSnapshot: () => mocks.nodes,
}));
vi.mock('../pages/useSpacesHome', () => ({
  useProgressCards: () => ({ data: mocks.cards, status: 'ready', error: null, stale: false, refresh: mocks.refresh }),
}));
vi.mock('../../services/api/spacesHome', () => ({
  createProgressCard: mocks.createProgressCard,
  markProgressCardSeen: mocks.markProgressCardSeen,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { useSpaceConversationRunner } from './runner';
import { resetSpaceConversationBadgesForTests, useSpaceConversationBadges, useSpaceConversationWatcher } from './watcher';
import {
  closeNewChatSheet, currentScope, openNewChatSheet, readSpaceConversations, registerSpaceScope,
  requestSpaceConversation, resetSpaceConversationsForTests, lastUsedWorkspaceId,
} from './store';

const scope = { backendConnectionId: 'local', pageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', pageTitle: 'Michi 0.9 发布' };
const start = { text: '把 Intel 机器手测的步骤写出来', workspaceId: 'w2', workspaceName: 'agent-desk', backendConnectionId: 'local', startedFromPageId: 'p1' };

const card = (patch: Partial<ProgressCardDto> = {}): ProgressCardDto => ({
  threadNodeId: 'n1', startedFromPageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', treeId: 't1',
  title: 'Intel 手测', runtimeId: 'kiro', status: 'running', summary: null, createdAt: 1, seenAt: null, dismissedAt: null, expiresAt: null,
  ...patch,
});
const node = (patch: Partial<ChatNodeState> = {}) => ({
  nodeId: 'n1', kind: 'chat', projectId: 'w1', followUps: [], status: 'streaming',
  messages: [{ id: 'u', role: 'user', text: 'q', toolCalls: [] }, { id: 'a', role: 'assistant', text: '', toolCalls: [] }],
  ...patch,
});
const finished = () => node({ status: 'idle', messages: [{ id: 'u', role: 'user', text: 'q', toolCalls: [] }, { id: 'a', role: 'assistant', text: 'All six steps.', toolCalls: [] }] });

beforeEach(() => {
  resetSpaceConversationsForTests();
  resetSpaceConversationBadgesForTests();
  mocks.activeProjectId = 'w1';
  mocks.focusedPane = null;
  mocks.nodes = {};
  mocks.cards = [];
  for (const fn of [mocks.refresh, mocks.selectProject, mocks.createThread, mocks.sendMessage, mocks.createProgressCard, mocks.markProgressCardSeen, mocks.toastSuccess, mocks.toastError]) fn.mockReset();
  mocks.markProgressCardSeen.mockResolvedValue({});
});
afterEach(() => { vi.useRealTimers(); });

describe('the new-chat sheet store', () => {
  it('opens on the page on screen, in its workspace, or on Home in the last workspace used', () => {
    expect(openNewChatSheet()).toBe(false);
    const page = registerSpaceScope(scope);
    expect(openNewChatSheet({ text: 'Prefilled' })).toBe(true);
    expect(readSpaceConversations().sheet).toMatchObject({ scopeId: page.id, workspaceId: 'w1', text: 'Prefilled' });
    page.release();
    expect(readSpaceConversations().sheet).toBeNull();

    requestSpaceConversation(start);
    expect(lastUsedWorkspaceId()).toBe('w2');
    const home = registerSpaceScope({ ...scope, pageId: 'home', workspaceId: null, workspaceName: null, pageTitle: 'Home' });
    expect(currentScope()?.id).toBe(home.id);
    openNewChatSheet();
    expect(readSpaceConversations().sheet?.workspaceId).toBe('w2');
    openNewChatSheet({ text: 'From a next step', workspaceId: 'w3' });
    expect(readSpaceConversations().sheet).toMatchObject({ workspaceId: 'w3', text: 'From a next step' });
    closeNewChatSheet();
    expect(readSpaceConversations().sheet).toBeNull();
  });
});

describe('starting a conversation from a Space', () => {
  it('switches to its workspace, creates an ordinary thread, sends the message, then records the card', async () => {
    mocks.createThread.mockReturnValue('n-new');
    mocks.createProgressCard.mockRejectedValueOnce(Object.assign(new Error('not yet'), { status: 404 })).mockResolvedValue({});
    const onRegistered = vi.fn();
    const { rerender } = renderHook(() => useSpaceConversationRunner(onRegistered));
    act(() => { requestSpaceConversation(start); });
    expect(mocks.selectProject).toHaveBeenCalledWith('w2');
    expect(mocks.createThread).not.toHaveBeenCalled();

    mocks.activeProjectId = 'w2';
    rerender();
    expect(mocks.createThread).toHaveBeenCalledTimes(1);
    expect(mocks.createThread).toHaveBeenCalledWith();
    expect(mocks.sendMessage).toHaveBeenCalledWith('n-new', start.text);
    expect(readSpaceConversations().pending[0]).toMatchObject({ nodeId: 'n-new', startedFromPageId: 'p1' });
    await waitFor(() => expect(onRegistered).toHaveBeenCalled(), { timeout: 3000 });
    expect(mocks.createProgressCard).toHaveBeenCalledTimes(2);
    expect(mocks.createProgressCard).toHaveBeenLastCalledWith('n-new', 'p1', 'local');
    rerender();
    expect(mocks.createThread).toHaveBeenCalledTimes(1);
  });

  it('gives up when the workspace never becomes active', () => {
    vi.useFakeTimers();
    renderHook(() => useSpaceConversationRunner(vi.fn()));
    act(() => { requestSpaceConversation(start); });
    act(() => { vi.advanceTimersByTime(5_001); });
    expect(readSpaceConversations().pending).toHaveLength(0);
    expect(mocks.toastError).toHaveBeenCalled();
    expect(mocks.createThread).not.toHaveBeenCalled();
  });
});

describe('the shell watcher', () => {
  const onOpen = vi.fn();
  const watch = (page: 'space' | 'dashboard' = 'space') => renderHook(({ p }) => {
    useSpaceConversationWatcher({ page: p, onOpen });
    return useSpaceConversationBadges();
  }, { initialProps: { p: page } });

  it('shows the Scheduled dot while one runs, then the toast and the Conversations dot when it finishes elsewhere', () => {
    mocks.cards = [card()];
    mocks.nodes = { n1: node() };
    const { result, rerender } = watch();
    expect(result.current).toEqual({ scheduledRunning: true, conversationsDone: false });

    mocks.nodes = { n1: finished() };
    rerender({ p: 'space' });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('New chat “Intel 手测” finished', expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(result.current).toEqual({ scheduledRunning: false, conversationsDone: true });
    mocks.toastSuccess.mock.calls[0]![1].action.onClick();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ threadNodeId: 'n1' }));
  });

  it('marks a finished one seen once its conversation is on screen, with no toast there', async () => {
    mocks.cards = [card()];
    mocks.nodes = { n1: node() };
    mocks.focusedPane = 'n1';
    const { result, rerender } = watch('dashboard');
    mocks.nodes = { n1: finished() };
    rerender({ p: 'dashboard' });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.markProgressCardSeen).toHaveBeenCalledWith('n1', 'local');
    expect(result.current.conversationsDone).toBe(false);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it('does not toast for cards that were already finished, nor mark them seen until opened', () => {
    mocks.cards = [card({ status: 'done' })];
    const { result, rerender } = watch('dashboard');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.markProgressCardSeen).not.toHaveBeenCalled();
    expect(result.current.conversationsDone).toBe(true);
    mocks.focusedPane = 'n1';
    rerender({ p: 'dashboard' });
    expect(mocks.markProgressCardSeen).toHaveBeenCalledTimes(1);
  });
});
