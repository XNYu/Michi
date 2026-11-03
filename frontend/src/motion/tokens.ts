import type { Transition } from 'motion/react';

/**
 * Motion tokens for `motion` (motion.dev): the JS mirror of the CSS duration
 * tokens in index.css (`--t-*`) and the shared curves already used by
 * DrawerShell, paneMotion and branchMotion. Durations are in seconds.
 * tokens.css.test.js keeps them in step with index.css.
 *
 * Loops (shimmer, spinners, breathing dots, carets) stay in CSS; these are for
 * enter/exit, layout and disclosure transitions.
 */
export const DUR = {
  // Mirrors --t-quick … --t-slow and --t-exit.
  quick: 0.06,
  soft: 0.1,
  enter: 0.18,
  /** Exits run a little faster than their entrances. */
  exit: 0.11,
  decay: 0.36,
  slow: 0.6,
  // motion only (no CSS counterpart).
  /** Disclosure bodies: "collapse fast, expand soft". */
  expand: 0.26,
  collapse: 0.16,
  /** A scrim clears just before the panel it dims has finished collapsing. */
  scrimExit: 0.14,
} as const;

type Bezier = [number, number, number, number];

export const EASE: Record<'out' | 'drawer' | 'inOut' | 'term', Bezier> = {
  /** DrawerShell's slide; the default for entrances. */
  out: [0.23, 1, 0.32, 1],
  /** = PANE_EASE: panels, disclosures, layout settles. */
  drawer: [0.32, 0.72, 0, 1],
  /** = branchMotion's flight: things travelling across the screen. */
  inOut: [0.77, 0, 0.175, 1],
  /** = --t-ease. */
  term: [0.2, 0, 0.6, 1],
};

export const SPRING = {
  /** Small things settling with no overshoot: icons, bubbles, chips. */
  snappy: { type: 'spring', visualDuration: 0.22, bounce: 0 },
  /** Shared-element flights (layoutId) and layout moves. */
  soft: { type: 'spring', visualDuration: 0.3, bounce: 0.12 },
  /** Rare, high-emotion moments only (task done, first run). */
  pop: { type: 'spring', visualDuration: 0.4, bounce: 0.3 },
} as const satisfies Record<string, Transition>;

/** Ready-made transitions for the common cases. */
export const TRANSITION = {
  enter: { duration: DUR.enter, ease: EASE.out },
  exit: { duration: DUR.exit, ease: EASE.out },
  expand: {
    height: { duration: DUR.expand, ease: EASE.drawer },
    opacity: { duration: 0.16, delay: 0.04, ease: 'linear' },
  },
  collapse: { duration: DUR.collapse, ease: EASE.drawer },
} as const satisfies Record<string, Transition>;
