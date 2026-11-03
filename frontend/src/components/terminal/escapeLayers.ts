import { composerKeptEscape } from '../composerEscape';

/**
 * Which surface an Esc belongs to. The page (leave it, clear its selection,
 * close its drawer) is the last in line: the ⌘J panel and the layers that
 * close on Esc float over it and take theirs first.
 */

/** Focus is in the floating ⌘J panel (pane shortcuts such as ⌘W leave the grid alone). */
export function isInAssistantPanel(element: Element | null): boolean {
  return !!element?.closest('[data-assistant-panel]');
}

/**
 * A layer on its way out is gone already: a drawer sliding out, a modal,
 * panel or menu fading out stays mounted a moment, aria-hidden or inert, and
 * so does everything inside it (a find bar in the ⌘J panel, a popover in
 * Settings).
 */
const LIVE = ':not([inert], [inert] *, [aria-hidden="true"], [aria-hidden="true"] *)';

function liveLayers(...selectors: string[]): string {
  return selectors.map((selector) => `${selector}${LIVE}`).join(', ');
}

/**
 * Menus, lists and modals close on any Esc while they are up, wherever the
 * focus is, and so does the selection toolbar (`data-escape-layer="over"`).
 */
export const MENU_LAYER_SELECTOR = liveLayers('[role="menu"]', '[role="listbox"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-escape-layer="over"]');

/**
 * With focus outside the panel, any other open layer takes Esc first: menus,
 * lists, the peek drawer and every other open dialog, and every Esc-closing
 * layer (`data-escape-layer`, wherever it is: the page has the focus).
 */
export const OTHER_LAYER_SELECTOR = liveLayers('[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[data-escape-layer]');

/**
 * Whether an Esc is still the page's to act on. Not once something took it
 * (its default prevented; the composer kept it for its own popup; an IME
 * composition ended), not when it was pressed inside the ⌘J panel or an
 * Esc layer (the find bar, the selection toolbar), and not while a menu, a
 * list or a modal is open: that takes the key, whichever listener happens to
 * run first. `'all'` is for the shell under everything: then an open drawer,
 * find bar or sidebar overlay keeps the key too. A drawer's own listener
 * passes the default (`'menus'`): other drawers don't stop it closing.
 */
export function escapeIsForPage(event: KeyboardEvent, layers: 'menus' | 'all' = 'menus'): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || composerKeptEscape(event)) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-assistant-panel], [data-escape-layer]')) return false;
  return !document.querySelector(layers === 'all' ? OTHER_LAYER_SELECTOR : MENU_LAYER_SELECTOR);
}
