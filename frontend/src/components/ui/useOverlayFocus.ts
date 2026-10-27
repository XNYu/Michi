import React from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(panel: HTMLElement): HTMLElement[] {
  const elements = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (ancestor === panel) break;
    }
    return true;
  });
  // A native radio group contributes one Tab stop, not every option. Treating
  // its unchecked final option as the boundary would let Tab escape a dialog.
  return elements.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return true;
    const group = elements.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name && other.form === element.form);
    return element === (group.find((radio) => radio.checked) ?? group[0]);
  });
}

/** Focus lifecycle shared by overlays without prescribing their layout or dismissal. */
export function useOverlayFocus({
  open,
  panelRef,
  trap = true,
  initialFocus = 'first',
  deferInitialFocus = false,
  trackOutsideFocus = false,
  restore = 'contained',
}: {
  open: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  trap?: boolean;
  initialFocus?: 'first' | 'panel';
  deferInitialFocus?: boolean;
  /** Non-modal peeks return to the last page control the user visited. */
  trackOutsideFocus?: boolean;
  restore?: 'contained' | 'always';
}) {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  // Read before React commits child autoFocus, so a focused input cannot erase
  // the opener we should return to when the dialog closes.
  const focusedBeforeCommit = document.activeElement;
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open) {
      const previous = returnFocusRef.current;
      if (previous?.isConnected && (restore === 'always' || panel?.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
      returnFocusRef.current = null;
      return;
    }
    const active = document.activeElement;
    const previous = panel?.contains(active) ? focusedBeforeCommit : active;
    if (previous instanceof HTMLElement && !panel?.contains(previous)) returnFocusRef.current = previous;
    const focus = () => {
      const current = panelRef.current;
      if (!current || (current.contains(document.activeElement) && document.activeElement !== current)) return;
      (initialFocus === 'first' ? focusableElements(current)[0] ?? current : current).focus({ preventScroll: true });
    };
    if (!deferInitialFocus) { focus(); return; }
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
    // These options describe the overlay's open transition, not its rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    if (!open || !trackOutsideFocus) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !panelRef.current?.contains(target)) returnFocusRef.current = target;
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [open, trackOutsideFocus, panelRef]);

  React.useEffect(() => {
    if (!open || !trap) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const panel = panelRef.current;
      // A nested portaled overlay owns its own focus. Do not pull it back into
      // this panel, or interfere with the deliberately non-modal page beside it.
      if (!panel?.contains(document.activeElement)) return;
      const elements = focusableElements(panel);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || document.activeElement === panel || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last ?? panel : first ?? panel).focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, trap, panelRef]);

  React.useEffect(() => () => {
    const previous = returnFocusRef.current;
    if (previous?.isConnected && (restore === 'always' || document.activeElement === document.body)) previous.focus({ preventScroll: true });
  }, [restore]);
}
