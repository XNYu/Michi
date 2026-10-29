import React from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawerShell } from './DrawerShell';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function finishTransform(target: HTMLElement) {
  const event = createEvent.transitionEnd(target);
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  fireEvent(target, event);
}

describe('DrawerShell presence', () => {
  it('retains a closed panel until its own transform finishes, then releases native surfaces', () => {
    const presence = vi.fn();
    const drawer = (open: boolean) => <React.StrictMode><DrawerShell open={open} onClose={vi.fn()} title="Settings" onPresenceChange={presence}><span>Content</span></DrawerShell></React.StrictMode>;
    const view = render(drawer(true));
    const panel = screen.getByRole('dialog');
    expect(presence).toHaveBeenLastCalledWith(true);
    view.rerender(drawer(false));
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(presence).toHaveBeenLastCalledWith(true);
    finishTransform(screen.getByText('Content'));
    expect(panel.isConnected).toBe(true);
    finishTransform(panel);
    expect(panel.isConnected).toBe(false);
    expect(presence).toHaveBeenLastCalledWith(false);
  });

  it('cancels stale exit timers when reopened', () => {
    const drawer = (open: boolean) => <DrawerShell open={open} onClose={vi.fn()} title="Artifacts">Content</DrawerShell>;
    const view = render(drawer(true));
    view.rerender(drawer(false));
    act(() => vi.advanceTimersByTime(100));
    view.rerender(drawer(true));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('dialog').getAttribute('data-state')).toBe('open');
    view.rerender(drawer(false));
    act(() => vi.advanceTimersByTime(500));
    expect(document.querySelector('.drawer-shell-panel')).toBeNull();
  });
});

describe('DrawerShell non-modal', () => {
  it('leaves the page usable: no scrim, no aria-modal, no outside-click close', () => {
    const close = vi.fn();
    render(
      <>
        <button type="button">Page card</button>
        <DrawerShell open modal={false} onClose={close} title="Thread">Content</DrawerShell>
      </>,
    );
    const panel = screen.getByRole('dialog', { name: 'Thread' });
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(document.querySelector('.drawer-shell-scrim')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Page card' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('takes focus on open and returns it on close to where the user last was on the page', () => {
    const drawer = (open: boolean) => (
      <>
        <button type="button">First card</button>
        <button type="button">Second card</button>
        <DrawerShell open={open} modal={false} onClose={vi.fn()} title="Thread">Content</DrawerShell>
      </>
    );
    const view = render(drawer(false));
    screen.getByRole('button', { name: 'First card' }).focus();
    view.rerender(drawer(true));
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(panel);
    // The user moves on to another card while the drawer stays open…
    screen.getByRole('button', { name: 'Second card' }).focus();
    // …then comes back into the drawer and closes it.
    panel.focus();
    view.rerender(drawer(false));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second card' }));
  });
});

describe('DrawerShell modal focus', () => {
  it('cycles Tab within the panel and returns to its opener without resetting focus on rerender', () => {
    const drawer = (open: boolean) => <><button type="button">Open settings</button><DrawerShell open={open} onClose={() => {}} title="Settings"><input aria-label="Last field" /></DrawerShell></>;
    const view = render(drawer(false));
    const opener = screen.getByRole('button', { name: 'Open settings' });
    opener.focus();
    view.rerender(drawer(true));
    const panel = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('textbox', { name: 'Last field' });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.rerender(drawer(true));
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    view.rerender(drawer(false));
    expect(document.activeElement).toBe(opener);
  });

  it('does not trap Tab in a non-modal peek', () => {
    render(<DrawerShell open modal={false} onClose={() => {}} title="Thread"><input aria-label="Peek field" /></DrawerShell>);
    const field = screen.getByRole('textbox');
    field.focus();
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true);
  });
});

describe('DrawerShell close control', () => {
  it('can offer onClose as a leading back button instead of the trailing ×', () => {
    const close = vi.fn();
    render(<DrawerShell open closeControl="back" onClose={close} title="Settings">Content</DrawerShell>);
    const header = document.querySelector('.ui-overlay-header')!;
    const back = screen.getByRole('button', { name: 'Back' });
    expect(header.firstElementChild).toBe(back);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(header.textContent).not.toContain('▸');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(back);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
