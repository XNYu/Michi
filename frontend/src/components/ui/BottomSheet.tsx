import React from 'react';
import { createPortal } from 'react-dom';
import { useOverlayFocus } from './useOverlayFocus';
import './BottomSheet.css';

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Id of the visible heading that names the sheet. */
  labelledBy?: string;
  'aria-label'?: string;
  children: React.ReactNode;
}

interface KeyboardInset { bottom: number; maxHeight: number }

/**
 * The part of the layout viewport the visual viewport doesn't show at the
 * bottom: the on-screen keyboard on iOS, which overlays fixed elements instead
 * of resizing the page. Null while nothing covers the bottom edge.
 */
function useKeyboardInset(active: boolean): KeyboardInset | null {
  const [inset, setInset] = React.useState<KeyboardInset | null>(null);
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setInset(null);
      return;
    }
    const update = () => {
      const bottom = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      const next = bottom > 0 ? { bottom, maxHeight: Math.round(viewport.height - 12) } : null;
      setInset((previous) => (previous?.bottom === next?.bottom && previous?.maxHeight === next?.maxHeight ? previous : next));
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [active]);
  return inset;
}

/**
 * A phone action sheet: rises from the bottom edge over the modal scrim, and
 * sits on top of the on-screen keyboard while one of its fields has focus.
 * Escape and a tap on the scrim close it; focus returns to the opener.
 */
export function BottomSheet({ open, onClose, labelledBy, children, ...rest }: BottomSheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  useOverlayFocus({ open, panelRef, initialFocus: 'panel', restore: 'always' });
  const keyboard = useKeyboardInset(open);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  // A sheet opened by a long press appears under the finger that is still
  // down; the click its release produces may land on the new scrim. Only a
  // tap that also started on the scrim closes the sheet.
  const pressedScrim = React.useRef(false);
  React.useEffect(() => { pressedScrim.current = false; }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // The shell binds Escape on the same window (leave a page, clear a
      // selection); the sheet is what Escape closes while it is open.
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div
        className="ui-scrim ui-scrim--modal"
        onPointerDown={() => { pressedScrim.current = true; }}
        onClick={() => {
          const pressed = pressedScrim.current;
          pressedScrim.current = false;
          if (pressed) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : rest['aria-label']}
        tabIndex={-1}
        style={keyboard ? { bottom: keyboard.bottom, maxHeight: keyboard.maxHeight } : undefined}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
