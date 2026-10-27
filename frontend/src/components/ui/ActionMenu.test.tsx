import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';

function setup() {
  const onClose = vi.fn();
  const selected = vi.fn();
  const view = render(<button type="button">More</button>);
  const anchor = screen.getByRole('button') as HTMLButtonElement;
  view.rerender(<><button type="button">More</button><ActionMenu anchor={anchor} onClose={onClose} label="Row actions" items={[
    { id: 'first', label: 'First', onSelect: selected },
    { id: 'disabled', label: 'Disabled', disabled: true, onSelect: selected },
    { id: 'last', label: 'Last', onSelect: selected, dividerBefore: true, danger: true },
  ]} /></>);
  return { anchor, onClose, selected };
}

describe('ActionMenu', () => {
  it('focuses enabled actions and navigates with arrows, Home and End', () => {
    setup();
    const first = screen.getByRole('menuitem', { name: 'First' });
    const last = screen.getByRole('menuitem', { name: 'Last' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('returns focus before running an action or dismissing with Escape', () => {
    const { anchor, onClose, selected } = setup();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Last' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(anchor);
    onClose.mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(anchor);
  });

  it.each(['resize', 'scroll', 'outside', 'Tab'])('dismisses on %s', (reason) => {
    const { onClose } = setup();
    if (reason === 'outside') fireEvent.pointerDown(document.body);
    else if (reason === 'Tab') fireEvent.keyDown(window, { key: 'Tab' });
    else fireEvent(window, new Event(reason));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
