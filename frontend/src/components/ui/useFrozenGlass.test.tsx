import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalShell } from './ModalShell';

/** useFrozenGlass's capture budget. */
const FROZEN_GLASS_BUDGET_MS = 150;

const blurSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./frozenGlassBitmap', () => ({ blurSnapshot }));

// As the command palette mounts it: an entrance, no exit.
function Palette({ glass = 'frozen' as 'frozen' | 'live' }) {
  return (
    <ModalShell open onClose={() => {}} title="Command palette" motion="enter" glass={glass}>
      <input aria-label="query" autoFocus />
    </ModalShell>
  );
}

const panel = () => screen.getByRole('dialog');
const scrim = () => document.querySelector('.ui-scrim--modal') as HTMLElement;
let capture: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capture = vi.fn(async () => 'data:image/png;base64,AAAA');
  (window as unknown as { electron?: unknown }).electron = { captureBackdrop: capture };
  blurSnapshot.mockReset();
  blurSnapshot.mockImplementation(async () => document.createElement('canvas'));
});
afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  vi.useRealTimers();
});

describe('frozen glass', () => {
  it('draws nothing of the modal while the window is captured, then shows the pre-blurred capture', async () => {
    render(<Palette />);
    // Laid out and focusable, but neither panel nor scrim is drawn: the
    // capture is the page as it was.
    expect(panel().getAttribute('data-glass')).toBe('capturing');
    expect(scrim().getAttribute('data-glass')).toBe('capturing');
    expect(screen.getByLabelText('query')).toBeTruthy();
    expect(capture).toHaveBeenCalledWith({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });

    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('frozen'));
    expect(scrim().hasAttribute('data-glass')).toBe(false);
    expect(blurSnapshot).toHaveBeenCalledWith('data:image/png;base64,AAAA', expect.objectContaining({ blurPx: 26, viewportWidth: window.innerWidth }));
    const layer = panel().querySelector('.ui-frozen-glass');
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.querySelector('canvas')).toBeTruthy();
    // The scrim's dim, as live glass sees the page through it.
    expect(layer?.querySelector('.ui-frozen-glass__dim')).toBeTruthy();
  });

  it('opens with live glass when the capture fails', async () => {
    capture.mockResolvedValueOnce(null);
    render(<Palette />);
    await waitFor(() => expect(panel().hasAttribute('data-glass')).toBe(false));
    expect(panel().querySelector('.ui-frozen-glass')).toBeNull();
  });

  it('does not wait past its budget, and drops a capture that arrives late', async () => {
    let resolve!: (url: string) => void;
    capture.mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
    render(<Palette />);
    expect(panel().getAttribute('data-glass')).toBe('capturing');
    await waitFor(() => expect(panel().hasAttribute('data-glass')).toBe(false), { timeout: FROZEN_GLASS_BUDGET_MS + 500 });
    // The open panel would be in a capture taken now.
    await act(async () => { resolve('data:image/png;base64,LATE'); });
    expect(panel().hasAttribute('data-glass')).toBe(false);
    expect(blurSnapshot).not.toHaveBeenCalled();
  });

  it('is live glass on the web and for modals that do not ask for it', () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const { unmount } = render(<Palette />);
    expect(panel().hasAttribute('data-glass')).toBe(false);
    unmount();

    (window as unknown as { electron?: unknown }).electron = { captureBackdrop: capture };
    render(<Palette glass="live" />);
    expect(panel().hasAttribute('data-glass')).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('leaves the solid surface alone when glass is off', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduced-transparency'), media: query })) as unknown as typeof window.matchMedia;
    try {
      render(<Palette />);
      expect(panel().hasAttribute('data-glass')).toBe(false);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('goes back to live glass when the window resizes', async () => {
    render(<Palette />);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('frozen'));
    const width = window.innerWidth;
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width + 40 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().hasAttribute('data-glass')).toBe(false);
    expect(panel().querySelector('.ui-frozen-glass')).toBeNull();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  });
});
