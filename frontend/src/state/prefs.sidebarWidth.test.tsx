import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);

function Probe() {
  const { prefs } = usePrefs();
  return <output data-testid="width">{prefs.terminalSidebarWidth}</output>;
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null);
});
afterEach(cleanup);

describe('sidebar width preference', () => {
  it('starts a fresh profile at 252px', () => {
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('width').textContent).toBe('252');
  });

  it('keeps the width an existing profile already stored', () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ terminalSidebarWidth: 280 }));
    render(<PrefsProvider><Probe /></PrefsProvider>);
    expect(screen.getByTestId('width').textContent).toBe('280');
  });
});
