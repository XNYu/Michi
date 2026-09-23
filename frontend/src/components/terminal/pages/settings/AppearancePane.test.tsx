import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { AppearancePane } from './AppearancePane';

const setPref = vi.fn();
vi.mock('../../../../state/prefs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../state/prefs')>(),
  usePrefs: () => ({ prefs: DEFAULT_PREFS, setPref }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Appearance pane width modes', () => {
  it.each(['soft-fade', 'gentle-glide', 'frozen-retract'])('offers %s without changing other preferences', mode => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const select = screen.getByRole('combobox', { name: 'Pane animation' }) as HTMLSelectElement;
    expect(select.options.length).toBe(6);
    expect(select.value).toBe(DEFAULT_PREFS.paneSpawnAnimation);
    fireEvent.change(select, { target: { value: mode } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('paneSpawnAnimation', mode);
  });
  it('offers all three policies and reflects the default', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const select = screen.getByRole('combobox', { name: 'Pane width mode' }) as HTMLSelectElement;
    expect(select.value).toBe('half');
    expect(Array.from(select.options).map(option => option.value)).toEqual(['fixed', 'half', 'adaptive']);
  });

  it.each(['fixed', 'half', 'adaptive'])('changes the policy to %s without overwriting the configured width', mode => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    fireEvent.change(screen.getByLabelText('Pane width mode'), { target: { value: mode } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('paneWidthMode', mode);
  });

  it('exposes the corner radius outside Advanced and writes the pref', () => {
    render(<AppearancePane />);
    const slider = screen.getByRole('slider', { name: 'Corner radius' }) as HTMLInputElement;
    expect(slider.value).toBe(String(DEFAULT_PREFS.cornerRadius));
    fireEvent.change(slider, { target: { value: '9' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('cornerRadius', 9);
  });

  it('retains the shared width slider', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    fireEvent.change(screen.getByRole('slider', { name: 'Default pane width' }), { target: { value: '800' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('defaultPaneWidth', 800);
  });
});
