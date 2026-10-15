// Shared MapCard geometry for every Map layout engine (dagre, ELK, orbit) and
// the camera. Real card heights are measured in the DOM (see Map.tsx); these
// are only first-frame estimates before a measurement lands.

export const CARD_W = 360;
/** Collapsed estimate: heat bar + ASKED strip + title + summary + chips. */
export const CARD_H = 200;
/** Expanded estimate: collapsed + overview trail + footer. */
export const CARD_H_EXPANDED = 320;
/** The card's 1px top and bottom border, outside the measured head. */
const CARD_BORDER_Y = 2;

/**
 * Layout height of one card.
 * - Collapsed: the measured head (everything above the expand area). The head
 *   doesn't change while the expand area animates, so collapsing a card
 *   doesn't relayout the graph on every animation frame.
 * - Expanded: the measured full card, never less than the expanded estimate.
 */
export function mapCardHeight(
  expanded: boolean,
  headHeight: number | undefined,
  expandedHeight: number | undefined,
): number {
  if (expanded) return Math.max(CARD_H_EXPANDED, expandedHeight ?? CARD_H_EXPANDED);
  return headHeight != null ? headHeight + CARD_BORDER_Y : CARD_H;
}
