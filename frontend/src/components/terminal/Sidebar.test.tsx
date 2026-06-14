import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TerminalSidebar from './Sidebar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';

function wrap(ui: React.ReactElement) {
  return (
    <PrefsProvider>
      <ChatProvider>{ui}</ChatProvider>
    </PrefsProvider>
  );
}

describe('TerminalSidebar BottomNav', () => {
  it('renders Map / Digest / Workspaces / Home / Settings as labelled rows', () => {
    render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          onNav={() => {}}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    // getByText throws if missing — finding the element is the assertion.
    expect(screen.getByText('Map')).toBeTruthy();
    expect(screen.getByText('Digest')).toBeTruthy();
    expect(screen.getByText('Workspaces')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('navigates to the home page when the Home row is clicked', () => {
    const onNav = vi.fn();
    render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          onNav={onNav}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    fireEvent.click(screen.getByText('Home'));
    expect(onNav).toHaveBeenCalledWith('home');
  });

  it('renders collapsed at width 0 with aria-hidden when sidebarCollapsed is true (wide mode)', () => {
    localStorage.setItem(
      'michi:v1:prefs',
      JSON.stringify({ sidebarCollapsed: true }),
    );
    const { container } = render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          onNav={() => {}}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    // Sidebar stays mounted at width 0 so the open/close transition can play;
    // it's hidden from a11y and pointer events while collapsed.
    const aside = container.querySelector('aside') as HTMLElement | null;
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute('aria-hidden')).toBe('true');
    localStorage.removeItem('michi:v1:prefs');
  });

  it('does not render the legacy ASCII glyphs in the BottomNav', () => {
    const { container } = render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          onNav={() => {}}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/⎇/);
    expect(text).not.toMatch(/§/);
    expect(text).not.toMatch(/▢/);
    expect(text).not.toMatch(/⚙/);
  });
});

describe('TerminalSidebar pane indicator', () => {
  it('paints no streaming bar when no panes are open', () => {
    const { container } = render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          onNav={() => {}}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    // Streaming bars use the tpulse keyframe in their inline animation prop.
    // Without seeded openPanes, no row should paint a pulsing bar.
    const animated = container.querySelectorAll(
      '[aria-hidden][style*="tpulse"]',
    );
    expect(animated.length).toBe(0);
  });
});
