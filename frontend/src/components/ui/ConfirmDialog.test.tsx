import React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ConfirmDialogHost, confirmDialog } from './ConfirmDialog';
import { DrawerShell } from './DrawerShell';

afterEach(cleanup);

function DrawerWithConfirmHost() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <DrawerShell open={open} motion="instant" onClose={() => setOpen(false)} title="Artifacts">
        Artifact list
      </DrawerShell>
      <ConfirmDialogHost />
    </>
  );
}

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

  it('cancels only the confirmation on the first Escape and closes its drawer on the next', async () => {
    render(<DrawerWithConfirmHost />);
    let result: Promise<boolean>;
    act(() => {
      result = confirmDialog({ title: 'Delete artifact', message: 'Delete this artifact?' });
    });
    expect(screen.getByRole('dialog', { name: 'Delete artifact' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    await expect(result!).resolves.toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Delete artifact' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Artifacts' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Artifacts' })).toBeNull();
  });

  it('lets Escape close the drawer when no confirmation is pending', () => {
    render(<DrawerWithConfirmHost />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Artifacts' })).toBeNull();
  });
});
