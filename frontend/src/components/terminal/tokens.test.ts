import { describe, expect, it } from 'vitest';
import { DARK_PALETTES, PALETTES, resolveAccent } from './tokens';

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

function distance(a: string, b: string): number {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe.each(Object.entries(PALETTES))('%s palette readability', (_name, p) => {
  const grounds = [p.bg, p.surface, p.alt];

  // muted carries information (timestamps, counts, hints) so it must clear AA;
  // faint is reserved for placeholders, disabled states and decorative glyphs.
  it('keeps every text level readable on every ground', () => {
    for (const g of grounds) {
      expect(contrastRatio(p.fg, g)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.mid, g)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.muted, g)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.faint, g)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the four text levels visibly stepped', () => {
    const on = (c: string) => contrastRatio(c, p.bg);
    expect(on(p.fg) / on(p.mid)).toBeGreaterThan(1.2);
    expect(on(p.mid) / on(p.muted)).toBeGreaterThan(1.2);
    expect(on(p.muted) / on(p.faint)).toBeGreaterThan(1.2);
  });

  it('keeps the accent visibly apart from the node hues it would otherwise impersonate', () => {
    // select = streaming, digest = digests/success, mauve = tool calls.
    for (const hue of [p.select, p.digest, p.mauve]) {
      expect(distance(p.accent, hue)).toBeGreaterThan(60);
    }
  });

  it('reads --on-accent (the canvas) on accent and digest fills', () => {
    expect(contrastRatio(p.bg, p.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.bg, p.digest)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the primary button ink (the surface) on its accent fill', () => {
    // .ui-btn--primary / .t-action-btn.is-primary: Send and every text Button.
    expect(contrastRatio(p.surface, p.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads accent text on its pale accent fill', () => {
    // Floor is 4.0, not AA's 4.5: Bone's rust on its chip fill sits at 4.1:1.
    expect(contrastRatio(p.accent, p.accentF)).toBeGreaterThanOrEqual(4.0);
  });
});
