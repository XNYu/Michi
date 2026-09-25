import { describe, it, expect } from 'vitest';
import {
  rowGeom,
  rowPadding,
  spinePadding,
  branchBlockGap,
  caretKebabClearance,
  SIDEBAR_ROW_STYLES,
  type SidebarRowStyle,
} from './sidebarRowStyle';

/** Resolve where a row's text actually lands, from the same numbers the
 *  components hand to CSS. Mirrors the browser's box model:
 *    box left = container inset − negative margin
 *    text     = box left + border + paddingLeft
 *  If this drifts from rowPadding(), the spine assertions below fail. */
function resolvedTextX(style: SidebarRowStyle, insetPref: number, indent = 0): number {
  const g = rowGeom(style, insetPref);
  const boxX = g.inset - g.bleed;
  return boxX + g.barW + parseFloat(rowPadding(g, indent).paddingLeft);
}

function resolvedRightEdge(style: SidebarRowStyle, insetPref: number, sidebarWidth: number): number {
  const g = rowGeom(style, insetPref);
  // Row box right edge = sidebarWidth − (inset − bleed)
  const boxRight = sidebarWidth - (g.inset - g.bleed);
  return boxRight - parseFloat(rowPadding(g).paddingRight);
}

const B_MODES: SidebarRowStyle[] = ['rounded-inset', 'square-inset', 'square-full'];

describe('rowGeom', () => {
  it('leaves classic on the historical spine (27 + inset)', () => {
    // The pre-existing literals: border 2 + paddingLeft(8 + inset) + chevron 12
    // + gap 5. At the shipped default inset of 2 that is x = 29.
    expect(rowGeom('classic', 2).titleX).toBe(29);
    expect(rowGeom('classic', 12).titleX).toBe(39);
    expect(rowGeom('classic', 2).barW).toBe(2);
    expect(rowGeom('classic', 2).radius).toBe(0);
    // Classic stays full-bleed: the row cancels the container inset entirely.
    expect(rowGeom('classic', 7).bleed).toBe(7);
  });

  it('ignores the inset pref in B modes so switching is a controlled A/B', () => {
    for (const m of B_MODES) {
      const a = rowGeom(m, 0);
      const b = rowGeom(m, 24);
      expect(a).toEqual(b);
    }
  });

  it('keeps the branch ladder on a constant 16px step', () => {
    for (const m of B_MODES) {
      const g = rowGeom(m, 2);
      expect(g.indentStep).toBe(16);
      expect(g.branchX - g.titleX).toBe(16);
      expect(g.guideX).toBe(g.titleX);
    }
  });

  it('never emits negative padding (which CSS silently clamps to 0)', () => {
    for (const style of SIDEBAR_ROW_STYLES) {
      for (const insetPref of [0, 2, 8, 12, 24]) {
        const g = rowGeom(style, insetPref);
        for (const indent of [0, 16, 32, 48]) {
          const p = rowPadding(g, indent);
          expect(parseFloat(p.paddingLeft)).toBeGreaterThanOrEqual(0);
          expect(parseFloat(p.paddingRight)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('differentiates the three B modes only by radius and fill width', () => {
    const [r, s, f] = B_MODES.map((m) => rowGeom(m, 2));
    // radius is the rounded-vs-square axis
    expect(r.radius).toBe(8);
    expect(s.radius).toBe(0);
    expect(f.radius).toBe(0);
    // inset is the inset-vs-full-bleed axis
    expect(r.inset).toBe(8);
    expect(s.inset).toBe(8);
    expect(f.inset).toBe(0);
    // everything else must match, or the A/B is contaminated
    const strip = (g: ReturnType<typeof rowGeom>) => {
      const { radius, inset, style, ...rest } = g;
      return rest;
    };
    expect(strip(s)).toEqual(strip(r));
    expect(strip(f)).toEqual(strip(r));
  });

  it('turns on the B structural bits together', () => {
    for (const m of B_MODES) {
      const g = rowGeom(m, 2);
      expect(g.chevronLeading).toBe(false);
      expect(g.subtitleInRow).toBe(true);
      expect(g.workspaceAsHeader).toBe(true);
      expect(g.barW).toBe(0);
    }
    const c = rowGeom('classic', 2);
    expect(c.chevronLeading).toBe(true);
    expect(c.subtitleInRow).toBe(false);
    expect(c.guideLine).toBe(false);
    expect(c.workspaceAsHeader).toBe(false);
  });

  it('falls back to classic for an unknown persisted value', () => {
    expect(rowGeom('nonsense' as SidebarRowStyle, 5)).toEqual(rowGeom('classic', 5));
  });
});

describe('branch block', () => {
  /** Branch rows reuse rowPadding with a per-depth indent, so their BOX matches
   *  a thread row exactly and only the text steps in. That is what makes a
   *  selected branch's fill span the full row width. */
  it('lands depth 1/2/3 text on 36 / 52 / 68 while keeping the box full-width', () => {
    for (const m of B_MODES) {
      const g = rowGeom(m, 2);
      expect(resolvedTextX(m, 2, 1 * g.indentStep)).toBe(36);
      expect(resolvedTextX(m, 2, 2 * g.indentStep)).toBe(52);
      expect(resolvedTextX(m, 2, 3 * g.indentStep)).toBe(68);
      // Box width is indent-independent: same right edge as a thread row.
      expect(resolvedRightEdge(m, 2, 300)).toBe(300 - 16);
    }
  });

  it('stacks a thread and its first branch flush in card modes', () => {
    // A gap here shows as an un-filled slot cutting a selected thread + selected
    // first branch in two — the whole reason branch rows are full-row-width.
    for (const m of B_MODES) expect(branchBlockGap(rowGeom(m, 2))).toBe(0);
    expect(branchBlockGap(rowGeom('classic', 2))).toBe(1);
  });
});

describe('caretKebabClearance', () => {
  /** Where the trailing caret's right edge lands, measured in from the row's
   *  padding-box right edge — the same origin the absolutely-positioned
   *  `.row-kebab` (right: 0) is measured from. The caret is a flex item in the
   *  CONTENT box, so its own inset is the row's paddingRight plus the margin. */
  function caretRightEdgeInset(style: SidebarRowStyle): number {
    const g = rowGeom(style, 2);
    return parseFloat(rowPadding(g).paddingRight) + caretKebabClearance(g);
  }

  it('clears the 16px ⋯ button plus its 6px card-mode padding in every B mode', () => {
    for (const m of B_MODES) {
      expect(caretRightEdgeInset(m)).toBeGreaterThanOrEqual(22);
    }
  });

  it('lands the caret on one constant inset across all B modes', () => {
    // The whole reason this is derived rather than a shared constant: modes have
    // different right paddings, so a flat number puts the caret in a different
    // place in each of them. Switching modes should not move it.
    const insets = new Set(B_MODES.map(caretRightEdgeInset));
    expect(insets.size).toBe(1);
  });

  it('is tighter than the flat 22 it replaced', () => {
    // 22 everywhere over-reserved for the inset modes (paddingRight 8), pushing
    // the caret 14px further in than the kebab actually needs.
    for (const m of B_MODES) expect(caretKebabClearance(rowGeom(m, 2))).toBeLessThan(22);
  });

  it('is zero for classic, which has no trailing caret at all', () => {
    for (const insetPref of [0, 2, 8, 24]) {
      expect(caretKebabClearance(rowGeom('classic', insetPref))).toBe(0);
    }
  });

  it('never goes negative', () => {
    for (const style of SIDEBAR_ROW_STYLES) {
      for (const insetPref of [0, 2, 8, 12, 24]) {
        expect(caretKebabClearance(rowGeom(style, insetPref))).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('spinePadding', () => {
  it('puts plain elements on an absolute spine by subtracting the inset', () => {
    // Section labels / Show more are children of the inset container with no
    // negative margin, so inset + padding must equal the target x.
    for (const m of B_MODES) {
      const g = rowGeom(m, 2);
      expect(g.inset + parseFloat(spinePadding(g, 20))).toBe(20);
      expect(g.inset + parseFloat(spinePadding(g, 36))).toBe(36);
    }
  });
});
