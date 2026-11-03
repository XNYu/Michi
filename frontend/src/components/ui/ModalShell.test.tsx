import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnimatePresence } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalShell } from './ModalShell';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ModalShell shared focus lifecycle', () => {
  it('focuses native selects, cycles Tab and restores its trigger after rerenders', () => {
    const modal = (open: boolean) => <><button>Open dialog</button><ModalShell open={open} onClose={() => {}} aria-label="Options"><select aria-label="Choice"><option>One</option></select><button>Save</button></ModalShell></>;
    const view = render(modal(false));
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    opener.focus();
    view.rerender(modal(true));
    act(() => vi.advanceTimersByTime(20));
    const first = screen.getByRole('combobox');
    const last = screen.getByRole('button', { name: 'Save' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.rerender(modal(true));
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    view.rerender(modal(false));
    expect(document.activeElement).toBe(opener);
  });

  it('retains the opener when a child uses autoFocus', () => {
    const content = (open: boolean) => <><button>Open dialog</button><ModalShell open={open} onClose={() => {}} aria-label="Edit"><input aria-label="Name" autoFocus /></ModalShell></>;
    const view = render(content(false));
    const opener = screen.getByRole('button');
    opener.focus();
    view.rerender(content(true));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    view.rerender(content(false));
    expect(document.activeElement).toBe(opener);
  });

  it('uses the checked native radio as the group’s Tab boundary and skips hidden controls', () => {
    render(<ModalShell open onClose={() => {}} aria-label="Options"><button>First</button><label><input type="radio" name="choice" defaultChecked />All</label><label><input type="radio" name="choice" />Off</label><div style={{ display: 'none' }}><button>Hidden</button></div></ModalShell>);
    act(() => vi.advanceTimersByTime(20));
    const selected = screen.getByRole('radio', { name: 'All' });
    selected.focus();
    fireEvent.keyDown(selected, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('returns focus at close and leaves only an inert ghost while the panel fades out', async () => {
    vi.useRealTimers();
    const modal = (open: boolean) => <><button>Open dialog</button><ModalShell open={open} onClose={() => {}} title="Delete"><button>Confirm</button></ModalShell></>;
    const view = render(modal(false));
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    opener.focus();
    view.rerender(modal(true));
    expect(screen.getByRole('dialog', { name: 'Delete' })).toBeTruthy();
    view.rerender(modal(false));
    expect(document.activeElement).toBe(opener);
    // Escape routing and assistive tech no longer see a dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    const ghost = document.querySelector('.ui-modal-positioner');
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.ui-scrim--modal')?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(document.querySelector('.ui-modal-positioner')).toBeNull());
    expect(document.querySelector('.ui-scrim--modal')).toBeNull();
  });

  it('opens and closes on the spot with motion="none"', () => {
    const modal = (open: boolean) => <ModalShell open={open} onClose={() => {}} aria-label="Palette" motion="none"><input aria-label="Query" /></ModalShell>;
    const view = render(modal(true));
    const panel = screen.getByRole('dialog', { name: 'Palette' });
    expect(panel.style.opacity).not.toBe('0');
    expect((document.querySelector('.ui-scrim--modal') as HTMLElement).style.opacity).not.toBe('0');
    view.rerender(modal(false));
    expect(document.querySelector('.ui-modal-positioner')).toBeNull();
    expect(document.querySelector('.ui-scrim--modal')).toBeNull();
  });

  // motion="enter" lives in ModalShell.enter.test.tsx: it needs real timers.

  it('keeps a dialog with no enabled controls keyboard focused', () => {
    render(<ModalShell open onClose={() => {}} aria-label="Loading"><button disabled>Wait</button></ModalShell>);
    act(() => vi.advanceTimersByTime(20));
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(panel);
  });
});

describe('ModalShell closing', () => {
  beforeEach(() => vi.useRealTimers());

  it('fades out when its caller removes it inside AnimatePresence, holding what it showed', async () => {
    const onClose = vi.fn();
    const view = render(<><button>Open</button><AnimatePresence>{null}</AnimatePresence></>);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    view.rerender(<><button>Open</button><AnimatePresence><ModalShell key="m" open onClose={onClose} title="Preview"><p>Entry A</p></ModalShell></AnimatePresence></>);
    expect(screen.getByRole('dialog', { name: 'Preview' })).toBeTruthy();
    view.rerender(<><button>Open</button><AnimatePresence>{null}</AnimatePresence></>);
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Entry A').closest('[inert]')).not.toBeNull();
    // Its Escape is gone with it.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Entry A')).toBeNull());
  });

  it.each([
    ['after', false],
    ['before', true],
  ])('hands the scrim over when one modal closes as the next opens %s it', async (_order, incomingFirst) => {
    const setup = (open: boolean) => <ModalShell key="setup" open={open} onClose={() => {}} title="Setup">Setup</ModalShell>;
    const key = (open: boolean) => <ModalShell key="key" open={open} onClose={() => {}} title="Key">Key</ModalShell>;
    const pair = (first: boolean, second: boolean) => incomingFirst ? <>{key(second)}{setup(first)}</> : <>{setup(first)}{key(second)}</>;
    const view = render(pair(true, false));
    const setupScrim = document.querySelector('.ui-scrim--modal') as HTMLElement;
    view.rerender(pair(false, true));
    // In the same commit the outgoing scrim steps aside and the incoming one
    // is at full strength.
    expect(setupScrim.style.visibility).toBe('hidden');
    const visible = Array.from(document.querySelectorAll<HTMLElement>('.ui-scrim--modal')).filter((scrim) => scrim.style.visibility !== 'hidden');
    expect(visible).toHaveLength(1);
    expect(visible[0].style.opacity).toBe('1');
    await waitFor(() => expect(document.querySelectorAll('.ui-scrim--modal')).toHaveLength(1));
    expect(screen.getByRole('dialog', { name: 'Key' })).toBeTruthy();
  });

  it('hands over to a modal opened a moment after the first closed, and not to one long open', async () => {
    const view = render(<><ModalShell open onClose={() => {}} title="Settings">Settings</ModalShell><ModalShell open={false} onClose={() => {}} title="Confirm">Confirm</ModalShell></>);
    const settingsScrim = document.querySelector('.ui-scrim--modal') as HTMLElement;
    // A confirm over an open modal stacks on it.
    view.rerender(<><ModalShell open onClose={() => {}} title="Settings">Settings</ModalShell><ModalShell open onClose={() => {}} title="Confirm">Confirm</ModalShell></>);
    expect(settingsScrim.style.visibility).toBe('');
    // Settings closing later, the confirm long open: no hand-over.
    await new Promise((resolve) => setTimeout(resolve, 80));
    view.rerender(<><ModalShell open={false} onClose={() => {}} title="Settings">Settings</ModalShell><ModalShell open onClose={() => {}} title="Confirm">Confirm</ModalShell></>);
    expect(settingsScrim.style.visibility).toBe('');
  });
});
