import { useEffect, useMemo } from 'react';
import { usePrefs } from '../../state/prefs';
import { cssVarsFor, resolveAccent, DARK_PALETTES } from './tokens';
import { getElectron } from '../../lib/electronBridge';

/** Build the CSS-variable style object for the current terminal prefs. */
export function useTerminalColors(): Record<string, string> {
  const { prefs } = usePrefs();
  const accent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);

  // Keep the native macOS vibrancy material's light/dark in sync with the
  // palette — otherwise a dark palette gets a light frost (and vice versa).
  // No-op in the browser (getElectron() → null) and on builds without the
  // bridge method.
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  useEffect(() => {
    getElectron()?.setDarkMaterial?.(isDark);
  }, [isDark]);

  return useMemo(
    () => cssVarsFor(prefs.terminalPalette, accent),
    [prefs.terminalPalette, accent],
  );
}
