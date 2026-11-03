import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';

describe('BottomSheet presence', () => {
  it('returns focus at close and drops away as an inert ghost that is no longer a dialog', async () => {
    const sheet = (open: boolean) => <><button type="button">Actions</button><BottomSheet open={open} onClose={() => {}} aria-label="Workspace actions"><button type="button">Rename</button></BottomSheet></>;
    const view = render(sheet(false));
    const opener = screen.getByRole('button', { name: 'Actions' });
    opener.focus();
    view.rerender(sheet(true));
    expect(screen.getByRole('dialog', { name: 'Workspace actions' })).toBeTruthy();
    view.rerender(sheet(false));
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
    const ghost = document.querySelector('.ui-sheet');
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    await waitFor(() => expect(document.querySelector('.ui-sheet')).toBeNull());
    expect(document.querySelector('.ui-scrim--modal')).toBeNull();
  });

  it('closes on a tap that started on the scrim, not on the release of the opening press', () => {
    const close = vi.fn();
    render(<BottomSheet open onClose={close} aria-label="Actions">Content</BottomSheet>);
    const scrim = document.querySelector('.ui-scrim--modal') as HTMLElement;
    fireEvent.click(scrim);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(close).toHaveBeenCalledOnce();
  });
});
