import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, PrefsProvider, usePrefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);

function Probe() {
  const { prefs, setPref, resetTerminal } = usePrefs();
  return <>
    <output data-testid="mode">{prefs.paneWidthMode}</output>
    <output data-testid="motion">{prefs.paneSpawnAnimation}</output>
    <button onClick={() => setPref('paneSpawnAnimation', 'soft-fade')}>Soft Fade</button>
    <button onClick={() => setPref('paneWidthMode', 'fixed')}>Fixed</button>
    <button onClick={resetTerminal}>Reset appearance</button>
  </>;
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('pane width preference', () => {
  it('keeps the default half policy', () => {
    expect(DEFAULT_PREFS.paneWidthMode).toBe('half');
  });

  it('persists a selection locally and remotely and restores it after remount', async () => {
    vi.useFakeTimers();
    const view = render(<PrefsProvider><Probe /></PrefsProvider>);
    fireEvent.click(screen.getByText('Fixed'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).paneWidthMode).toBe('fixed');
    expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ paneWidthMode: 'fixed' }));
    view.unmount();
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('fixed');
    fireEvent.click(screen.getByText('Reset appearance'));
    expect(screen.getByTestId('mode').textContent).toBe('half');
  });
});
