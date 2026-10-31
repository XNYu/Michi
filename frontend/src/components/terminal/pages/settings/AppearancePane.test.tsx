import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { AppearancePane } from './AppearancePane';
import { SettingsLayoutContext, SettingsTargetContext } from './settingsPhone';

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

describe('Appearance on a phone', () => {
  const phone = () => render(<SettingsLayoutContext.Provider value="phone"><AppearancePane /></SettingsLayoutContext.Provider>);

  it('leaves out pane layout, which a one-pane screen does not use, and preference keys', () => {
    phone();
    expect(screen.queryByText('Focus dimming')).toBeNull();
    expect(screen.queryByText('Single-page mode')).toBeNull();
    expect(screen.queryByText('theme.palette')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    expect(screen.queryByRole('slider', { name: 'Default pane width' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Single-pane reading width' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Pane width mode' })).toBeNull();
    expect(screen.queryByText('Chrome rules')).toBeNull();
    // What a phone does use stays.
    expect(screen.getByRole('slider', { name: 'Corner radius' })).toBeTruthy();
    expect(screen.getByText('Code wrap')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'gruvbox' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /suppress animations/ })).toBeTruthy();
  });

  it('keeps pane layout in the desktop window, beside a live preview, still without preference keys', () => {
    render(<AppearancePane />);
    expect(screen.getByText('Focus dimming')).toBeTruthy();
    expect(screen.queryByText('theme.palette')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
  });

  it('has no preview on a phone', () => {
    phone();
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
  });
});

describe('Appearance opened from a search result', () => {
  it('opens Advanced when the result is an advanced setting', () => {
    render(<SettingsTargetContext.Provider value="Code wrap"><AppearancePane /></SettingsTargetContext.Provider>);
    expect(screen.getByRole('button', { name: /Advanced/i }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Code wrap')).toBeTruthy();
  });

  it('leaves Advanced closed for another setting', () => {
    render(<SettingsTargetContext.Provider value="Palette"><AppearancePane /></SettingsTargetContext.Provider>);
    expect(screen.getByRole('button', { name: /Advanced/i }).getAttribute('aria-expanded')).toBe('false');
  });
});
