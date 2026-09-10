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

  it('removes keyboard-triggered exits immediately and reports unmounts', () => {
    const presence = vi.fn();
    const drawer = (open: boolean) => <DrawerShell open={open} motion="instant" onClose={vi.fn()} title="Settings" onPresenceChange={presence}>Content</DrawerShell>;
    const view = render(drawer(true));
    view.rerender(drawer(false));
    expect(document.querySelector('.drawer-shell-panel')).toBeNull();
    expect(presence).toHaveBeenLastCalledWith(false);
    view.rerender(drawer(true));
    view.unmount();
    expect(presence).toHaveBeenLastCalledWith(false);
  });

  it('releases a retiring panel immediately when reduced motion is enabled', () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const drawer = (open: boolean) => <DrawerShell open={open} onClose={vi.fn()} title="Settings">Content</DrawerShell>;
    const view = render(drawer(true));
    view.rerender(drawer(false));
    act(() => { media.matches = true; media.dispatchEvent(new Event('change')); });
    expect(document.querySelector('.drawer-shell-panel')).toBeNull();
  });

  it('restores focus before making the closing panel inert and respects nested Escape handlers', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const close = vi.fn();
    const drawer = (open: boolean, closeOnEscape = true) => <DrawerShell open={open} closeOnEscape={closeOnEscape} onClose={close} title="Settings">Content</DrawerShell>;
    const view = render(drawer(true, false));
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    view.rerender(drawer(true));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
    view.rerender(drawer(false));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
