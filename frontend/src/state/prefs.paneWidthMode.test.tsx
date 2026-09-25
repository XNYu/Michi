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
  it.each([['soft-fade', 'soft-fade'], ['gentle-glide', 'gentle-glide'], ['frozen-retract', 'frozen-retract'], ['invalid', 'phosphor']])('validates remote animation %s', async (mode, expected) => {
    api.fetchPrefs.mockResolvedValue({ paneSpawnAnimation: mode });
    render(<PrefsProvider><Probe /></PrefsProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('motion').textContent).toBe(expected);
  });

  it('persists animation selections and resets appearance explicitly', async () => {
    vi.useFakeTimers();
    const view = render(<PrefsProvider><Probe /></PrefsProvider>);
    fireEvent.click(screen.getByText('Soft Fade'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).paneSpawnAnimation).toBe('soft-fade');
    expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ paneSpawnAnimation: 'soft-fade' }));
    view.unmount();
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('motion').textContent).toBe('soft-fade');
    fireEvent.click(screen.getByText('Reset appearance'));
    expect(screen.getByTestId('motion').textContent).toBe(DEFAULT_PREFS.paneSpawnAnimation);
  });
  it('keeps the default half policy', () => {
    expect(DEFAULT_PREFS.paneWidthMode).toBe('half');
  });

  it.each(['fixed', 'half', 'adaptive'])('hydrates saved %s mode', mode => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ paneWidthMode: mode }));
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('mode').textContent).toBe(mode);
  });

  it.each([['fixed', 'fixed'], ['invalid', 'half']])('hydrates and validates remote mode %s', async (remote, expected) => {
    api.fetchPrefs.mockResolvedValue({ paneWidthMode: remote });
    render(<PrefsProvider><Probe /></PrefsProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('mode').textContent).toBe(expected);
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
