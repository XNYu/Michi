import type { TerminalPalette } from '../../state/prefs';

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
  /** Muted text (secondary labels). */
  mid: string;
  /** Even more muted (section captions). */
  muted: string;
  /** Faintest readable gray (timestamps, dim glyphs). */
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
  // Keep secondary text quiet without dropping below WCAG AA for the 11–13px
  // labels and timestamps that use these tokens. Both colors clear 4.5:1 on
  // the Bone canvas and its white raised surfaces.
  muted: '#70695d', faint: '#777064',
  accent: '#b8451f', accentF: '#f4dccf',
  select: '#c48300', selectF: '#f8eccf',
  digest: '#2f6b4e', digestF: '#d7e7df',
  mauve: '#6d4aa8', mauveF: '#ebe4f6',
  danger: '#a8261a',
};

export const SLATE: TerminalTokens = {
  bg: '#f3f4f6', bgDeep: '#ffffff', surface: '#ffffff', alt: '#e5e7eb', alt2: '#d8dbe1',
  line: '#d1d5db', lineS: '#9ca3af', fg: '#111827', mid: '#4b5563',
  muted: '#6b7280', faint: '#9ca3af',
  accent: '#1a4d8f', accentF: '#dbeafe',
  select: '#c48300', selectF: '#fef3c7',
  digest: '#2f6b4e', digestF: '#d1fae5',
  mauve: '#6d4aa8', mauveF: '#ede9fe',
  danger: '#b91c1c',
};

export const MONOKAI: TerminalTokens = {
  bg: '#272822', bgDeep: '#1d1e19', surface: '#2d2e28', alt: '#383930', alt2: '#3e3f38',
  line: '#49483e', lineS: '#75715e', fg: '#f8f8f2', mid: '#c0c0b8',
  muted: '#8a8a7e', faint: '#75715e',
  accent: '#a6e22e', accentF: '#1e2a10',
  select: '#e6db74', selectF: '#2a2810',
  digest: '#a6e22e', digestF: '#1a2210',
  mauve: '#ae81ff', mauveF: '#1e1428',
  danger: '#f92672',
};

export const GRUVBOX: TerminalTokens = {
  bg: '#282828', bgDeep: '#1d1d1d', surface: '#2e2e2e', alt: '#3c3836', alt2: '#504945',
  line: '#504945', lineS: '#665c54', fg: '#ebdbb2', mid: '#a89984',
  muted: '#928374', faint: '#665c54',
  accent: '#fabd2f', accentF: '#2a2410',
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
    // Override Tailwind prose body/heading colors so markdown content inside
    // the terminal shell uses the palette foreground instead of the default
    // gray (which is nearly invisible on light palettes like bone/slate).
    '--tw-prose-body': p.fg,
    '--tw-prose-headings': p.fg,
    '--tw-prose-bold': p.fg,
    '--tw-prose-code': p.fg,
    '--tw-prose-links': p.accent,
    // Motion tokens — see docs/superpowers/plans/2026-04-29-terminal-motion-foundation.md
    '--t-quick': '60ms',
    '--t-soft': '100ms',
    '--t-decay': '360ms',
    '--t-ease': 'cubic-bezier(.2, 0, .6, 1)',
    // Selection bar inverted tokens — light theme gets dark popup, dark gets light popup.
    '--sel-bar-bg': isLight ? '#26262a' : '#ffffff',
    '--sel-bar-fg': isLight ? '#f0f0f0' : '#1a1916',
    '--sel-bar-mid': isLight ? '#b0b0b0' : '#5a544a',
    '--sel-bar-muted': isLight ? '#808080' : '#70695d',
    '--sel-bar-line': isLight ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
    '--sel-bar-hover': isLight ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    '--sel-bar-shadow': isLight
      ? '0 2px 8px rgba(0,0,0,0.35), 0 16px 40px rgba(0,0,0,0.25)'
      : '0 1px 2px rgba(0,0,0,0.08), 0 12px 34px rgba(0,0,0,0.10)',
  };
}
