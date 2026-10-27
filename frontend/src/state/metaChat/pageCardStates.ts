/**
 * What the user did to each change card in the Meta agent window (Undo,
 * Restore, a deleted page), by tool call id. Module state so a card keeps it
 * when its message re-renders, and so suggested questions can tell which edit
 * suggestions were applied and not undone.
 */
export type PageCardState =
  | { kind: 'applied'; undone: boolean }
  | { kind: 'suggestion'; resolved: 'accepted' | 'dismissed' | null }
  | { kind: 'created'; removed: boolean };

const states = new Map<string, PageCardState>();
const listeners = new Set<() => void>();

export function getPageCardState(toolId: string): PageCardState | undefined {
  return states.get(toolId);
}

export function setPageCardState(toolId: string, state: PageCardState): void {
  states.set(toolId, state);
  for (const listener of listeners) listener();
}

export function subscribePageCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while the write still stands: not undone, a created page not deleted, a suggestion not ignored. */
export function pageCardStands(toolId: string, fallback: PageCardState): boolean {
  const state = states.get(toolId) ?? fallback;
  if (state.kind === 'applied') return !state.undone;
  if (state.kind === 'created') return !state.removed;
  return state.resolved !== 'dismissed';
}

/** Test seam. */
export function resetPageCardStatesForTests(): void {
  states.clear();
}
