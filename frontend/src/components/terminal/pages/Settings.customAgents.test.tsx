import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalSettings from './Settings';

const mocks = vi.hoisted(() => ({
  activeProject: null as { id: string; backendConnectionId?: string } | null,
  refreshAgentStatus: vi.fn(),
  broadcastAgentStatusChanged: vi.fn(),
  setCustomAgentsEnabled: vi.fn(async () => ({ ok: true, customAgentsEnabled: false })),
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: mocks.activeProject,
    projects: [],
    agentStatus: { customAgentsEnabled: true },
    refreshAgentStatus: mocks.refreshAgentStatus,
  }),
  useStructuralSelector: () => 0,
}));
vi.mock('../../../services/auth', () => ({ useAuthSession: () => null }));
vi.mock('../../../services/api', () => ({
  setCustomAgentsEnabled: mocks.setCustomAgentsEnabled,
}));
vi.mock('../../../state/agentStatusSync', () => ({
  broadcastAgentStatusChanged: mocks.broadcastAgentStatusChanged,
}));
vi.mock('./settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
vi.mock('./settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('./settings/ConnectionsPane', () => ({ ConnectionsPane: () => <div>Connections pane</div> }));
vi.mock('./settings/NotificationsPane', () => ({ NotificationsPane: () => <div>Notifications pane</div> }));
vi.mock('./settings/ShortcutsPane', () => ({ ShortcutsPane: () => <div>Shortcuts pane</div> }));
vi.mock('./settings/AccountPane', () => ({ AccountPane: () => <div>Account pane</div> }));

afterEach(() => {
  cleanup();
  mocks.activeProject = null;
  vi.clearAllMocks();
});

describe('Settings Custom Agents category', () => {
  it('renders Custom Agents as a peer settings category', () => {
    render(<TerminalSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom Agents' }));

    expect(screen.getByRole('heading', { name: 'Custom Agents' })).not.toBeNull();
  });

  it('updates the backend feature gate and refreshes its authoritative status', async () => {
    render(<TerminalSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom Agents' }));
    await waitFor(() => expect(mocks.refreshAgentStatus).toHaveBeenCalledExactlyOnceWith());
    mocks.refreshAgentStatus.mockClear();

    fireEvent.click(screen.getByRole('switch', { name: 'Show Custom Agents' }));

    await waitFor(() => {
      expect(mocks.setCustomAgentsEnabled).toHaveBeenCalledExactlyOnceWith(false, 'local');
      expect(mocks.refreshAgentStatus).toHaveBeenCalledExactlyOnceWith();
      expect(mocks.broadcastAgentStatusChanged).toHaveBeenCalledExactlyOnceWith('local');
    });
  });

  it('does not apply a stale mutation result after switching backend connections', async () => {
    let resolveUpdate!: (value: { ok: true; customAgentsEnabled: boolean }) => void;
    mocks.setCustomAgentsEnabled.mockImplementationOnce(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    const view = render(<TerminalSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom Agents' }));
    await waitFor(() => expect(mocks.refreshAgentStatus).toHaveBeenCalled());
    mocks.refreshAgentStatus.mockClear();

    fireEvent.click(screen.getByRole('switch', { name: 'Show Custom Agents' }));
    expect(mocks.setCustomAgentsEnabled).toHaveBeenCalledExactlyOnceWith(false, 'local');

    mocks.activeProject = { id: 'workspace-remote', backendConnectionId: 'remote-a' };
    view.rerender(<TerminalSettings />);
    await waitFor(() => expect(mocks.refreshAgentStatus).toHaveBeenCalledExactlyOnceWith());

    await act(async () => {
      resolveUpdate({ ok: true, customAgentsEnabled: false });
    });

    expect(screen.getByRole('switch', { name: 'Show Custom Agents' }).getAttribute('aria-checked')).toBe('true');
    expect(mocks.broadcastAgentStatusChanged).toHaveBeenCalledExactlyOnceWith('local');
  });
});
