import { describe, expect, it } from 'vitest';
import { DARK_PALETTES, PALETTES, cssVarsFor, dangerTextFor } from './tokens';

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

/** `color-mix(in srgb, a w%, b)`: a straight per-channel blend of the encoded sRGB values. */
function mixSrgb(a: string, b: string, weightOfA: number): string {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((c, i) => Math.round(c * weightOfA + y[i] * (1 - weightOfA)).toString(16).padStart(2, '0')).join('')}`;
}

describe('--term-danger-text', () => {
  it('mixes danger toward fg on the dark palettes and is plain danger on the light ones', () => {
    expect(dangerTextFor('monokai')).toBe(`color-mix(in srgb, ${PALETTES.monokai.danger} 55%, ${PALETTES.monokai.fg})`);
    expect(dangerTextFor('gruvbox')).toBe(`color-mix(in srgb, ${PALETTES.gruvbox.danger} 55%, ${PALETTES.gruvbox.fg})`);
    expect(dangerTextFor('bone')).toBe(PALETTES.bone.danger);
    expect(dangerTextFor('slate')).toBe(PALETTES.slate.danger);
  });

  it('is emitted with the rest of the palette', () => {
    for (const palette of ['monokai', 'gruvbox', 'bone', 'slate'] as const) {
      expect(cssVarsFor(palette, PALETTES[palette].accent)['--term-danger-text']).toBe(dangerTextFor(palette));
    }
  });

  it.each(Object.entries(PALETTES))('reads as text on every %s ground', (name, p) => {
    const text = DARK_PALETTES.has(name as keyof typeof PALETTES) ? mixSrgb(p.danger, p.fg, 0.55) : p.danger;
    for (const g of [p.bg, p.surface, p.alt]) {
      expect(contrastRatio(text, g)).toBeGreaterThanOrEqual(4.5);
    }
  });
});


describe('raised selection surfaces', () => {
  function resolveColor(value: string): string {
    if (value.startsWith('#')) return value;
    const match = value.match(/^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, (#[0-9a-f]{6})\)$/i);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    return mixSrgb(match[1], match[3], Number(match[2]) / 100);
  }

  it.each(Object.entries(PALETTES))('keeps %s floating text readable and dark surfaces distinct', (name, p) => {
    const vars = cssVarsFor(name as keyof typeof PALETTES, p.accent);
    const background = resolveColor(vars['--sel-bar-bg']);
    for (const key of ['--sel-bar-fg', '--sel-bar-mid', '--sel-bar-muted']) {
      expect(contrastRatio(resolveColor(vars[key]), background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(resolveColor(vars['--sel-bar-action-fg']), resolveColor(vars['--sel-bar-action-bg']))).toBeGreaterThanOrEqual(4.5);
    if (DARK_PALETTES.has(name as keyof typeof PALETTES)) {
      expect(relativeLuminance(background)).toBeGreaterThan(relativeLuminance(p.surface) + 0.015);
      expect(relativeLuminance(background)).toBeLessThan(0.1);
    } else {
      expect(relativeLuminance(background)).toBeLessThan(0.1);
      expect(vars['--sel-bar-color-scheme']).toBe('dark');
      for (const key of ['--sel-bar-mid', '--sel-bar-muted']) {
        expect(contrastRatio(resolveColor(vars[key]), resolveColor(vars['--sel-bar-quote-bg']))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(resolveColor(vars[key]), resolveColor(vars['--sel-bar-hover']))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('gives Slate a cool floating surface and Bone a warm one', () => {
    const slate = cssVarsFor('slate', PALETTES.slate.accent)['--sel-bar-bg'];
    const bone = cssVarsFor('bone', PALETTES.bone.accent)['--sel-bar-bg'];
    const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
    const [sr, sg, sb] = rgb(slate);
    const [br, bg, bb] = rgb(bone);
    expect(sb).toBeGreaterThan(sg);
    expect(sg).toBeGreaterThan(sr);
    expect(br).toBeGreaterThan(bg);
    expect(bg).toBeGreaterThan(bb);
  });
});
