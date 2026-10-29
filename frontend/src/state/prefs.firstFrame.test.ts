import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import { PALETTES } from '../components/terminal/tokens';
import { DEFAULT_PREFS, PREFS_KEY, type TerminalPalette } from './prefs';

// index.html paints the saved palette before the bundle loads. It cannot import
// prefs.tsx, so this test runs its inline script against what prefs persists.
const head = indexHtml.slice(0, indexHtml.indexOf('</head>'));
const bootScript = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function firstFrame(stored: Record<string, string>) {
  const attributes: Record<string, string> = {};
  const documentElement = {
    lang: '',
    style: {} as Record<string, string>,
    setAttribute(name: string, value: string) { attributes[name] = value; },
  };
  const localStorage = { getItem: (key: string) => stored[key] ?? null };
  new Function('localStorage', 'document', 'navigator', bootScript)(
    localStorage,
    { documentElement },
    { language: 'en-US' },
  );
  return { background: documentElement.style.background, palette: attributes['data-terminal-palette'] };
}

describe('index.html first-frame palette', () => {
  it.each(Object.keys(PALETTES) as TerminalPalette[])('paints the saved %s palette background', (palette) => {
    const saved = JSON.stringify({ ...DEFAULT_PREFS, terminalPalette: palette });
    expect(firstFrame({ [PREFS_KEY]: saved })).toEqual({ background: PALETTES[palette].bg, palette });
  });

  it('falls back to the default palette without saved or valid prefs', () => {
    const fallback = { background: PALETTES[DEFAULT_PREFS.terminalPalette].bg, palette: DEFAULT_PREFS.terminalPalette };
    expect(firstFrame({})).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: JSON.stringify({ theme: 'night' }) })).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: JSON.stringify({ terminalPalette: 'constructor' }) })).toEqual(fallback);
    expect(firstFrame({ [PREFS_KEY]: '{not json' })).toEqual(fallback);
  });

  it('leaves the body background to the painted root', () => {
    expect(indexHtml).not.toMatch(/<body[^>]*background/);
  });
});
