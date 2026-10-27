import React, { useId, useMemo, createContext, useContext } from 'react';
import {
  ActionIcon,
  Button,
  Checkbox,
  Combobox,
  Input,
  MantineProvider,
  Popover,
  Portal,
  TextInput,
  Tooltip,
  createTheme,
  type CSSVariablesResolver,
  type MantineColorSchemeManager,
  type MantineColorsTuple,
} from '@mantine/core';
import './michiMantine.css';
import { usePagePalette } from '../../../../../state/prefs';
import { DARK_PALETTES } from '../../../tokens';
const VisualScope = createContext(false);

// Placeholder tuple: Mantine wants hex values here; every variable it derives from them is replaced below.
const michi: MantineColorsTuple = ['#eef2f8', '#dbe4f1', '#b6c8e3', '#8eaad3', '#5f86bf', '#3a68ab', '#1a4d8f', '#163f75', '#11315c', '#0c2342'];

/**
 * Mantine draws its sizes for 16px text, which is Michi's root size, so its
 * lengths stay as drawn; components default to the compact sizes Desk picks
 * (agent-desk src/desk/mantine.tsx). Its font sizes are Michi's type scale,
 * one step under Mantine's at each size, so a control's words match the
 * page's chrome (--fs-lg, 13px, at the size most controls use).
 */
const FONT_SIZES = { xs: 'var(--fs-sm)', sm: 'var(--fs-lg)', md: 'var(--fs-xl)', lg: 'var(--fs-2xl)', xl: 'var(--fs-3xl)' };

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, var(${a}) ${pct}%, var(${b}))`;

/** Michi's palette tokens for everything Mantine paints, in both schemes; values are variables, so one map follows every palette. */
const shared: Record<string, string> = {
  '--mantine-radius-default': 'var(--ui-radius)',
  // Mantine paints raised controls (the carousel's arrows, dropdowns in light mode) white on black.
  '--mantine-color-white': 'var(--term-surface)',
  '--mantine-color-black': 'var(--term-fg)',
  '--mantine-color-body': 'var(--term-bg)',
  '--mantine-color-text': 'var(--term-fg)',
  '--mantine-color-bright': 'var(--term-fg)',
  '--mantine-color-dimmed': 'var(--term-muted)',
  '--mantine-color-placeholder': 'var(--term-faint)',
  '--mantine-color-anchor': 'var(--term-accent)',
  '--mantine-color-error': 'var(--term-danger)',
  '--mantine-color-default': 'var(--term-surface)',
  '--mantine-color-default-hover': 'var(--term-alt)',
  '--mantine-color-default-color': 'var(--term-fg)',
  '--mantine-color-default-border': 'var(--term-line)',
  '--mantine-primary-color-filled': 'var(--term-accent)',
  '--mantine-primary-color-filled-hover': mix('--term-accent', 85, '--term-fg'),
  '--mantine-primary-color-light': 'var(--term-accent-f)',
  '--mantine-primary-color-light-hover': mix('--term-accent', 22, '--term-bg'),
  '--mantine-primary-color-light-color': 'var(--term-accent)',
  '--mantine-primary-color-contrast': 'var(--term-bg)',
  // A component given the primary colour by name reads the colour's own variables, not the primary-color ones.
  '--mantine-color-michi-filled': 'var(--term-accent)',
  '--mantine-color-michi-filled-hover': mix('--term-accent', 85, '--term-fg'),
  '--mantine-color-michi-light': 'var(--term-accent-f)',
  '--mantine-color-michi-light-hover': mix('--term-accent', 22, '--term-bg'),
  '--mantine-color-michi-light-color': 'var(--term-accent)',
  '--mantine-color-michi-outline': 'var(--term-accent)',
  '--mantine-color-michi-outline-hover': 'var(--term-accent-f)',
  '--mantine-color-michi-text': 'var(--term-accent)',
  ...Object.fromEntries([10, 20, 35, 50, 70, 85].map((pct, i) => [`--mantine-color-michi-${i}`, mix('--term-accent', pct, '--term-bg')])),
  '--mantine-color-michi-6': 'var(--term-accent)',
  ...Object.fromEntries([85, 70, 55].map((pct, i) => [`--mantine-color-michi-${i + 7}`, mix('--term-accent', pct, '--term-fg')])),
  // The scales Mantine's component sheets read for hovers, borders and quiet text.
  '--mantine-color-gray-0': mix('--term-alt', 50, '--term-surface'),
  '--mantine-color-gray-1': 'var(--term-alt)',
  '--mantine-color-gray-2': 'var(--term-alt2)',
  '--mantine-color-gray-3': 'var(--term-line)',
  '--mantine-color-gray-4': 'var(--term-line-s)',
  '--mantine-color-gray-5': 'var(--term-faint)',
  '--mantine-color-gray-6': 'var(--term-muted)',
  '--mantine-color-gray-7': 'var(--term-mid)',
  '--mantine-color-gray-8': mix('--term-fg', 80, '--term-mid'),
  '--mantine-color-gray-9': 'var(--term-fg)',
  '--mantine-color-dark-0': 'var(--term-fg)',
  '--mantine-color-dark-1': 'var(--term-mid)',
  '--mantine-color-dark-2': 'var(--term-muted)',
  '--mantine-color-dark-3': 'var(--term-faint)',
  // Dark mode draws input borders and unchecked rings in dark-4: the stronger line, as light mode's gray-4.
  '--mantine-color-dark-4': 'var(--term-line-s)',
  '--mantine-color-dark-5': 'var(--term-alt2)',
  '--mantine-color-dark-6': 'var(--term-alt)',
  '--mantine-color-dark-7': 'var(--term-surface)',
  '--mantine-color-dark-8': 'var(--term-bg)',
  '--mantine-color-dark-9': mix('--term-bg', 80, '--term-fg'),
};

const resolver: CSSVariablesResolver = () => ({ variables: {}, light: shared, dark: shared });

const ROOT_ATTR = 'data-michi-mantine';

/** The scheme follows Michi's palette (forceColorScheme); Mantine keeps no choice of its own in localStorage. */
const noStoredScheme: MantineColorSchemeManager = {
  get: (fallback) => fallback,
  set: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  clear: () => {},
};

function themeFor(root: string) {
  return createTheme({
    colors: { michi },
    primaryColor: 'michi',
    fontFamily: 'var(--ui-font)',
    fontFamilyMonospace: 'var(--font-mono)',
    headings: { fontFamily: 'var(--ui-font)' },
    fontSizes: FONT_SIZES,
    components: {
      // The variables live on this subtree only, so a portal to <body> would lose them; each page keeps its own.
      Portal: Portal.extend({ defaultProps: { target: root } }),
      // A dropdown that is open takes Esc before the page does (escapeLayers.ts), wherever the focus is.
      Popover: Popover.extend({ defaultProps: { attributes: { dropdown: { 'data-escape-layer': 'over' } } } }),
      // Mantine keeps a closed Select's list mounted (display:none) by default; a list still in the page would take every Esc.
      Combobox: Combobox.extend({ defaultProps: { keepMounted: false } }),
      ActionIcon: ActionIcon.extend({ defaultProps: { size: 'sm' } }),
      Button: Button.extend({ defaultProps: { size: 'xs' } }),
      Checkbox: Checkbox.extend({ defaultProps: { size: 'xs' } }),
      Input: Input.extend({ defaultProps: { size: 'sm' } }),
      TextInput: TextInput.extend({ defaultProps: { size: 'sm' } }),
      Tooltip: Tooltip.extend({ styles: { tooltip: { fontSize: 'var(--mantine-font-size-xs)' } } }),
    },
  });
}

/**
 * Mantine for one subtree of Michi (a Desk page's blocks): its variables and
 * colour-scheme attribute sit on this wrapper, never on :root, and its
 * popovers portal into it. The wrapper takes no box of its own.
 */
export function MichiMantine({ dark: override, children }: { dark?: boolean; children: React.ReactNode }) {
  const palette = usePagePalette();
  const parent = useContext(VisualScope);
  const dark = override ?? DARK_PALETTES.has(palette);
  const id = useId();
  // React ids hold no quotes or backslashes, so the id needs no escaping inside the quoted value.
  const selector = `[${ROOT_ATTR}="${id}"]`;
  const theme = useMemo(() => themeFor(selector), [selector]);
  if (parent) return <>{children}</>;
  return (
    // `michi-page`: Desk's code finds the page it sits in by this class (its contents block looks for blocks there).
    <div className="michi-mantine michi-page" {...{ [ROOT_ATTR]: id }}>
      <MantineProvider
        theme={theme}
        forceColorScheme={dark ? 'dark' : 'light'}
        // The first frame too: Mantine writes the default scheme before the forced one.
        defaultColorScheme={dark ? 'dark' : 'light'}
        colorSchemeManager={noStoredScheme}
        cssVariablesSelector=".michi-mantine"
        cssVariablesResolver={resolver}
        withGlobalClasses={false}
        getRootElement={() => document.querySelector<HTMLElement>(selector) ?? undefined}
      >
        <VisualScope.Provider value={true}>{children}</VisualScope.Provider>
      </MantineProvider>
    </div>
  );
}
