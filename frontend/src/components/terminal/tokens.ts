export type TerminalPalette = 'bone' | 'slate' | 'monokai' | 'gruvbox';

export interface TerminalTokens {
  /** Canvas background — the paper. */
  bg: string;
  /**
   * Recessed surface — darker than `bg`, used for focused inputs / inset
   * wells on dark themes (the composer sinks in when focused). On light
   * themes this is unused (light composer focus is hardcoded near-white).
   */
  bgDeep: string;
  /** Raised surface (cards, sidebar, top/status bars). */
  surface: string;
  /** Alt-surface (subtle fill — focused row, active tab bg). */
  alt: string;
  /** Slightly darker alt, rarely used. */
  alt2: string;
  /** Hairline divider color. */
  line: string;
  /** Strong divider (header underlines, SVG strokes). */
  lineS: string;
  /** Primary foreground / text. */
  fg: string;
  /** Secondary text that must stay easy to read. ≥4.5:1 on bg/surface/alt. */
  mid: string;
  /** Quiet text that still carries information: captions, timestamps, counts,
   *  hints, metadata. ≥4.5:1 on bg/surface/alt. */
  muted: string;
  /** Not for information: placeholders, disabled states, decorative glyphs
   *  (· › ▸) and idle icon affordances. ≥3:1 on bg/surface/alt. */
  faint: string;
  /** Brand accent (focus ring, prompt glyph, brand mark). */
  accent: string;
  /** Accent fill — pale tinted background for accent-bordered chips. */
  accentF: string;
  /** Amber — streaming, selection. */
  select: string;
  /** Selection fill — pale amber background. */
  selectF: string;
  /** Emerald — digest nodes and sections. */
  digest: string;
  /** Digest fill — pale green background. */
  digestF: string;
  /** Violet — tool calls, merge edges, synthesize. */
  mauve: string;
  /** Mauve fill — pale violet background. */
  mauveF: string;
  /** Error / destructive. */
  danger: string;
}

export const BONE: TerminalTokens = {
  bg: '#fdfdfc', bgDeep: '#ffffff', surface: '#ffffff', alt: '#efece5', alt2: '#e8e4d8',
  line: '#d8d2c4', lineS: '#b5ac98', fg: '#1a1916', mid: '#5a544a',
  muted: '#70695d', faint: '#8c877c',
  accent: '#b8451f', accentF: '#f4dccf',
  select: '#c48300', selectF: '#f8eccf',
  digest: '#2f6b4e', digestF: '#d7e7df',
  mauve: '#6d4aa8', mauveF: '#ebe4f6',
  danger: '#a8261a',
};

export const SLATE: TerminalTokens = {
  bg: '#f3f4f6', bgDeep: '#ffffff', surface: '#ffffff', alt: '#e5e7eb', alt2: '#d8dbe1',
  line: '#d1d5db', lineS: '#9ca3af', fg: '#111827', mid: '#4b5563',
  muted: '#616876', faint: '#7d8491',
  accent: '#1a4d8f', accentF: '#dbeafe',
  select: '#c48300', selectF: '#fef3c7',
  digest: '#2f6b4e', digestF: '#d1fae5',
  mauve: '#6d4aa8', mauveF: '#ede9fe',
  danger: '#b91c1c',
};

export const MONOKAI: TerminalTokens = {
  bg: '#272822', bgDeep: '#1d1e19', surface: '#2d2e28', alt: '#383930', alt2: '#3e3f38',
  line: '#49483e', lineS: '#75715e', fg: '#f8f8f2', mid: '#c0c0b8',
  muted: '#a2a298', faint: '#868371',
  // Accent is Monokai's own cyan, not its green: green is already the digest
  // hue, and sharing it made the active item, digest nodes and success/info
  // toasts indistinguishable.
  accent: '#66d9ef', accentF: '#12292e',
  select: '#e6db74', selectF: '#2a2810',
  digest: '#a6e22e', digestF: '#1a2210',
  mauve: '#ae81ff', mauveF: '#1e1428',
  danger: '#f92672',
};

export const GRUVBOX: TerminalTokens = {
  bg: '#282828', bgDeep: '#1d1d1d', surface: '#2e2e2e', alt: '#3c3836', alt2: '#504945',
  line: '#504945', lineS: '#665c54', fg: '#ebdbb2', mid: '#cabb9b',
  muted: '#afa088', faint: '#8d816f',
  // Accent is Gruvbox's own blue, not its yellow: yellow is the streaming /
  // selection hue, and sharing it hid which node was streaming vs. focused.
  accent: '#83a598', accentF: '#1e2826',
  select: '#fabd2f', selectF: '#2a2410',
  digest: '#b8bb26', digestF: '#1e2210',
  mauve: '#d3869b', mauveF: '#281a20',
  danger: '#fb4934',
};

export const PALETTES: Record<TerminalPalette, TerminalTokens> = {
  bone: BONE,
  slate: SLATE,
  monokai: MONOKAI,
  gruvbox: GRUVBOX,
};

/**
 * Palettes with dark backgrounds. Used by callers that need to flip a UI
 * element between light-mode and dark-mode variants (e.g. Tailwind's
 * `prose-invert` for markdown rendering).
 */
/** Resolve the active accent for a palette: user override or palette default. */
export function resolveAccent(
  overrides: Partial<Record<TerminalPalette, string>>,
  palette: TerminalPalette,
): string {
  return overrides[palette] ?? PALETTES[palette].accent;
}

export const DARK_PALETTES: ReadonlySet<TerminalPalette> = new Set<TerminalPalette>([
  'monokai',
  'gruvbox',
]);

// Light pages use dark floating surfaces with a matching color temperature.
// Keep these separate from page tokens so text and native controls remain legible.
const LIGHT_FLOATING_COLORS = {
  slate: {
    bg: '#2f3a49', fg: '#eef3f9', mid: '#c2cfdf', muted: '#aabacd',
    line: '#4f6075', hover: '#3c4b5d', quote: '#26303d', action: '#bfcee2',
  },
  bone: {
    bg: '#39342f', fg: '#f5f0e7', mid: '#d0c5b6', muted: '#bcb0a1',
    line: '#595147', hover: '#484039', quote: '#302b26', action: '#d9cdbb',
  },
} as const;

/**
 * Error TEXT colour. On the dark palettes danger reads only 3.1–4.3:1 on
 * bg/surface/alt (Monokai 3.1–3.9, Gruvbox 3.4–4.3) — fine for icons and
 * fills, too dim for words — so there it mixes 55:45 toward the foreground
 * (4.8:1 or better). The light palettes' danger already clears 5.2:1 and is
 * used as is. tokens.test.ts checks the 4.5:1 floor.
 */
export function dangerTextFor(palette: TerminalPalette): string {
  const p = PALETTES[palette];
  return DARK_PALETTES.has(palette) ? `color-mix(in srgb, ${p.danger} 55%, ${p.fg})` : p.danger;
}

/**
 * Build a CSS custom-property map for a palette + user overrides.
 * Apply these as `style={cssVarsFor(...)}` on the shell root; all terminal
 * components read `var(--term-fg)` etc.
 *
 * Font tokens are NOT emitted here — `--ui-font` is set on :root by
 * prefs.tsx (driven by prefs.uiFont) and message typography is handled by
 * the .terminal-message CSS scope in index.css.
 */
export function cssVarsFor(
  palette: TerminalPalette,
  accent: string,
): Record<string, string> {
  const p = PALETTES[palette];
  const isLight = !DARK_PALETTES.has(palette);
  const floating = palette === 'slate' || palette === 'bone' ? LIGHT_FLOATING_COLORS[palette] : null;
  return {
    '--term-bg': p.bg,
    '--term-page-bg': p.bg,
    '--term-surface': p.surface,
    '--term-sidebar-tint': `color-mix(in srgb, ${p.surface} 88%, #ffffff)`,
    '--term-alt': p.alt,
    '--term-alt2': p.alt2,
    '--term-hover-bg': p.alt,
    '--term-composer-bg': isLight ? 'rgb(254, 254, 254)' : p.bg,
    '--term-composer-bg-focus': isLight ? 'rgba(255, 255, 255, 1)' : p.bgDeep,
    '--term-composer-border': isLight
      ? '1px solid rgba(0, 0, 0, 0.08)'
      : '1px solid var(--term-line-s)',
    '--term-composer-border-focus': isLight
      ? '1px solid rgba(0, 0, 0, 0.18)'
      : '1px solid var(--term-line-s)',
    '--term-composer-shadow': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 34px rgba(0, 0, 0, 0.08)'
      : 'inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 1px 3px rgba(0, 0, 0, 0.5)',
    '--term-composer-shadow-muted': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 28px rgba(0, 0, 0, 0.035)'
      : 'none',
    // Elevation for FLOATING overlays (selection bar, its morph composer) that
    // sit *above* content — always an OUTER drop, never inset. Distinct from
    // --term-composer-shadow, whose dark variant is intentionally `inset`
    // (a recessed input well) because the Pane Composer is embedded in the pane,
    // not floating. Reusing the composer token here made the popup read as
    // carved-inward in dark. Light matches the composer's approved soft drop.
    '--term-float-shadow': isLight
      ? '0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 34px rgba(0, 0, 0, 0.08)'
      : '0 2px 8px rgba(0, 0, 0, 0.55), 0 16px 40px rgba(0, 0, 0, 0.4)',
    '--term-line': p.line,
    '--term-line-s': p.lineS,
    '--term-fg': p.fg,
    '--term-mid': p.mid,
    '--term-muted': p.muted,
    '--term-faint': p.faint,
    // Accent is an override (user-picked) layered over palette default.
    '--term-accent': accent,
    '--term-accent-f': p.accentF,
    '--term-select': p.select,
    '--term-select-f': p.selectF,
    '--term-digest': p.digest,
    '--term-digest-f': p.digestF,
    '--term-mauve': p.mauve,
    '--term-mauve-f': p.mauveF,
    '--term-danger': p.danger,
    // Error text (icons and fills keep --term-danger); see dangerTextFor.
    '--term-danger-text': dangerTextFor(palette),
    // Override Tailwind prose body/heading colors so markdown content inside
    // the terminal shell uses the palette foreground instead of the default
    // gray (which is nearly invisible on light palettes like bone/slate).
    '--tw-prose-body': p.fg,
    '--tw-prose-headings': p.fg,
    '--tw-prose-bold': p.fg,
    '--tw-prose-code': p.fg,
    '--tw-prose-links': p.accent,
    // Motion tokens (--t-quick/soft/enter/decay/ease) are palette-independent
    // and live only in index.css :root.
    // Floating surfaces stay dark: cool blue-gray on Slate, warm graphite on Bone,
    // and a raised shade of the page on the dark palettes.
    // Shared by selection bars/composers, batch actions and transient notices.
    '--sel-bar-bg': floating?.bg ?? `color-mix(in srgb, ${p.surface} 92%, ${p.fg})`,
    '--sel-bar-fg': floating?.fg ?? p.fg,
    '--sel-bar-mid': floating?.mid ?? p.mid,
    // Raising a dark surface reduces contrast; use the brighter text level for metadata.
    '--sel-bar-muted': floating?.muted ?? p.mid,
    '--sel-bar-line': floating?.line ?? `color-mix(in srgb, ${p.surface} 80%, ${p.fg})`,
    '--sel-bar-hover': floating?.hover ?? `color-mix(in srgb, ${p.fg} 8%, transparent)`,
    '--sel-bar-shadow': isLight
      ? '0 2px 6px rgba(16, 24, 32, 0.09), 0 12px 26px rgba(16, 24, 32, 0.14)'
      : 'var(--term-float-shadow)',
    '--sel-bar-color-scheme': 'dark',
    '--sel-bar-quote-bg': floating?.quote ?? 'color-mix(in srgb, var(--term-bg) 45%, var(--sel-bar-bg))',
    '--sel-bar-action-bg': floating?.action ?? `color-mix(in srgb, ${accent} 35%, ${p.fg})`,
    '--sel-bar-action-fg': floating?.bg ?? p.bg,
  };
}
