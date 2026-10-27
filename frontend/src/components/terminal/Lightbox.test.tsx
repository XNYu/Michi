import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DrawerShell } from '../ui/DrawerShell';
import { Lightbox } from './Lightbox';

describe('Lightbox focus', () => {
  it('focuses a reachable close button, traps Tab, and restores the image trigger', () => {
    const onClose = vi.fn();
    const view = render(<button type="button">View image</button>);
    const opener = screen.getByRole('button');
    opener.focus();
    view.rerender(<><button type="button">View image</button><Lightbox src="image.png" onClose={onClose} /></>);
    const close = screen.getByRole('button', { name: 'Close image viewer' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<button type="button">View image</button>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View image' }));
  });

  it('owns Escape and focus while displayed over a modal drawer', () => {
    const closeDrawer = vi.fn();
    const closeImage = vi.fn();
    const view = render(<DrawerShell open onClose={closeDrawer} title="Artifacts"><button>Image</button></DrawerShell>);
    screen.getByRole('button', { name: 'Image' }).focus();
    view.rerender(<DrawerShell open onClose={closeDrawer} title="Artifacts"><button>Image</button><Lightbox src="image.png" onClose={closeImage} /></DrawerShell>);
    const close = screen.getByRole('button', { name: 'Close image viewer' });
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(closeImage).toHaveBeenCalledOnce();
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});
