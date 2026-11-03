/**
 * motion="enter" (the command palette): fades and scales in like a standard
 * modal, closes on the spot with no ghost. Real timers throughout: once a file
 * runs on fake timers, motion's frame loop waits on a timer that never fires.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModalShell } from './ModalShell';

const modal = (open: boolean) => (
  <ModalShell open={open} onClose={() => {}} aria-label="Palette" motion="enter">
    <input aria-label="Query" />
  </ModalShell>
);

describe('ModalShell motion="enter"', () => {
  it('settles its entrance, then closes on the spot leaving no ghost', async () => {
    const view = render(modal(true));
    const panel = screen.getByRole('dialog', { name: 'Palette' });
    await waitFor(() => expect(panel.style.opacity).toBe('1'));
    expect(panel.style.transform).toBe('none');
    expect((document.querySelector('.ui-scrim--modal') as HTMLElement).style.opacity).toBe('1');

    view.rerender(modal(false));
    expect(document.querySelector('.ui-modal-positioner')).toBeNull();
    expect(document.querySelector('.ui-scrim--modal')).toBeNull();
  });
});
