import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalShell } from './ModalShell';

/** useFrozenGlass's capture budget. */
const FROZEN_GLASS_BUDGET_MS = 150;

const blurSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./frozenGlassBitmap', () => ({ blurSnapshot }));

// As the command palette mounts it: an entrance, no exit.
function Palette({ glass }: { glass?: 'frozen' | 'live' }) {
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
  vi.restoreAllMocks();
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

  it.each(['empty', 'rejected', 'decode'] as const)('opens solid when capture fails (%s)', async (failure) => {
    if (failure === 'empty') capture.mockResolvedValueOnce(null);
    if (failure === 'rejected') capture.mockRejectedValueOnce(new Error('capture failed'));
    if (failure === 'decode') blurSnapshot.mockResolvedValueOnce(null);
    render(<Palette />);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('solid'));
    expect(panel().querySelector('.ui-frozen-glass')).toBeNull();
  });

  it('does not wait past its budget, and drops a capture that arrives late', async () => {
    let resolve!: (url: string) => void;
    capture.mockImplementationOnce(() => new Promise<string>((r) => { resolve = r; }));
    render(<Palette />);
    expect(panel().getAttribute('data-glass')).toBe('capturing');
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('solid'), { timeout: FROZEN_GLASS_BUDGET_MS + 500 });
    // The open panel would be in a capture taken now.
    await act(async () => { resolve('data:image/png;base64,LATE'); });
    expect(panel().getAttribute('data-glass')).toBe('solid');
    expect(blurSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a blur that finishes past the deadline before the timer can run', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const canvas = document.createElement('canvas');
    blurSnapshot.mockImplementationOnce(async () => {
      now.mockReturnValue(FROZEN_GLASS_BUDGET_MS + 1);
      return canvas;
    });
    render(<Palette />);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('solid'));
    expect(panel().querySelector('canvas')).toBeNull();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
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

  it('opens solid with an older desktop bridge, or when frozen glass is requested without a bridge', () => {
    (window as unknown as { electron?: unknown }).electron = {};
    const view = render(<Palette />);
    expect(panel().getAttribute('data-glass')).toBe('solid');
    view.unmount();
    delete (window as unknown as { electron?: unknown }).electron;
    render(<Palette glass="frozen" />);
    expect(panel().getAttribute('data-glass')).toBe('solid');
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps the same panel, input and snapshot through streaming parent updates', async () => {
    const view = render(<Palette />);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('frozen'));
    const original = panel();
    const canvas = original.querySelector('canvas');
    const input = screen.getByLabelText('query') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'in progress' } });
    input.focus();
    input.setSelectionRange(3, 5);
    for (let i = 0; i < 20; i += 1) view.rerender(<Palette />);
    expect(panel()).toBe(original);
    expect(panel().querySelector('canvas')).toBe(canvas);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('in progress');
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(5);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('opens a nested dialog solid immediately, without capturing the dialog below', async () => {
    const pair = (confirm: boolean) => <>
      <ModalShell open title="Settings" onClose={() => {}}>Settings content</ModalShell>
      <ModalShell open={confirm} title="Confirm" onClose={() => {}}>Confirm content</ModalShell>
    </>;
    const view = render(pair(false));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Settings' }).getAttribute('data-glass')).toBe('frozen'));
    view.rerender(pair(true));
    expect(screen.getByRole('dialog', { name: 'Confirm' }).getAttribute('data-glass')).toBe('solid');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('owns the bitmap through the frozen phase, then clears its backing on unmount even under StrictMode', async () => {
    const view = render(<React.StrictMode><Palette /></React.StrictMode>);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('frozen'));
    const canvas = panel().querySelector('canvas')!;
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
    view.unmount();
    expect(canvas.isConnected).toBe(false);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('releases a decode result arriving after the modal was closed', async () => {
    let resolve!: (canvas: HTMLCanvasElement) => void;
    blurSnapshot.mockImplementationOnce(() => new Promise<HTMLCanvasElement>(r => { resolve = r; }));
    const view = render(<Palette />);
    await waitFor(() => expect(blurSnapshot).toHaveBeenCalled());
    view.unmount();
    const canvas = document.createElement('canvas');
    await act(async () => resolve(canvas));
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('leaves the solid surface alone when glass is off', async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduced-transparency'), media: query })) as unknown as typeof window.matchMedia;
    try {
      render(<Palette />);
      expect(panel().getAttribute('data-glass')).toBe('solid');
      expect(capture).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('stays solid after resize, even when the old viewport size returns', async () => {
    render(<Palette />);
    await waitFor(() => expect(panel().getAttribute('data-glass')).toBe('frozen'));
    const canvas = panel().querySelector('canvas')!;
    const width = window.innerWidth;
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width + 40 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().getAttribute('data-glass')).toBe('solid');
    expect(panel().querySelector('.ui-frozen-glass')).toBeNull();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().getAttribute('data-glass')).toBe('solid');
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
