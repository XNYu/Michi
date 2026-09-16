import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexBackendProjects,
  setActiveBackendConnectionId,
} from '../../../config/backendConnections';
import ProfilePage from './Profile';

const state = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
}));
const fetchProfileActivity = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth', () => ({
  useAuthSession: () => ({ user: { name: 'Test User', email: 'test@example.com', image: null } }),
}));
vi.mock('../../../services/signOut', () => ({ signOutAndReset: vi.fn() }));
vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({ projects: state.projects }),
  useNodesSelector: (selector: (nodes: Record<string, never>) => unknown) => selector({}),
}));
vi.mock('../../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { terminalPalette: 'bone' }, setPref: vi.fn() }),
}));
vi.mock('../../../services/api', () => ({
  fetchAgentStatus: vi.fn().mockResolvedValue({ providers: [] }),
  fetchProfileActivity,
  saveProviderKey: vi.fn(),
  clearProviderKey: vi.fn(),
}));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmDialog: vi.fn() }));

function project(id: string, backendConnectionId: string) {
  return {
    id,
    name: id,
    backendConnectionId,
    chatIds: [],
    edges: [],
    trees: [{ id: `${id}-tree`, rootNodeId: `${id}-root`, createdAt: 1, lastActiveAt: 1 }],
    activeTreeId: `${id}-tree`,
    artifacts: [],
    createdAt: 1,
  };
}

function snapshot(totalMessages: number) {
  return {
    totalNodes: 1,
    totalThreads: 1,
    totalBranches: 0,
    totalMessages,
    days: [{ dateKey: '2026-09-16', nodes: 1, branches: 0, messages: totalMessages }],
  };
}

describe('Profile activity backend scope', () => {
  beforeEach(() => {
    fetchProfileActivity.mockReset();
    state.projects = [project('local-workspace', 'local')];
    indexBackendProjects(state.projects as never);
    setActiveBackendConnectionId('local');
  });

  it('refreshes activity when the active backend changes while mounted', async () => {
    let resolveRemote: (value: ReturnType<typeof snapshot>) => void = () => {};
    const remoteSnapshot = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      resolveRemote = resolve;
    });
    fetchProfileActivity
      .mockResolvedValueOnce(snapshot(9))
      .mockReturnValueOnce(remoteSnapshot);
    const view = render(<ProfilePage />);
    expect(await screen.findByText(/1 nodes · 1 threads · 9 messages/)).not.toBeNull();

    state.projects = [project('remote-workspace', 'remote-a')];
    indexBackendProjects(state.projects as never);
    setActiveBackendConnectionId('remote-a');
    view.rerender(<ProfilePage />);

    await waitFor(() => expect(fetchProfileActivity).toHaveBeenCalledTimes(2));
    expect(fetchProfileActivity.mock.calls[1][1]).toMatchObject({ connectionId: 'remote-a' });
    expect(screen.queryByText(/9 messages/)).toBeNull();

    await act(async () => resolveRemote(snapshot(2)));
    expect(await screen.findByText(/1 nodes · 1 threads · 2 messages/)).not.toBeNull();
  });
});
