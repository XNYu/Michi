import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTES } from '../components/terminal/tokens';
import { fetchPrefs, savePrefs } from '../services/api';
import type { VibrancyMaterial } from '../lib/electronBridge';

export type TerminalPalette = 'bone' | 'slate' | 'monokai' | 'gruvbox';
export type TerminalDensity = 'comfortable' | 'compact' | 'dense';
/** Vertical density of the LEFT SIDEBAR's rows only. Independent of
 *  `terminalDensity` (which governs message/pane spacing) so the tree can
 *  breathe without loosening chat messages. */
export type SidebarDensity = 'compact' | 'comfortable' | 'airy';

/** Assistant code-block chrome. Two design variants:
 *  - 'hairline' (01): no header bar - language sits as a faint mono overline,
 *    copy reveals on hover, recessed paper fill. Quietest.
 *  - 'header'   (02): classic terminal - divider bar with a lowercase
 *    language label. */
export type CodeBlockStyle = 'hairline' | 'header';

/** UI font presets the user can A/B test. Each preset resolves to a full
 *  CSS font-family stack in the effect that sets `--ui-font`. Order matches
 *  the picker order in Settings → Interface font. */
export type UiFont = 'IBM Plex Sans' | 'Inter' | 'Geist';

export const UI_FONT_OPTS: readonly UiFont[] = [
  'Geist',
  'IBM Plex Sans',
  'Inter',
] as const;

/** Message body Latin-font presets. Each resolves to a `--message-latin-font`
 *  stack plus a paired `--message-code-font` (for message code blocks) in the
 *  effect below. CJK glyphs are unaffected — they always render in the
 *  `--message-cjk-font` (PingFang) tail appended by the .terminal-message CSS. */
export type MessageFont = 'Source Serif 4' | 'Geist';

export const MESSAGE_FONT_OPTS: readonly MessageFont[] = [
  'Source Serif 4',
  'Geist',
] as const;

export interface Prefs {
  fontFamily: 'sans' | 'serif' | 'mono';
  /** When true, show the agent's streamed reasoning (agent_thought_chunk) + execution plan inside the assistant message. */
  showThoughts: boolean;
  terminalPalette: TerminalPalette;
  /** Per-palette accent override. Missing key → palette's built-in accent.
   *  Resolve via `resolveAccent(prefs, palette)` from `tokens.ts`. */
  terminalAccentOverrides: Partial<Record<TerminalPalette, string>>;
  /** Interface font — every UI element (sidebar, tabs, dialogs, buttons, kbd
   *  hints, badges, code blocks). Drives --ui-font. Message bodies are
   *  controlled separately by the .terminal-message CSS scope. */
  uiFont: UiFont;
  /** Message body Latin font — assistant prose + user bubble. Drives
   *  --message-latin-font and --message-code-font. CJK stays PingFang. */
  messageFont: MessageFont;
  /** Body text size for chat messages (user + assistant). Drives --message-body-size. */
  messageFontSize: number;
  /** Font size for the composer input area. Drives --composer-body-size. */
  composerFontSize: number;
  /** Assistant code-block chrome. Drives the `data-code-block` attribute on
   *  <html>; the visual treatment lives in index.css (`.michi-code-*`). */
  codeBlockStyle: CodeBlockStyle;
  /** When true, long lines inside assistant code/text blocks wrap at the
   *  container edge instead of horizontally scrolling. Drives the
   *  `data-code-wrap` attribute on <html>; the wrap CSS lives in index.css.
   *  Default off (preserves the scroll behaviour). */
  codeWrap: boolean;
  terminalDensity: TerminalDensity;
  /** When true, draw a 1px hairline between panes (and between caption-row
   *  cells in the topbar). Off = panes butt up against each other with no
   *  visible seam. */
  paneRules: boolean;
  /** Width of the terminal shell's left sidebar, in CSS pixels. Resizable via drag handle. */
  terminalSidebarWidth: number;
  /** Row density of the left sidebar (workspace / thread / branch rows + bottom
   *  nav). Drives the `--sb-*` CSS vars (row padding, font size, workspace group
   *  gap, timestamp size) set on the sidebar root in Sidebar.tsx. */
  sidebarDensity: SidebarDensity;
  /** Horizontal gutter (px) between the sidebar's content and its left/right
   *  edges. Added on top of each row's own padding via the `--sb-inset` CSS
   *  var (0 = current flush look). */
  sidebarInset: number;
  /** Sidebar glass translucency, 0–100. 0 = solid surface (opaque), 100 = maximally
   *  see-through. Under macOS window vibrancy this sets how much the desktop shows
   *  through; without vibrancy it just controls the CSS-glass tint. Drives
   *  --term-sidebar-translucency (a 0..1 alpha) on <html>. */
  sidebarTranslucency: number;
  /** Glass blur radius in px (0–40, default 26). Drives --term-glass-blur, shared
   *  by the sidebar and every .term-glass overlay. */
  glassBlur: number;
  /** Glass backdrop saturation in % (100–220, default 160). Drives
   *  --term-glass-saturate. */
  glassSaturate: number;
  /** Glass accent-wash strength in % (0–200, default 100). Scales the accent/mauve
   *  tint via --term-glass-wash-strength (pref / 100). */
  glassTint: number;
  /** Glass depth in % (0–200, default 100). Scales the inner highlight + drop
   *  shadow together via --term-glass-depth (pref / 100). */
  glassDepth: number;
  /** Sidebar's native macOS vibrancy material (Electron+macOS only). Lightest →
   *  densest: under-window < sidebar < menu < hud. Applied via
   *  window.electron.setVibrancy; ignored on web / Windows / Linux. */
  sidebarVibrancy: VibrancyMaterial;
  /** When true, the docked terminal sidebar is hidden and a hover popover replaces it.
   *  Toggled via ⌘B and the topbar icon. */
  sidebarCollapsed: boolean;
  /** Days a soft-deleted node stays in the trash before being purged. 0 = never auto-purge. */
  trashTTLDays: number;
  /** How much to dim unfocused panes. 0 = no dimming, 100 = maximum dimming. */
  focusDim: number;
  /** Height in px of the soft fade at the top of each pane where content scrolls into the title area. 0 disables. */
  paneTopFadeHeight: number;
  /** When to show OS/toast notifications. 'all' = done + approval, 'approval-only' = only permission requests, 'off' = none */
  notifications: 'all' | 'approval-only' | 'off';
  /** Default width (px) for new dashboard panes that have no explicit width set. */
  defaultPaneWidth: number;
  /** Maximum content column width when only one pane is open. null = full width. */
  singlePaneContentWidth: number | null;
  /** How many lines of quoted text to show in the composer's quote bar before clamping. 1 = single-line ellipsis. */
  quoteMaxLines: number;
  /** When true, ask kiro to end every reply by calling set_follow_ups. Disable to skip the 2-5s tail latency when you don't use follow-up suggestions. */
  enableFollowUps: boolean;
  /** When true, auto-approve all tool permission requests without showing the banner. */
  bypassPermissions: boolean;
  /** Sparse maps of user-toggled expand state. Missing keys fall back to defaults
   *  computed by sidebarSelectors. Persists across sessions via the existing
   *  500ms debounce. */
  sidebarExpanded: {
    workspaces: Record<string, boolean>;
    threads: Record<string, boolean>;
    branches: Record<string, boolean>;
  };
  /** Sparse user-defined sidebar order for live workspaces. Project IDs not
   *  present here render first, sorted by createdAt DESC. IDs present here
   *  render after, in array order. Stale IDs (deleted/archived projects)
   *  are ignored at sort time, not pruned eagerly. */
  workspaceOrder: string[];
}

export const DEFAULT_PREFS: Prefs = {
  fontFamily: 'sans',
  showThoughts: true,
  terminalPalette: 'bone',
  terminalAccentOverrides: {},
  uiFont: 'Geist',
  messageFont: 'Source Serif 4',
  messageFontSize: 15,
  composerFontSize: 15,
  codeBlockStyle: 'header',
  codeWrap: false,
  terminalDensity: 'dense',
  paneRules: true,
  terminalSidebarWidth: 232,
  sidebarDensity: 'comfortable',
  sidebarInset: 2,
  sidebarTranslucency: 60,
  glassBlur: 10,
  glassSaturate: 130,
  glassTint: 30,
  glassDepth: 30,
  sidebarVibrancy: 'under-window',
  sidebarCollapsed: false,
  trashTTLDays: 30,
  focusDim: 20,
  paneTopFadeHeight: 30,
  notifications: 'all',
  defaultPaneWidth: 600,
  singlePaneContentWidth: 800,
  quoteMaxLines: 2,
  enableFollowUps: true,
  bypassPermissions: false,
  sidebarExpanded: { workspaces: {}, threads: {}, branches: {} },
  workspaceOrder: [],
};

const PREFS_KEY = 'michi:v1:prefs';
const VALID_PALETTES: ReadonlySet<TerminalPalette> = new Set([
  'bone',
  'slate',
  'monokai',
  'gruvbox',
]);

function readInitial(): Prefs {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
  const raw = window.localStorage.getItem(PREFS_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_PREFS, ...parsed };
    delete (merged as { theme?: string }).theme;
    if (!VALID_PALETTES.has(merged.terminalPalette)) {
      merged.terminalPalette = DEFAULT_PREFS.terminalPalette;
    }
    // Migrate legacy single `terminalAccent` field into per-palette overrides.
    if (
      !merged.terminalAccentOverrides ||
      typeof merged.terminalAccentOverrides !== 'object'
    ) {
      merged.terminalAccentOverrides = {};
    }
    if (typeof parsed.terminalAccent === 'string') {
      const paletteDefault = PALETTES[merged.terminalPalette as TerminalPalette].accent;
      if (parsed.terminalAccent !== paletteDefault) {
        merged.terminalAccentOverrides = {
          ...merged.terminalAccentOverrides,
          [merged.terminalPalette]: parsed.terminalAccent,
        };
      }
    }
    delete (merged as { terminalAccent?: string }).terminalAccent;
    // Drop legacy mono/prose font fields (replaced by uiFont).
    delete (merged as { terminalMonoFont?: string }).terminalMonoFont;
    delete (merged as { terminalProseFont?: string }).terminalProseFont;
    // Migrate legacy terminalRules object into the flat paneRules boolean.
    // Old shape: { panes, treeRows, ascii } — only `panes` survives.
    if (parsed.terminalRules && typeof parsed.terminalRules === 'object') {
      if (typeof parsed.terminalRules.panes === 'boolean') {
        merged.paneRules = parsed.terminalRules.panes;
      }
    }
    delete (merged as { terminalRules?: unknown }).terminalRules;
    // Drop legacy userBubbleStyle picker (the variant explorations are gone;
    // D is now the only user-bubble treatment, hardcoded in CSS).
    delete (merged as { userBubbleStyle?: unknown }).userBubbleStyle;
    if (!UI_FONT_OPTS.includes(merged.uiFont as UiFont)) merged.uiFont = DEFAULT_PREFS.uiFont;
    if (typeof merged.messageFontSize !== 'number' || merged.messageFontSize < 11 || merged.messageFontSize > 28) {
      merged.messageFontSize = DEFAULT_PREFS.messageFontSize;
    }
    if (typeof merged.composerFontSize !== 'number' || merged.composerFontSize < 11 || merged.composerFontSize > 28) {
      merged.composerFontSize = DEFAULT_PREFS.composerFontSize;
    }
    if (merged.codeBlockStyle !== 'hairline' && merged.codeBlockStyle !== 'header') {
      merged.codeBlockStyle = DEFAULT_PREFS.codeBlockStyle;
    }
    if (typeof merged.codeWrap !== 'boolean') {
      merged.codeWrap = DEFAULT_PREFS.codeWrap;
    }
    if (typeof merged.paneTopFadeHeight !== 'number' || merged.paneTopFadeHeight < 0 || merged.paneTopFadeHeight > 80) {
      merged.paneTopFadeHeight = DEFAULT_PREFS.paneTopFadeHeight;
    }
    if (typeof merged.sidebarTranslucency !== 'number' || merged.sidebarTranslucency < 0 || merged.sidebarTranslucency > 100) {
      merged.sidebarTranslucency = DEFAULT_PREFS.sidebarTranslucency;
    }
    if (typeof merged.glassBlur !== 'number' || merged.glassBlur < 0 || merged.glassBlur > 40) {
      merged.glassBlur = DEFAULT_PREFS.glassBlur;
    }
    if (typeof merged.glassSaturate !== 'number' || merged.glassSaturate < 100 || merged.glassSaturate > 220) {
      merged.glassSaturate = DEFAULT_PREFS.glassSaturate;
    }
    if (typeof merged.glassTint !== 'number' || merged.glassTint < 0 || merged.glassTint > 200) {
      merged.glassTint = DEFAULT_PREFS.glassTint;
    }
    if (typeof merged.glassDepth !== 'number' || merged.glassDepth < 0 || merged.glassDepth > 200) {
      merged.glassDepth = DEFAULT_PREFS.glassDepth;
    }
    if (!['under-window', 'sidebar', 'menu', 'hud'].includes(merged.sidebarVibrancy)) {
      merged.sidebarVibrancy = DEFAULT_PREFS.sidebarVibrancy;
    }
    if (
      merged.sidebarDensity !== 'compact' &&
      merged.sidebarDensity !== 'comfortable' &&
      merged.sidebarDensity !== 'airy'
    ) {
      merged.sidebarDensity = DEFAULT_PREFS.sidebarDensity;
    }
    if (typeof merged.sidebarInset !== 'number' || merged.sidebarInset < 0 || merged.sidebarInset > 24) {
      merged.sidebarInset = DEFAULT_PREFS.sidebarInset;
    }
    if (
      merged.singlePaneContentWidth !== null &&
      merged.singlePaneContentWidth !== undefined &&
      (typeof merged.singlePaneContentWidth !== 'number' ||
        merged.singlePaneContentWidth < 480 ||
        merged.singlePaneContentWidth > 1280)
    ) {
      merged.singlePaneContentWidth = DEFAULT_PREFS.singlePaneContentWidth;
    }
    if (
      !merged.sidebarExpanded ||
      typeof merged.sidebarExpanded !== 'object' ||
      !merged.sidebarExpanded.workspaces ||
      !merged.sidebarExpanded.threads ||
      !merged.sidebarExpanded.branches
    ) {
      merged.sidebarExpanded = { workspaces: {}, threads: {}, branches: {} };
    }
    if (
      !Array.isArray(merged.workspaceOrder) ||
      !merged.workspaceOrder.every((id: unknown) => typeof id === 'string')
    ) {
      merged.workspaceOrder = [];
    }
    return merged;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

interface PrefsContextValue {
  prefs: Prefs;
  setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void;
  reset(): void;
  /** Reset only the terminal appearance fields to defaults. */
  resetTerminal(): void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(readInitial);
  const hydratedFromBackend = useRef(false);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (hydratedFromBackend.current) return;
    hydratedFromBackend.current = true;
    const hadLocal = !!window.localStorage.getItem(PREFS_KEY);
    fetchPrefs().then((remote) => {
      if (!remote) return;
      if (hadLocal) return;
      setPrefs({ ...DEFAULT_PREFS, ...remote } as Prefs);
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handle = setTimeout(() => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch (err) {
        console.warn('prefs persist failed:', err);
      }
      savePrefs(prefs as unknown as Record<string, unknown>);
    }, 500);
    return () => clearTimeout(handle);
  }, [prefs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefsRef.current));
      } catch { /* best-effort */ }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-terminal-palette', prefs.terminalPalette);
  }, [prefs.terminalPalette]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--message-body-size-base', `${prefs.messageFontSize}px`);
  }, [prefs.messageFontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.style.setProperty('--composer-body-size', `${prefs.composerFontSize}px`);
  }, [prefs.composerFontSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 0..100 pref → 0..1 alpha. This is the sidebar's SOLIDNESS: higher pref =
    // more see-through = LOWER surface alpha. index.css reads this for both the
    // CSS-glass path and the native-vibrancy tint so one slider drives both.
    const solidAlpha = (1 - prefs.sidebarTranslucency / 100).toFixed(3);
    document.documentElement.style.setProperty('--term-sidebar-solid-alpha', solidAlpha);
  }, [prefs.sidebarTranslucency]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Glass material knobs, shared by the sidebar + every .term-glass overlay.
    // blur/saturate are direct units; tint/depth are 0..2 multipliers (pref/100)
    // that scale the wash colour and the highlight+shadow inside index.css.
    const s = document.documentElement.style;
    s.setProperty('--term-glass-blur', `${prefs.glassBlur}px`);
    s.setProperty('--term-glass-saturate', `${prefs.glassSaturate}%`);
    s.setProperty('--term-glass-wash-strength', (prefs.glassTint / 100).toFixed(3));
    s.setProperty('--term-glass-depth', (prefs.glassDepth / 100).toFixed(3));
  }, [prefs.glassBlur, prefs.glassSaturate, prefs.glassTint, prefs.glassDepth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-code-block', prefs.codeBlockStyle);
  }, [prefs.codeBlockStyle]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.setAttribute('data-code-wrap', prefs.codeWrap ? 'on' : 'off');
  }, [prefs.codeWrap]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Resolve preset → full CSS font-family stack. Sans presets all share
    // the same `--ui-cjk-font` tail so CJK text renders identically across
    // them; only the Latin glyphs change. Mono preset has no CJK tail —
    // CJK in mono looks broken, so we drop it.
    const sansTail = `system-ui, -apple-system, sans-serif, var(--ui-cjk-font)`;
    const plexMono = `'IBM Plex Mono', Menlo, ui-monospace, monospace`;
    // Each preset declares both its UI stack and its paired mono stack.
    // Mono is used by code blocks, tool calls, tabular numbers — Geist
    // pairs with Geist Mono; the others fall back to IBM Plex Mono.
    const [stack, monoStack]: [string, string] = (() => {
      switch (prefs.uiFont) {
        case 'Geist':
          return [`'Geist', ${sansTail}`, `'Geist Mono', ${plexMono}`];
        case 'IBM Plex Sans':
          return [`'IBM Plex Sans', ${sansTail}`, plexMono];
        case 'Inter':
          return [`'Inter', ${sansTail}`, plexMono];
      }
    })();
    document.documentElement.style.setProperty('--ui-font', stack);
    document.documentElement.style.setProperty('--font-mono', monoStack);
  }, [prefs.uiFont]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Resolve the message-font preset → Latin body stack + paired code stack.
    // CJK is untouched: .terminal-message appends `, var(--message-cjk-font)`.
    // Code (inline + fenced blocks) is always monospace so diagrams/tables
    // stay aligned: 'Geist' pairs Geist Sans prose with Geist Mono; 'Source
    // Serif 4' pairs the serif body with IBM Plex Mono.
    const [latin, code]: [string, string] = (() => {
      switch (prefs.messageFont) {
        case 'Geist':
          return [
            `'Geist', system-ui, -apple-system, sans-serif`,
            `'Geist Mono', 'IBM Plex Mono', Menlo, ui-monospace, monospace`,
          ];
        case 'Source Serif 4':
          return [
            `'Source Serif 4', Georgia, serif`,
            `'IBM Plex Mono', 'Fira Mono', ui-monospace, SFMono-Regular, Menlo, monospace`,
          ];
      }
    })();
    document.documentElement.style.setProperty('--message-latin-font', latin);
    document.documentElement.style.setProperty('--message-code-font', code);
  }, [prefs.messageFont]);

  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setPrefs({ ...DEFAULT_PREFS });
  }, []);

  const resetTerminal = useCallback(() => {
    setPrefs((prev) => ({
      ...prev,
      terminalPalette: DEFAULT_PREFS.terminalPalette,
      terminalAccentOverrides: { ...DEFAULT_PREFS.terminalAccentOverrides },
      uiFont: DEFAULT_PREFS.uiFont,
      messageFont: DEFAULT_PREFS.messageFont,
      messageFontSize: DEFAULT_PREFS.messageFontSize,
      composerFontSize: DEFAULT_PREFS.composerFontSize,
      codeBlockStyle: DEFAULT_PREFS.codeBlockStyle,
      codeWrap: DEFAULT_PREFS.codeWrap,
      terminalDensity: DEFAULT_PREFS.terminalDensity,
      paneRules: DEFAULT_PREFS.paneRules,
      terminalSidebarWidth: DEFAULT_PREFS.terminalSidebarWidth,
      sidebarDensity: DEFAULT_PREFS.sidebarDensity,
      sidebarInset: DEFAULT_PREFS.sidebarInset,
      paneTopFadeHeight: DEFAULT_PREFS.paneTopFadeHeight,
    }));
  }, []);

  const value = useMemo(
    () => ({ prefs, setPref, reset, resetTerminal }),
    [prefs, setPref, reset, resetTerminal],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const v = useContext(PrefsContext);
  if (!v) throw new Error('usePrefs must be used within a PrefsProvider');
  return v;
}
