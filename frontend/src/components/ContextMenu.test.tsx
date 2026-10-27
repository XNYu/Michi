import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('ContextMenu toolbar anchoring', () => {
  const rect = (height: number) => ({ x: 0, y: 0, top: 0, left: 0, right: 480, bottom: height, width: 480, height, toJSON: () => ({}) }) as DOMRect;
  const openAnchored = (menuHeight: number, triggerTop: number, triggerBottom: number, viewport: number) => {
    vi.stubGlobal('innerHeight', viewport);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(menuHeight));
    render(<ContextMenu x={100} y={triggerBottom + 6} anchorBottom={triggerTop - 6} menuKind="agents" onClose={() => {}}
      sections={[{ items: [{ id: 'a', label: 'Agent', run: () => {} }] }]} />);
    const menu = screen.getByRole('menu');
    return { top: parseFloat(menu.style.top), maxHeight: parseFloat(menu.style.maxHeight) };
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('caps a tall list to the space above instead of sliding over the trigger', () => {
    const { top, maxHeight } = openAnchored(900, 506, 530, 700);
    expect(top).toBe(8);
    expect(maxHeight).toBe(492);
    expect(top + maxHeight).toBeLessThanOrEqual(506);
  });
});

describe('ContextMenu description detail card', () => {
  const longText = 'Migrates static configurations to a shared settings catalog and prepares a code review. This sample agent is managed by the demo workspace.';
  const renderAgents = (clamped: boolean) => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('michi-menu-sublabel') && clamped ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('michi-menu-sublabel') ? 36 : 0;
    });
    render(<ContextMenu x={20} y={40} menuKind="agents" searchable onClose={() => {}}
      sections={[{ items: [
        { id: 'settings', label: 'settings-migration', glyph: '✓', sublabel: longText, run: () => {} },
        { id: 'plain', label: 'plain', run: () => {} },
      ] }]} />);
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('hides when the pointer leaves the list and skips descriptions that already fit', () => {
    vi.useFakeTimers();
    renderAgents(true);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /settings-migration/ }));
    act(() => { vi.advanceTimersByTime(250); });
    fireEvent.mouseLeave(screen.getByRole('menu').querySelector('.michi-menu-list')!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    cleanup();
    renderAgents(false);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /settings-migration/ }));
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
