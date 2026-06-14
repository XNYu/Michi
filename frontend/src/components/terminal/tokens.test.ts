import { describe, expect, it } from 'vitest';
import { DARK_PALETTES, PALETTES, resolveAccent } from './tokens';

describe('cssVarsFor — accent resolution', () => {
  it('resolveAccent falls back to the palette default when no override exists', () => {
    expect(resolveAccent({}, 'monokai')).toBe(PALETTES.monokai.accent);
    expect(resolveAccent({ bone: '#abcdef' }, 'monokai')).toBe(PALETTES.monokai.accent);
  });

  it('resolveAccent returns the override when one is set for the palette', () => {
    expect(resolveAccent({ monokai: '#abcdef' }, 'monokai')).toBe('#abcdef');
  });

  it('DARK_PALETTES contains exactly the dark palettes', () => {
    expect(DARK_PALETTES.has('monokai')).toBe(true);
    expect(DARK_PALETTES.has('gruvbox')).toBe(true);
    expect(DARK_PALETTES.has('bone')).toBe(false);
    expect(DARK_PALETTES.has('slate')).toBe(false);
  });
});
