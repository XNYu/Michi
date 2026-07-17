/**
 * Platform detection + keyboard-shortcut formatting.
 *
 * The actual key handlers use `e.metaKey || e.ctrlKey`, so both ⌘ and Ctrl
 * fire the same bindings — this module only exists to render the *display*
 * string in tooltips, the palette, and the Settings cheat sheet.
 *
 * Mac convention:   '⌘K', '⌘↵', '⇧⌘F'      (glyphs, no separator)
 * Win/Linux:        'Ctrl+K', 'Ctrl+Enter', 'Ctrl+Shift+F'  (words, '+' separator)
 */

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const SHIFT = IS_MAC ? '⇧' : 'Shift';
const CTRL = IS_MAC ? '⌃' : 'Ctrl';
const ENTER = IS_MAC ? '↵' : 'Enter';
const SEP = IS_MAC ? '' : '+';

type Token = 'mod' | 'alt' | 'shift' | 'ctrl' | 'enter' | (string & {});

/**
 * Format a keyboard shortcut for display.
 *
 *   kbd('mod', 'K')             → '⌘K'        / 'Ctrl+K'
 *   kbd('shift', 'mod', 'F')    → '⇧⌘F'       / 'Shift+Ctrl+F'  (caller controls order)
 *   kbd('mod', 'enter')         → '⌘↵'        / 'Ctrl+Enter'
 *   kbd('mod', ',')             → '⌘,'        / 'Ctrl+,'
 *   kbd('ctrl', 'Tab')          → '⌃Tab'      / 'Ctrl+Tab'
 *   kbd('enter')                → '↵'         / 'Enter'
 */
export function kbd(...parts: Token[]): string {
  return parts
    .map((p) => {
      switch (p) {
        case 'mod':
          return MOD;
        case 'alt':
          return ALT;
        case 'shift':
          return SHIFT;
        case 'ctrl':
          return CTRL;
        case 'enter':
          return ENTER;
        default:
          return p;
      }
    })
    .join(SEP);
}
