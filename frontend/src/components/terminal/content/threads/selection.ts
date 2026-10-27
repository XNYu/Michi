/** Multi-select over the cards of one view. `anchor` is where a shift-range starts. */
export interface ThreadSelection {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: ThreadSelection = { selected: new Set(), anchor: null };

/**
 * ⌘/Ctrl-click toggles one card; Shift-click adds every card between the
 * anchor and this one in the view's order.
 */
export function applySelectionClick(
  prev: ThreadSelection,
  id: string,
  mods: { toggle: boolean; range: boolean },
  order: readonly string[],
): ThreadSelection {
  if (mods.range) {
    const anchor = prev.anchor && order.includes(prev.anchor) ? prev.anchor : id;
    const from = order.indexOf(anchor);
    const to = order.indexOf(id);
    const selected = new Set(prev.selected);
    if (from < 0 || to < 0) {
      selected.add(id);
    } else {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i += 1) selected.add(order[i]);
    }
    return { selected, anchor };
  }
  const selected = new Set(prev.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { selected, anchor: id };
}
