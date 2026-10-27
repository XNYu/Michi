/**
 * Whether a key a database on a page takes ahead of the page (in the capture
 * phase) is the database's to take: pressed inside the database (`root`, its
 * row drawer included), or with nothing focused, and never one meant for a
 * menu, a list or an open cell editor, which handle their own keys.
 */
export function isEmbeddedDbKey(event: KeyboardEvent, root: Element | null): boolean {
  const target = event.target;
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) return true;
  if (handlesOwnKeys(target)) return false;
  return !!root?.contains(target);
}

/** A menu, a list or an open cell editor: it handles its own keys. */
export function handlesOwnKeys(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="menu"], [role="listbox"], .michi-db-editor');
}
