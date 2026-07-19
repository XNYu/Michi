import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';

// Avoid hitting the version endpoint in tests but keep the rest of the API
// surface (chatStore needs listAgentModes/listModels/etc.).
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    triggerUpdate: vi.fn(),
    listAgentModes: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
  };
});

// Hide the Electron bridge.
vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => null,
}));

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

beforeEach(() => {
  if (typeof window !== 'undefined') window.localStorage.clear();
});

describe('TerminalTopbar', () => {
  const baseProps = {
    page: 'dashboard' as const,
    onNav: () => {},
    sidebarCollapsed: false,
    onToggleSidebar: () => {},
  };

  it('renders the sidebar toggle button always', () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    expect(screen.getByLabelText(/sidebar/i)).toBeTruthy();
  });

  it('does not render any tab strip on dashboard', () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} page="dashboard" />
      </Wrap>,
    );
    // No role="tab" anywhere in the topbar — TabStrip is gone.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    // The middle zone is empty on dashboard — no workspace title.
    expect(screen.queryByText('DASHBOARD')).toBeNull();
  });

  it('does not render the workspace title pill on map page when no active project', () => {
    // showWorkspaceTitle = !!activeProject && (page === 'map' || page === 'digest')
    // With no active project (cleared localStorage), the pill must not appear.
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} page="map" />
      </Wrap>,
    );
    expect(screen.queryByText('MAP')).toBeNull();
  });

  it('does not render the deleted map/digest topbar buttons', () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    expect(screen.queryByText(/⎇ map/i)).toBeNull();
    expect(screen.queryByText(/§ digest/i)).toBeNull();
  });

  it('does not render the deleted cwd/tree crumb', () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    // The cwd block had a leading "~" character and "›" separator. Both gone.
    expect(screen.queryByTitle(/^\/.*$/)).toBeNull();
  });

  it('renders the Artifacts drawer trigger button', () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    expect(screen.getByTitle(/Artifacts/)).toBeTruthy();
  });

  it('dispatches michi:toggle-artifacts when the Artifacts button is clicked', () => {
    const spy = vi.fn();
    window.addEventListener('michi:toggle-artifacts', spy);
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    fireEvent.click(screen.getByTitle(/Artifacts/));
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('michi:toggle-artifacts', spy);
  });

  // getElectron is mocked to null above, so showBrowserBrand is true and the
  // Michi brand renders as a clickable home affordance.
  it('navigates home when the browser-mode brand is clicked', () => {
    const onNav = vi.fn();
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} onNav={onNav} />
      </Wrap>,
    );
    fireEvent.click(screen.getByLabelText('Go home'));
    expect(onNav).toHaveBeenCalledWith('home');
  });
});
