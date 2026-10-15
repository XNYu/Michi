import type { ITheme } from '@xterm/xterm';
import type { TerminalPalette } from '../../state/prefs';
import { PALETTES, resolveAccent } from './tokens';

// ANSI colors are terminal design tokens, independent of the user's accent.
// Keep black/white usable as CLI backgrounds too; xterm's contrast correction
// makes pale foregrounds readable on light themes (including truecolor output).
const ANSI: Record<TerminalPalette, Pick<ITheme,
  'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' |
  'brightMagenta' | 'brightCyan' | 'brightWhite'>> = {
  bone: {
    black: '#292620', red: '#a8261a', green: '#2f6b4e', yellow: '#886209',
    blue: '#375f86', magenta: '#6d4aa8', cyan: '#246d70', white: '#d8d2c4',
    brightBlack: '#70695d', brightRed: '#b8451f', brightGreen: '#39784c', brightYellow: '#997015',
    brightBlue: '#466fad', brightMagenta: '#89539b', brightCyan: '#317b78', brightWhite: '#fdfdfc',
  },
  slate: {
    black: '#1f2937', red: '#b91c1c', green: '#267049', yellow: '#85620d',
    blue: '#1a4d8f', magenta: '#6d4aa8', cyan: '#146b80', white: '#d1d5db',
    brightBlack: '#616876', brightRed: '#c53338', brightGreen: '#287d55', brightYellow: '#946e12',
    brightBlue: '#356ac3', brightMagenta: '#8755b1', brightCyan: '#217b90', brightWhite: '#f3f4f6',
  },
  monokai: {
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#e6db74',
    blue: '#81a2f8', magenta: '#ae81ff', cyan: '#66d9ef', white: '#d8d8d0',
    brightBlack: '#a2a298', brightRed: '#ff6695', brightGreen: '#beed62', brightYellow: '#f3e99b',
    brightBlue: '#a4bbff', brightMagenta: '#c6a3ff', brightCyan: '#96e6f3', brightWhite: '#f8f8f2',
  },
  gruvbox: {
    black: '#282828', red: '#cc5a4b', green: '#a9ad35', yellow: '#d9a63a',
    blue: '#77999e', magenta: '#b67f96', cyan: '#7fa66f', white: '#d5c4a1',
    brightBlack: '#afa088', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
    brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
};

export function terminalTheme(
  palette: TerminalPalette,
  overrides: Partial<Record<TerminalPalette, string>>,
): ITheme {
  const p = PALETTES[palette];
  return {
    ...ANSI[palette],
    background: p.surface,
    foreground: p.fg,
    cursor: resolveAccent(overrides, palette),
    cursorAccent: p.surface,
    selectionBackground: p.selectF,
    selectionInactiveBackground: p.alt,
    selectionForeground: p.fg,
  };
}
