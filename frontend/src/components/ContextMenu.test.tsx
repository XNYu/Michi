import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('ContextMenu confirmation', () => {
  const open = (searchable = false) => {
    const run = vi.fn();
    const onClose = vi.fn();
    const view = render(<ContextMenu x={20} y={40} searchable={searchable} onClose={onClose}
      sections={[{ items: [{ id: 'open', label: 'Open', keys: 'O', run }, { id: 'disabled', label: 'Disabled', disabled: true, run }] }]} />);
    return { ...view, run, onClose };
  };

  it('uses the context appearance and fires once after 160ms', () => {
    vi.useFakeTimers();
    const { run, onClose } = open();
    expect(screen.getByRole('menu').dataset.menu).toBe('context');
    expect(screen.getByRole('menu').classList.contains('term-glass')).toBe(false);
    const row = screen.getByRole('menuitem', { name: 'Open O' });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(row.classList.contains('ui-menu-blink')).toBe(true);
    act(() => { vi.advanceTimersByTime(159); });
    expect(run).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['workspace', 'agents'] as const)('keeps the %s picker on its own material', (menuKind) => {
    render(<ContextMenu x={20} y={40} menuKind={menuKind} searchable onClose={() => {}}
      sections={[{ items: [{ id: 'item', label: 'Item', run: () => {} }] }]} />);
    expect(screen.getByRole('menu').classList.contains('term-glass')).toBe(false);
  });

  it.each(['escape', 'outside', 'unmount', 'filter'])('cancels pending actions on %s', (dismiss) => {
    vi.useFakeTimers();
    const { run, unmount } = open(dismiss === 'filter');
    act(() => { vi.advanceTimersByTime(20); });
    fireEvent.click(screen.getByText('Open'));
    if (dismiss === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    if (dismiss === 'outside') fireEvent.mouseDown(document.body);
    if (dismiss === 'unmount') unmount();
    if (dismiss === 'filter') fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new query' } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(run).not.toHaveBeenCalled();
  });

  it('honors reduced motion and keeps disabled items inert', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const { run } = open();
    fireEvent.click(screen.getByText('Disabled'));
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'o' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
