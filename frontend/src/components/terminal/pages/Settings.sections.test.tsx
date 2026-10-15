import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TerminalSettings from './Settings';

const mocks = vi.hoisted(() => ({
  agentStatus: { customAgentsEnabled: true } as { customAgentsEnabled: boolean },
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: null,
    projects: [],
    agentStatus: mocks.agentStatus,
    refreshAgentStatus: vi.fn(),
  }),
  useStructuralSelector: () => 0,
}));
vi.mock('../../../services/auth', () => ({ useAuthSession: () => null }));
vi.mock('./settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
vi.mock('./settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('./settings/ConnectionsPane', () => ({ ConnectionsPane: () => <div>Connections pane</div> }));
vi.mock('./settings/NotificationsPane', () => ({ NotificationsPane: () => <div>Notifications pane</div> }));
vi.mock('./settings/ShortcutsPane', () => ({ ShortcutsPane: () => <div>Shortcuts pane</div> }));
vi.mock('./settings/AccountPane', () => ({ AccountPane: () => <div>Account pane</div> }));

afterEach(() => {
  cleanup();
  mocks.agentStatus = { customAgentsEnabled: true };
});

describe('Settings categories', () => {
  it('keeps local settings available but waits before mounting backend-dependent sections', () => {
    const view = render(<TerminalSettings workspaceReady={false} />);
    expect(screen.getByText('Appearance pane')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    expect(screen.getByRole('status').textContent).toContain('Loading workspaces');
    expect(screen.queryByText('Model pane')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    expect(screen.queryByText('Connections pane')).toBeNull();
    view.rerender(<TerminalSettings workspaceReady />);
    expect(screen.getByText('Connections pane')).toBeTruthy();
  });

  // Custom Agents / Agent Runs are switched on by the backend's environment
  // (MICHI_CUSTOM_AGENTS=1). Settings must not offer a way to turn them on —
  // not even a category — whatever the backend currently reports.
  it.each([true, false])('offers no Custom Agents category or switch (backend reports %s)', (enabled) => {
    mocks.agentStatus = { customAgentsEnabled: enabled };
    render(<TerminalSettings />);

    const categories = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(categories).toEqual(['Appearance', 'Model', 'Connections', 'Notifications', 'Shortcuts']);
    expect(screen.queryByText(/custom agents/i)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
