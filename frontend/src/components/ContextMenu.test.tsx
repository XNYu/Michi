import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnimatePresence } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu, { MenuPresence, menuOpenKey } from './ContextMenu';

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

  it('fades out inside AnimatePresence without taking keys, clicks or a pending confirmation', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const onClose = vi.fn();
    const menu = (shown: boolean) => <AnimatePresence>{shown && <ContextMenu key="menu" x={20} y={40} onClose={onClose}
      sections={[{ items: [{ id: 'open', label: 'Open', keys: 'O', run }] }]} />}</AnimatePresence>;
    const view = render(menu(true));
    act(() => { vi.advanceTimersByTime(20); });
    fireEvent.click(screen.getByText('Open'));
    // Closed by its caller mid-blink: the fading menu is no layer and never fires.
    view.rerender(menu(false));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    act(() => { vi.advanceTimersByTime(200); });
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByText('Open')).toBeNull());
  });

  it('mounts afresh when its opener reopens it during the fade-out', async () => {
    const menu = (anchor: { x: number; y: number } | null) => <AnimatePresence>{anchor && <ContextMenu key={menuOpenKey(anchor)} {...anchor} searchable onClose={() => {}}
      sections={[{ items: [{ id: 'a', label: 'Alpha', run: () => {} }, { id: 'b', label: 'Beta', run: () => {} }] }]} />}</AnimatePresence>;
    const view = render(menu({ x: 20, y: 40 }));
    const first = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(first, { target: { value: 'be' } });
    view.rerender(menu(null));
    // Same trigger, same place: a new anchor object, so a new menu.
    view.rerender(menu({ x: 20, y: 40 }));
    const second = screen.getByRole('textbox') as HTMLInputElement;
    expect(second).not.toBe(first);
    expect(second.value).toBe('');
    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(second.isConnected).toBe(true);
  });

  it('MenuPresence, mounted when its row first opens the menu, plays each fade-out', async () => {
    const menu = (shown: boolean) => <MenuPresence>{shown && <ContextMenu key="menu" x={20} y={40} onClose={() => {}}
      sections={[{ items: [{ id: 'open', label: 'Open', run: () => {} }] }]} />}</MenuPresence>;
    const view = render(menu(false));
    for (let round = 0; round < 2; round++) {
      view.rerender(menu(true));
      expect(screen.getByRole('menu')).toBeTruthy();
      view.rerender(menu(false));
      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByText('Open').closest('[aria-hidden="true"]')).not.toBeNull();
      await waitFor(() => expect(screen.queryByText('Open')).toBeNull());
    }
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

describe('ContextMenu filter on a touch screen', () => {
  const sections = (count: number) => [{ items: Array.from({ length: count }, (_, i) => ({ id: `agent-${i}`, label: `Agent ${i}`, run: vi.fn() })) }];
  const pointer = (coarse: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: coarse && query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {},
  })));

  it('shows no filter for a short list, so no keyboard rises over it', () => {
    pointer(true);
    render(<ContextMenu x={20} y={40} searchable sections={sections(4)} onClose={() => {}} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the filter for a long list without focusing it', () => {
    pointer(true);
    render(<ContextMenu x={20} y={40} searchable sections={sections(12)} onClose={() => {}} />);
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('focuses the filter for a pointer, as before', () => {
    pointer(false);
    render(<ContextMenu x={20} y={40} searchable sections={sections(4)} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });
});
