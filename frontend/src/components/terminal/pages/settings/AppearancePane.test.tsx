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

describe('Appearance pane heading', () => {
  it('leaves the page heading to the Settings column', () => {
    render(<AppearancePane />);
    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
  });
});

describe('Appearance pane width modes', () => {

  it('uses the reading width default without rounding it to a 20px step', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const slider = screen.getByRole('slider', { name: 'Single-pane reading width' });
    expect((slider as HTMLInputElement).value).toBe('676');
    fireEvent.change(slider, { target: { value: '720' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('singlePaneContentWidth', 720);
  });

  it('retains the shared width slider', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    fireEvent.change(screen.getByRole('slider', { name: 'Default pane width' }), { target: { value: '800' } });
    expect(setPref).toHaveBeenCalledExactlyOnceWith('defaultPaneWidth', 800);
  });
});

describe('Appearance swatches', () => {
  it('are buttons the keyboard reaches and presses, saying which one is chosen', () => {
    render(<AppearancePane />);
    const gruvbox = screen.getByRole('button', { name: 'gruvbox' });
    expect(gruvbox.tabIndex).toBe(0);
    expect(gruvbox.getAttribute('aria-pressed')).toBe(String(DEFAULT_PREFS.terminalPalette === 'gruvbox'));
    fireEvent.keyDown(gruvbox, { key: 'Enter' });
    if (DEFAULT_PREFS.terminalPalette !== 'gruvbox') expect(setPref).toHaveBeenCalledWith('terminalPalette', 'gruvbox');
    setPref.mockClear();
    const pink = screen.getByRole('button', { name: 'pink' });
    fireEvent.keyDown(pink, { key: ' ' });
    expect(setPref).toHaveBeenCalledWith('terminalAccentOverrides', expect.objectContaining({ [DEFAULT_PREFS.terminalPalette]: '#ff2d95' }));
    setPref.mockClear();
    fireEvent.keyDown(pink, { key: 'x' });
    expect(setPref).not.toHaveBeenCalled();
  });
});
