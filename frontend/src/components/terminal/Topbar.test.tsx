import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';

// Avoid hitting the version endpoint in tests but keep the rest of the API
// surface (chatStore needs listAgentModes/etc.).
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    triggerUpdate: vi.fn(),
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
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
