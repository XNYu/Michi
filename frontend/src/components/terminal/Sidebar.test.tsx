import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
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
  it('renders Home / Workspaces as labelled rows and leaves Scheduled, Spaces and Settings to the rail', () => {
    render(
      wrap(
        <TerminalSidebar
          activePage="dashboard"
          customAgentsEnabled
          onNav={() => {}}
          onOpenPalette={() => {}}
          onNewThread={() => {}}
        />,
      ),
    );
    // getByText throws if missing — finding the element is the assertion.
    expect(screen.getByText('Workspaces')).toBeTruthy();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Scheduled')).toBeNull();
    expect(screen.queryByText('Spaces')).toBeNull();
    // Branches / Map / Digest / Artifacts are thread-scoped views — their
    // entries moved to the Topbar right cluster (Artifacts removed 1a1348d0).
    expect(screen.queryByText('Branches')).toBeNull();
    expect(screen.queryByText('Map')).toBeNull();
    expect(screen.queryByText('Digest')).toBeNull();
    expect(screen.queryByText('Artifacts')).toBeNull();
  });

  it('gives the narrow drawer an Activity switch that the wide sidebar leaves to the Topbar', () => {
    const { rerender } = render(wrap(<TerminalSidebar activePage="dashboard" onNav={() => {}} />));
    expect(screen.queryByRole('button', { name: 'Activity view' })).toBeNull();

    rerender(wrap(<TerminalSidebar activePage="dashboard" onNav={() => {}} narrowMode narrowOverlayOpen />));
    const toggle = screen.getByRole('button', { name: 'Activity view' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Structure')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Activity')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('quiets sidebar scrollbars until the pointer enters, then lingers for 2s', () => {
    vi.useFakeTimers();
    try {
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
      const aside = container.querySelector('aside') as HTMLElement | null;
      expect(aside).not.toBeNull();
      expect(aside!.dataset.scrollbars).toBe('quiet');

      fireEvent.pointerEnter(aside!);
      expect(aside!.dataset.scrollbars).toBe('visible');

      fireEvent.pointerLeave(aside!);
      expect(aside!.dataset.scrollbars).toBe('visible');
      act(() => { vi.advanceTimersByTime(1999); });
      expect(aside!.dataset.scrollbars).toBe('visible');
      act(() => { vi.advanceTimersByTime(1); });
      expect(aside!.dataset.scrollbars).toBe('quiet');
    } finally {
      vi.useRealTimers();
    }
  });
});
