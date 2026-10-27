/**
 * Escape keys the composer kept for itself: it closed its own popup (the
 * @-mention list, the /-command menu) or the key ended an IME composition.
 *
 * ProseMirror prevents the default of every Escape that reaches the editor,
 * so `defaultPrevented` can't tell a surface around the composer (the ⌘J
 * panel) whether the composer actually used the key. MentionEditor marks the
 * ones it did; everything else is free for the surface to act on.
 */
const kept = new WeakSet<Event>();

export function markComposerEscape(event: Event): void {
  kept.add(event);
}

export function composerKeptEscape(event: Event): boolean {
  return kept.has(event);
}

/** The event came from inside a composer's editor (TipTap / ProseMirror). */
export function isComposerEditorEvent(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && !!target.closest('.ProseMirror');
}
