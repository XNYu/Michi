import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider } from './prefs';
import { BrowserSettingsPane } from '../components/terminal/pages/settings/BrowserSettingsPane';
const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../services/api', () => api);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); api.fetchPrefs.mockResolvedValue(null); });
afterEach(() => vi.useRealTimers());
describe('Browser preference', () => {
  it.each([undefined, 'invalid', 'internal', 'external'])('normalizes locally saved %s', value => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ linkOpenTarget: value }));
    render(<PrefsProvider><BrowserSettingsPane /></PrefsProvider>);
    expect((screen.getByRole('combobox', { name: 'Open links in' }) as HTMLSelectElement).value).toBe(value === 'external' ? 'external' : 'internal');
  });
  it('hydrates remote preferences', async () => {
    api.fetchPrefs.mockResolvedValue({ linkOpenTarget: 'external' });
    await act(async () => { render(<PrefsProvider><BrowserSettingsPane /></PrefsProvider>); });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('external');
  });
  it('saves a Settings change locally and to the backend', async () => {
    vi.useFakeTimers();
    render(<PrefsProvider><BrowserSettingsPane /></PrefsProvider>);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'external' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).linkOpenTarget).toBe('external');
    expect(api.savePrefs).toHaveBeenCalledWith(expect.objectContaining({ linkOpenTarget: 'external' }));
  });
});
