import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { ProgressCardDto } from 'michi-shared';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { resetSpaceConversationBadgesForTests } from '../../state/spaceConversations/watcher';

const cards = vi.hoisted(() => {
  let data: unknown[] = [];
  const listeners = new Set<() => void>();
  return {
    get: () => data,
    set(next: unknown[]) { data = next; for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});

// The shell owns the watcher: it keeps working without the topbar.
vi.mock('./Topbar', () => ({ default: () => null }));
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/Scheduled', () => ({ default: () => <div>Scheduled page</div> }));
vi.mock('./pages/settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/spaceConversations/runner', () => ({ useSpaceConversationRunner: () => {} }));
vi.mock('../../state/pages/useSpacesHome', async () => {
  const actual = await vi.importActual<typeof import('../../state/pages/useSpacesHome')>('../../state/pages/useSpacesHome');
  return {
    ...actual,
    useProgressCards: () => ({
      data: React.useSyncExternalStore(cards.subscribe, cards.get, cards.get) as ProgressCardDto[],
      status: 'ready', error: null, stale: false, refresh: () => {},
    }),
  };
});
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      activeProject: null, activeProjectId: null, projects: [], order: [], edges: [], theme: 'light', availableModes: [],
      agentStatus: null, warmFailedError: null, focusedNodeId: null, selection: new Set<string>(), hydrated: true,
      treeSelection: new Set<string>(), searchHighlightTerm: null,
    }),
    useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatActions: () => ({
      createProject: vi.fn(), enterChatsWorkspace: () => Promise.resolve('chats-default'), focusPane: () => {}, closePane: () => {},
      openPane: () => {}, createBlankChild: vi.fn(), restoreLastDeletion: vi.fn(), clearSelection: () => {}, clearTreeSelection: () => {},
      selectAllTrees: () => {}, selectProject: () => {}, revealBackendNode: vi.fn(async () => true),
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: () => ({}),
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

const card = (status: ProgressCardDto['status']): ProgressCardDto => ({
  threadNodeId: 'n-live', startedFromPageId: 'p1', workspaceId: 'ws-1', workspaceName: 'rabbitholes', treeId: null,
  title: '跑完事务回滚用例', runtimeId: 'claude', status, summary: null, createdAt: 1, seenAt: null, dismissedAt: null, expiresAt: null,
});
const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;

describe('TerminalShell: chats started from a Space, watched from every area', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    resetSpaceConversationBadgesForTests();
    cards.set([]);
  });

  it.each([
    ['scheduled', 'Scheduled page'],
    ['settings', 'Appearance pane'],
  ])('shows the running dot, then the toast and the done dot, while %s is open', async (area, shown) => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail(area));
    expect(await screen.findByText(shown)).toBeTruthy();

    act(() => cards.set([card('running')]));
    await waitFor(() => expect(rail('scheduled').querySelector('.area-rail__dot[data-tone="run"]')).toBeTruthy());

    act(() => cards.set([card('done')]));
    await waitFor(() => expect(success).toHaveBeenCalledWith('New chat “跑完事务回滚用例” finished', expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) })));
    await waitFor(() => expect(rail('conversations').querySelector('.area-rail__dot[data-tone="done"]')).toBeTruthy());
    expect(rail('scheduled').querySelector('.area-rail__dot[data-tone="run"]')).toBeNull();
    success.mockRestore();
  });
});
