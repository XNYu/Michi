import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('slides the narrow drawer out as a ghost that is no longer a layer', async () => {
    const onClose = vi.fn();
    const ui = (open: boolean) => wrap(
      <TerminalSidebar activePage="dashboard" onNav={() => {}} narrowMode narrowOverlayOpen={open} onCloseOverlay={onClose} />,
    );
    const { container, rerender } = render(ui(false));
    expect(container.querySelector('aside')).toBeNull();

    rerender(ui(true));
    const aside = container.querySelector('aside') as HTMLElement;
    expect(aside.dataset.escapeLayer).toBe('shell');
    expect(aside.getAttribute('aria-hidden')).toBeNull();
    const scrim = aside.previousElementSibling as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(ui(false));
    // While it leaves: no Esc layer, out of the accessibility tree, inert, and
    // its scrim no longer closes anything.
    // (Exits resolve a frame later even with skipAnimations, setupTests.ts.)
    const ghost = container.querySelector('aside') as HTMLElement;
    expect(ghost).toBe(aside);
    expect(ghost.dataset.escapeLayer).toBeUndefined();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-escape-layer]')).toBeNull();
    fireEvent.mouseDown(ghost.previousElementSibling as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container.querySelector('aside')).toBeNull());
    expect(container.childElementCount).toBe(0);
  });

  it('closes the narrow drawer at once when a destination inside it is chosen', async () => {
    // The shell closes the drawer from the same click (handleNavWithClose).
    function Shell() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)}>Toggle drawer</button>
          <TerminalSidebar activePage="dashboard" onNav={() => setOpen(false)} narrowMode narrowOverlayOpen={open} onCloseOverlay={() => setOpen(false)} />
        </>
      );
    }
    const { container } = render(wrap(<Shell />));
    expect(container.querySelector('aside')).not.toBeNull();

    // A tap on a destination: no ghost, so the page it opens is the only copy.
    fireEvent.click(screen.getByText('Workspaces'));
    expect(container.querySelector('aside')).toBeNull();

    // Reopen, then choose with the keyboard.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Home' }), { key: 'Enter' });
    expect(container.querySelector('aside')).toBeNull();

    // A dismissal from outside the drawer still slides it out.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle drawer' }));
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(container.querySelector('aside')).toBeNull());
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
