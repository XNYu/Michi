import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

  it('keeps a dialog with no enabled controls keyboard focused', () => {
    render(<ModalShell open onClose={() => {}} aria-label="Loading"><button disabled>Wait</button></ModalShell>);
    act(() => vi.advanceTimersByTime(20));
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(panel);
  });
});
