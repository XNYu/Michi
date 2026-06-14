import { useMemo } from 'react';
import { usePrefs } from '../../state/prefs';
import { cssVarsFor, resolveAccent } from './tokens';

/** Build the CSS-variable style object for the current terminal prefs. */
export function useTerminalColors(): Record<string, string> {
  const { prefs } = usePrefs();
  const accent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);
  return useMemo(
    () => cssVarsFor(prefs.terminalPalette, accent),
    [prefs.terminalPalette, accent],
  );
}
