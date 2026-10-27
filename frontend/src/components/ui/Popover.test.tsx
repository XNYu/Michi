import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HoverTip, PopoverSurface } from './Popover';

describe('menu surface isolation', () => {
  it('only opts the requested surface into the exported menu tokens', () => {
    render(<>
      <PopoverSurface menuKind="workspace" role="menu">Workspace options</PopoverSurface>
      <PopoverSurface variant="tooltip" role="tooltip">Original icon hint</PopoverSurface>
      <PopoverSurface role="dialog">Original unrelated panel</PopoverSurface>
    </>);
    expect(screen.getByRole('menu').classList.contains('michi-menu')).toBe(true);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.classList.contains('michi-menu')).toBe(false);
    expect(tooltip.style.borderRadius).toBe('var(--ui-tooltip-radius)');
    expect(tooltip.style.fontSize).toBe('var(--fs-sm)');
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('michi-menu')).toBe(false);
    expect(dialog.style.borderRadius).toBe('var(--ui-popover-radius)');
  });
});

describe('HoverTip', () => {
  it('delays hover, shows immediately on focus, and hides on blur', () => {
    vi.useFakeTimers();
    try {
      render(<HoverTip label="Help" delayMs={400}><button type="button">?</button></HoverTip>);
      const anchor = screen.getByRole('button');
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.mouseEnter(anchor);
      act(() => { vi.advanceTimersByTime(399); });
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('tooltip').textContent).toContain('Help');

      fireEvent.mouseLeave(anchor);
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.focus(anchor);
      expect(screen.getByRole('tooltip').textContent).toContain('Help');
      fireEvent.blur(anchor);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes an open tip when disabled and never opens while disabled', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <HoverTip label="Help" delayMs={0}><button type="button">?</button></HoverTip>,
      );
      fireEvent.mouseEnter(screen.getByRole('button'));
      expect(screen.getByRole('tooltip')).toBeTruthy();

      rerender(<HoverTip label="Help" delayMs={0} disabled><button type="button">?</button></HoverTip>);
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.focus(screen.getByRole('button'));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the anchor ref and chains the anchor handlers', () => {
    let node: HTMLButtonElement | null = null;
    const onMouseEnter = vi.fn();
    render(
      <HoverTip label="Help" delayMs={0}>
        <button ref={(el) => { node = el; }} type="button" onMouseEnter={onMouseEnter}>?</button>
      </HoverTip>,
    );
    expect(node).toBe(screen.getByRole('button'));
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
  });
});
