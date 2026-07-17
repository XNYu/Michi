import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { ConfirmDialogHost, confirmDialog } from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('resolves true when the confirm button is clicked', async () => {
    render(<ConfirmDialogHost />);
    let result: Promise<boolean>;
    act(() => {
      result = confirmDialog({ title: 'Delete', message: 'Delete it?', confirmLabel: 'Delete' });
    });
    const btn = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(btn);
    await expect(result!).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    render(<ConfirmDialogHost />);
    let result: Promise<boolean>;
    act(() => {
      result = confirmDialog({ message: 'Sure?' });
    });
    const btn = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(btn);
    await expect(result!).resolves.toBe(false);
  });

  it('resolves the superseded confirm as false when a new one opens', async () => {
    render(<ConfirmDialogHost />);
    let first: Promise<boolean>;
    act(() => {
      first = confirmDialog({ message: 'first' });
    });
    act(() => {
      void confirmDialog({ message: 'second' });
    });
    // The first promise must not hang — it resolves false when superseded.
    await expect(first!).resolves.toBe(false);
    // The second dialog is the one now showing.
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
  });
});
