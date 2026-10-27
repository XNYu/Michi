/**
 * The page's selected blocks (top-level ones, by id). `anchor` is where a
 * Shift-range or a drag down the margin starts.
 */
export interface BlockSelection {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export const NO_BLOCKS: BlockSelection = { selected: new Set(), anchor: null };

/** The ids from `a` to `b` in page order, both included; just `b` when either is not on the page. */
function span(order: readonly string[], a: string, b: string): string[] {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  if (from < 0 || to < 0) return [b];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return order.slice(lo, hi + 1);
}

/** The margin's checkbox or ⌘-click: one block in or out. */
export function toggleBlock(prev: BlockSelection, id: string): BlockSelection {
  const selected = new Set(prev.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { selected, anchor: id };
}

/** Shift-click: every block from the anchor to this one is added. */
export function extendBlocks(prev: BlockSelection, id: string, order: readonly string[]): BlockSelection {
  const anchor = prev.anchor && order.includes(prev.anchor) ? prev.anchor : id;
  return { selected: new Set([...prev.selected, ...span(order, anchor, id)]), anchor };
}

/** Dragging down (or up) the margin from `anchor`: what was selected when it began, plus the blocks passed over. */
export function dragBlocks(base: ReadonlySet<string>, anchor: string, id: string, order: readonly string[]): BlockSelection {
  return { selected: new Set([...base, ...span(order, anchor, id)]), anchor };
}

/** The selected ids still on the page, in page order. */
export function selectedInOrder(selection: BlockSelection, order: readonly string[]): string[] {
  return order.filter((id) => selection.selected.has(id));
}
