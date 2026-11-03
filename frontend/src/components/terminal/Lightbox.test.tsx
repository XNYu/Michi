import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('Lightbox exit', () => {
  beforeEach(() => { MotionGlobalConfig.skipAnimations = true; });
  afterEach(() => { MotionGlobalConfig.skipAnimations = true; });

  function Thumbnail({ onClose }: { onClose?: () => void }) {
    const [zoom, setZoom] = React.useState(false);
    return <>
      <button type="button" onClick={() => setZoom(true)}>View image</button>
      {zoom && <Lightbox src="image.png" onClose={() => { onClose?.(); setZoom(false); }} />}
    </>;
  }

  it('closes at once and fades out as an inert copy, so tapping the same image again reopens it', async () => {
    MotionGlobalConfig.skipAnimations = false;
    const onClose = vi.fn();
    const pageEscape = vi.fn();
    window.addEventListener('keydown', pageEscape);
    try {
      render(<Thumbnail onClose={onClose} />);
      const opener = screen.getByRole('button', { name: 'View image' });
      opener.focus();
      fireEvent.click(opener);
      fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(opener);
      expect(screen.queryByRole('dialog')).toBeNull();
      await act(async () => { await Promise.resolve(); });
      const copy = document.querySelector('[aria-label="Image viewer"]');
      expect(copy?.hasAttribute('inert')).toBe(true);
      expect(copy?.getAttribute('aria-hidden')).toBe('true');
      // Neither a dialog nor an Esc layer any more.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(pageEscape).toHaveBeenCalledOnce();
      fireEvent.click(opener);
      expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeTruthy();
      await waitFor(() => expect(document.querySelectorAll('[aria-label="Image viewer"]')).toHaveLength(1));
    } finally {
      window.removeEventListener('keydown', pageEscape);
    }
  });

  it('leaves no copy behind when animations are skipped', async () => {
    render(<Thumbnail />);
    fireEvent.click(screen.getByRole('button', { name: 'View image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }));
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[aria-label="Image viewer"]')).toBeNull();
  });
});
