import { describe, expect, it } from 'vitest';
import { BONE, DARK_PALETTES, PALETTES, resolveAccent } from './tokens';

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, got ${hex}`);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    Math.max(foregroundLuminance, backgroundLuminance) + 0.05
  ) / (
    Math.min(foregroundLuminance, backgroundLuminance) + 0.05
  );
}

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

describe('Bone palette readability', () => {
  it.each([
    ['muted', BONE.muted],
    ['faint', BONE.faint],
  ])('%s text clears WCAG AA on both Bone surfaces', (_token, color) => {
    const lowestSurfaceContrast = Math.min(
      contrastRatio(color, BONE.bg),
      contrastRatio(color, BONE.surface),
    );
    expect(lowestSurfaceContrast).toBeGreaterThanOrEqual(4.5);
  });
});
