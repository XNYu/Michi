/**
 * Sidebar row-style modes — the "direction B" experiments, switchable at
 * runtime from Settings → Appearance → Sidebar row style.
 *
 * `classic` is the historical look and MUST stay byte-identical in behaviour:
 * every call site keeps its original literals on that path and only branches
 * into the computed geometry below for the three B modes. That way the default
 * install is untouched and switching back is a real escape hatch.
 *
 * The three B modes differ ONLY in corner radius and fill width. Every text
 * spine is identical across them (20 / 36 / 52), which is the whole point —
 * when you flip between them in the app you're judging the corners, not an
 * accidental alignment change. `rowGeom` is the single source of that math;
 * see sidebarRowStyle.test.ts for the spine assertions.
 */

export type SidebarRowStyle =
  | 'classic'
  | 'rounded-inset'
  | 'square-inset'
  | 'square-full';

export const SIDEBAR_ROW_STYLES: readonly SidebarRowStyle[] = [
  'classic',
  'rounded-inset',
  'square-inset',
  'square-full',
];

/** Human-facing one-liners for the Settings radio. */
export const SIDEBAR_ROW_STYLE_LABELS: Record<SidebarRowStyle, string> = {
  'classic': 'classic — full-bleed rows, left accent bar (current)',
  'rounded-inset': 'rounded inset — 8px inset, 8px radius',
  'square-inset': 'square inset — 8px inset, no radius',
  'square-full': 'square full-bleed — no inset, no radius',
};

export interface RowGeom {
  style: SidebarRowStyle;
  /** True for the three B modes; false for `classic`. */
  isCard: boolean;
  /** Horizontal gutter between the scroll container and the sidebar edges. */
  inset: number;
  /** Row corner radius. */
  radius: number;
  /** How far each row's box is pulled back out past the container inset.
   *  `classic` cancels the inset entirely (full-bleed so its borderLeft hugs
   *  the true edge); the B modes keep the row inside the gutter so the fill
   *  reads as a contained block. */
  bleed: number;
  /** Width of the left edge indicator strip. 0 in B modes — there the focus
   *  fill carries selection, and "open but idle" is a separate inset bar. */
  barW: number;
  /** Absolute x of the row title. */
  titleX: number;
  /** Per-depth indent step for branch rows. */
  indentStep: number;
  /** Absolute x where the branch text block starts. */
  guideX: number;
  /** Absolute x of a depth-1 branch title. */
  branchX: number;
  /** Gap kept clear on the right, measured from the sidebar's right edge. */
  rightGap: number;
  /** Leading chevron (classic) vs. a trailing expand caret (B modes). */
  chevronLeading: boolean;
  /** Render the workspace-name subtitle INSIDE the row container, so the focus
   *  fill covers both lines. Classic keeps it as a sibling div below the row. */
  subtitleInRow: boolean;
  /** Reserved: a vertical guide line down the branch block. Off everywhere —
   *  in practice it read as a stray rule next to the indent it was reinforcing,
   *  and the indent alone carries depth fine. */
  guideLine: boolean;
  /** Structure view renders the workspace as a quiet group header (same shape
   *  as Activity's Today/Yesterday) rather than a clickable row. */
  workspaceAsHeader: boolean;
}

/** Shared spine ladder for every B mode. Keep in sync with the mock at
 *  docs/mocks/2026-08-27-sidebar-B-switch.html. */
const B_TITLE_X = 20;
const B_INDENT_STEP = 16;
const B_RIGHT_GAP = 16;

function bMode(style: SidebarRowStyle, inset: number, radius: number): RowGeom {
  return {
    style,
    isCard: true,
    inset,
    radius,
    bleed: 0,
    barW: 0,
    titleX: B_TITLE_X,
    indentStep: B_INDENT_STEP,
    guideX: B_TITLE_X,
    branchX: B_TITLE_X + B_INDENT_STEP,
    rightGap: B_RIGHT_GAP,
    chevronLeading: false,
    subtitleInRow: true,
    guideLine: false,
    workspaceAsHeader: true,
  };
}

/**
 * @param style  the active pref
 * @param insetPref  `prefs.sidebarInset`, honoured only by `classic` (the B
 *   modes pin their own inset so flipping between them is a controlled A/B)
 */
export function rowGeom(style: SidebarRowStyle, insetPref: number): RowGeom {
  switch (style) {
    case 'rounded-inset':
      return bMode('rounded-inset', 8, 8);
    case 'square-inset':
      return bMode('square-inset', 8, 0);
    case 'square-full':
      return bMode('square-full', 0, 0);
    case 'classic':
    default:
      return {
        style: 'classic',
        isCard: false,
        inset: insetPref,
        radius: 0,
        bleed: insetPref,
        barW: 2,
        // border(2) + paddingLeft(8 + inset) + chevron(12) + gap(5)
        titleX: 27 + insetPref,
        indentStep: 10,
        guideX: 0,
        branchX: 2 + (8 + 10 + insetPref) + 12 + 6,
        rightGap: 10 + insetPref,
        chevronLeading: true,
        subtitleInRow: false,
        guideLine: false,
        workspaceAsHeader: false,
      };
  }
}

/** Row padding for a thread/branch row, given an extra indent in px.
 *  Content lands at `titleX + indent` regardless of inset/bleed:
 *    boxX(inset - bleed) + barW + paddingLeft  ==  titleX + indent
 *  Classic keeps its own inline literals, so this is only used by B modes. */
export function rowPadding(g: RowGeom, indent = 0): { paddingLeft: string; paddingRight: string } {
  const boxX = g.inset - g.bleed;
  return {
    paddingLeft: `${g.titleX + indent - boxX - g.barW}px`,
    paddingRight: `${g.rightGap - boxX}px`,
  };
}

/** Left padding for a plain (non-row) element that should sit on an absolute
 *  spine — section labels, "Show more", empty states. These are children of the
 *  inset container and get no negative margin, so they simply subtract it. */
export function spinePadding(g: RowGeom, x: number): string {
  return `${x - g.inset}px`;
}

/** Horizontal space the hover-revealed ⋯ occupies at a row's right edge in card
 *  modes: a 16px button plus the 6px padding-right the card-mode rule gives its
 *  wrapper (see `.row-kebab` in index.css). The wrapper is `right: 0` against
 *  the row's PADDING box. */
const KEBAB_FOOTPRINT = 22;
/** Air between the trailing expand caret and the kebab. */
const CARET_KEBAB_GAP = 2;

/** Right margin the trailing expand caret needs so the ⋯ never lands on top of
 *  it.
 *
 *  The caret is a flex item inside the row's CONTENT box — already inset by
 *  `rowPadding().paddingRight` — while the kebab is absolute against the padding
 *  box. So a mode with a wider right padding needs LESS margin, and a single
 *  shared constant necessarily over-reserves for one of them: at 22 everywhere,
 *  the inset modes pushed the caret 14px further in than needed and the
 *  caret/⋯ cluster ate visibly too much of the row.
 *
 *  Reserved unconditionally rather than only while hovered, so the caret doesn't
 *  jump sideways as the pointer enters the row. */
export function caretKebabClearance(g: RowGeom): number {
  if (!g.isCard) return 0;
  const paddingRight = parseFloat(rowPadding(g).paddingRight);
  return Math.max(0, KEBAB_FOOTPRINT + CARET_KEBAB_GAP - paddingRight);
}

/** Vertical gap between a thread row and its first branch row.
 *
 *  0 in card modes on purpose: when a thread AND its first branch are both
 *  highlighted, any gap shows as a slot of un-filled background cutting the
 *  selection in two. Branch rows are already full-row-width (they carry the
 *  indent in their own padding), so flush stacking reads as one block. */
export function branchBlockGap(g: RowGeom): number {
  return g.isCard ? 0 : 1;
}
