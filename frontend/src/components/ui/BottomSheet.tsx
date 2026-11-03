import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent, type Transition } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
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

// Rises like it always has (--t-enter on --t-ease) and drops back a little
// faster on the panel curve; the scrim clears just ahead of it.
const SHEET_IN: Transition = { duration: DUR.enter, ease: EASE.term };
const SHEET_OUT: Transition = { duration: 0.16, ease: EASE.drawer };
const SCRIM_IN: Transition = { duration: DUR.enter, ease: 'easeOut' };
const SCRIM_OUT: Transition = { duration: DUR.scrimExit, ease: EASE.out };

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
 * Escape and a tap on the scrim close it; focus returns to the opener at once
 * while the sheet drops away.
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

  // A closed sheet stays a moment as an inert ghost while it drops away;
  // AnimatePresence keeps rendering it with the props it last had open.
  return createPortal(
    <AnimatePresence>
      {open && (
        <SheetLayers
          key="sheet"
          panelRef={panelRef}
          pressedScrim={pressedScrim}
          onClose={onClose}
          labelledBy={labelledBy}
          ariaLabel={rest['aria-label']}
          keyboard={keyboard}
        >
          {children}
        </SheetLayers>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function SheetLayers({ panelRef, pressedScrim, onClose, labelledBy, ariaLabel, keyboard, children }: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  pressedScrim: React.RefObject<boolean>;
  onClose: () => void;
  labelledBy?: string;
  ariaLabel?: string;
  keyboard: KeyboardInset | null;
  children: React.ReactNode;
}) {
  // A sheet on its way out is no longer a layer: hidden from assistive tech and
  // Esc routing (escapeLayers matches dialog roles), inert, and click-through.
  const leaving = !useIsPresent();
  return (
    <>
      <motion.div
        className="ui-scrim ui-scrim--modal"
        aria-hidden={leaving || undefined}
        style={{ pointerEvents: leaving ? 'none' : undefined }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: SCRIM_IN }}
        exit={{ opacity: 0, transition: SCRIM_OUT }}
        onPointerDown={leaving ? undefined : () => { pressedScrim.current = true; }}
        onClick={leaving ? undefined : () => {
          const pressed = pressedScrim.current;
          pressedScrim.current = false;
          if (pressed) onClose();
        }}
      />
      <motion.div
        ref={panelRef}
        className="ui-sheet"
        role={leaving ? undefined : 'dialog'}
        aria-modal={leaving ? undefined : 'true'}
        aria-hidden={leaving || undefined}
        inert={leaving}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        tabIndex={-1}
        style={{
          ...(keyboard ? { bottom: keyboard.bottom, maxHeight: keyboard.maxHeight } : undefined),
          pointerEvents: leaving ? 'none' : undefined,
        }}
        initial={{ y: '100%' }}
        animate={{ y: 0, transition: SHEET_IN }}
        exit={{ y: '100%', transition: SHEET_OUT }}
      >
        {children}
      </motion.div>
    </>
  );
}
