import type React from 'react';

/** What every view needs to draw and route clicks on one thread. */
export interface ThreadItemHandlers {
  peekId: string | null;
  selected: ReadonlySet<string>;
  /** The items are Michi threads, which may have a write on its way (each row reads its own: useRowPending). */
  threadRows?: boolean;
  /** ⌘/Ctrl or Shift select; a plain click opens the peek. */
  onItemClick(id: string, event: React.MouseEvent): void;
  /** Keyboard open (Enter). */
  onItemOpen(id: string): void;
  /** Keyboard select (Space), like a ⌘-click. */
  onItemToggle(id: string): void;
}

/**
 * Shared props for a clickable, selectable thread. Cards and rows read as
 * buttons that are pressed while selected; table rows keep their row role and
 * say `aria-selected` instead. Enter opens the peek, Space toggles selection.
 */
export function threadItemProps(id: string, h: ThreadItemHandlers, as: 'button' | 'row' = 'button', pending = false) {
  const selected = h.selected.has(id);
  return {
    ...(as === 'button' ? { role: 'button', 'aria-pressed': selected } : { 'aria-selected': selected }),
    tabIndex: 0,
    'data-thread-id': id,
    'data-selected': selected ? 'true' : undefined,
    'data-pending': pending ? 'true' : undefined,
    'aria-busy': pending || undefined,
    'aria-current': h.peekId === id ? ('true' as const) : undefined,
    onClick: (event: React.MouseEvent) => h.onItemClick(id, event),
    // Shift-click extends a selection; keep the browser from selecting text too.
    onMouseDown: (event: React.MouseEvent) => {
      if (event.shiftKey) event.preventDefault();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        h.onItemOpen(id);
      } else if (event.key === ' ') {
        event.preventDefault();
        h.onItemToggle(id);
      }
    },
  };
}

/**
 * Inputs that are pressed rather than typed in: they have no Escape or arrow
 * keys of their own. A radio is not one: its arrow keys move the choice.
 */
const PRESSED_INPUTS = new Set(['checkbox', 'button', 'submit', 'reset', 'image', 'color', 'file']);

/**
 * Text fields (and radios, whose arrows pick) keep their own Escape and arrow
 * keys. A checkbox or button-like input does not: Esc there still clears a
 * selection.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') return !PRESSED_INPUTS.has((target as HTMLInputElement).type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

const DIALOG_SELECTOR = '[role="dialog"],[aria-modal="true"]';

/** The dialog (drawer, modal, palette) an element sits in, if any. */
export function dialogOf(target: EventTarget | null | undefined): Element | null {
  return target instanceof Element ? target.closest(DIALOG_SELECTOR) : null;
}
