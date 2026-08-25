import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalColors } from './useTerminalColors';

const H = vi.hoisted(() => ({
  prefs: {
    terminalPalette: 'monokai' as 'monokai' | 'bone',
    terminalAccentOverrides: {},
    sidebarVibrancy: 'under-window',
  },
  setDarkMaterial: vi.fn(),
  setVibrancy: vi.fn(),
}));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: H.prefs }),
}));

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => ({
    setDarkMaterial: H.setDarkMaterial,
    setVibrancy: H.setVibrancy,
  }),
}));

describe('useTerminalColors browser theme sync', () => {
  beforeEach(() => {
    H.prefs.terminalPalette = 'monokai';
    H.setDarkMaterial.mockReset();
    H.setVibrancy.mockReset();
  });

  it('sends the active dark palette background to Electron', () => {
    const { result } = renderHook(() => useTerminalColors());
    expect(result.current['--term-bg']).toBe('#272822');
    expect(H.setDarkMaterial).toHaveBeenLastCalledWith(true, '#272822');
  });

  it('updates Electron when Michi switches to a light palette', () => {
    const { rerender } = renderHook(() => useTerminalColors());
    act(() => {
      H.prefs.terminalPalette = 'bone';
      rerender();
    });
    expect(H.setDarkMaterial).toHaveBeenLastCalledWith(false, '#fdfdfc');
  });
});
