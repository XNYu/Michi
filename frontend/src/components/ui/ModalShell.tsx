import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent, useMotionValue, usePresence, type Transition, type Variants } from 'motion/react';
import { DUR, TRANSITION } from '../../motion/tokens';
import { useOverlayFocus } from './useOverlayFocus';
import { useFrozenGlass } from './useFrozenGlass';
import { getElectron } from '../../lib/electronBridge';
import './OverlaySurface.css';
import './ModalShell.css';

/**
 * Shared centered modal shell. Every dialog (New Workspace, Move Thread, Create
 * Digest, Command Palette, Confirm) renders through this so they share one
 * scrim, one z-index rung, the frosted `.term-glass` surface, the enter/exit
 * motion, portal-to-body (escapes the sidebar's clipping stacking context),
 * window-level Escape, focus trap + restore, and
 * `role="dialog"`/`aria-modal`/`aria-labelledby`.
 *
 * Before this, four dialogs copy-pasted identical SCRIM/PANE/TAB_BAR/X_BTN
 * constants (on the legacy `--surface` token family), Escape was scoped to a
 * single input (broke when focus moved), only one had a dialog role, and z-index
 * ranged 50→9000 arbitrarily.
 */
export interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  /** Header tag text, uppercased via CSS. Omit for a chrome-less modal. */
  title?: React.ReactNode;
  /** Optional glyph before the title (e.g. ⎇ for move, ⊕ for digest). */
  titleGlyph?: React.ReactNode;
  /** Accent color for the title tag + glyph (role color). */
  accent?: string;
  /** Panel width in px. Default 480. */
  width?: number;
  /** Panel height cap. Default comes from .ui-modal-panel (min(70vh, 640px));
   *  viewers (diff, table) pass a taller cap. */
  maxHeight?: string;
  /** Consume Escape in the capture phase so no other window listener sees it.
   *  For viewers opened over pages whose shell also binds Escape (clear
   *  selection, leave Map/Digest). Leave off when the modal hosts nested
   *  overlays that handle Escape themselves. */
  captureEscape?: boolean;
  /** center (default) or top-anchored (command/search palettes). */
  anchor?: 'center' | 'top';
  /** Click-scrim / Escape dismiss. Default true. */
  dismissible?: boolean;
  /** 'window' for a modal that hosts menus and popovers of its own (Settings):
   *  it sits below them instead of above. Default 'modal'. */
  layer?: 'modal' | 'window';
  /** 'standard' (default) fades + scales in and out. 'enter' fades + scales in
   *  and closes on the spot (⌘K: dismissed straight into what was picked).
   *  'none' opens and closes on the spot. */
  motion?: 'standard' | 'enter' | 'none';
  /** Desktop defaults to 'frozen': one blurred window capture, with an opaque
   *  fallback on failure/resize. Web defaults to 'live'. The modal waits at
   *  most 150ms for capture before showing the fallback. */
  glass?: 'live' | 'frozen';
  /** Extra header content on the trailing side (e.g. a subtitle chip). */
  headerTrailing?: React.ReactNode;
  'aria-label'?: string;
  children: React.ReactNode;
}

let modalTitleSeq = 0;

// Entry keeps the feel of the CSS it replaces (fadeIn + scaleIn at --t-enter);
// the exit is shorter and settles toward the panel rather than away from it.
const SCRIM_IN: Transition = { duration: DUR.enter, ease: 'easeOut' };
const PANEL_IN: Transition = { duration: DUR.enter, ease: [0.2, 0.8, 0.2, 1] };

/**
 * Modals that hand over to one another (first-run Setup → key → New
 * workspace; a job's detail → its editor) read as one window: the incoming
 * scrim takes over at full strength from the one fading out, so the page never
 * brightens in between, and the incoming card waits for the outgoing one to
 * clear before it settles in.
 */
interface ModalOnScreen { leaving: boolean; takingOver: boolean; openedAt: number; scrim: HTMLElement | null; takeOver: () => void }
const modalsOnScreen = new Set<ModalOnScreen>();
/** Opened this recently, a modal is the one taking over from a modal closing now. */
const SAME_MOMENT_MS = 50;
const PANEL_SWAP_IN: Transition = { delay: 0.06, duration: 0.16, ease: [0.2, 0.8, 0.2, 1] };

/**
 * Hand-overs are found in layout effects, after the incoming modal rendered
 * but before anything paints: the incoming scrim is set to full strength in
 * the same frame the outgoing one is hidden. The panel's entrance starts in a
 * passive effect, after every layout effect of the commit, so its variant
 * reads the hand-over through `custom` when it resolves.
 */
const PANEL_VARIANTS: Variants = {
  closed: { opacity: 0, scale: 0.96 },
  open: (screen?: React.RefObject<ModalOnScreen | null>) => ({
    opacity: 1,
    scale: 1,
    transition: screen?.current?.takingOver ? PANEL_SWAP_IN : PANEL_IN,
  }),
  leaving: { opacity: 0, scale: 0.98, transition: TRANSITION.exit },
};

function handOver(from: ModalOnScreen, to: ModalOnScreen) {
  to.takeOver();
  if (from.scrim) from.scrim.style.visibility = 'hidden';
}

export function ModalShell({
  open,
  onClose,
  title,
  titleGlyph,
  accent = 'var(--term-accent)',
  width = 480,
  maxHeight,
  captureEscape = false,
  anchor = 'center',
  dismissible = true,
  layer = 'modal',
  motion: motionMode = 'standard',
  glass = getElectron() ? 'frozen' : 'live',
  headerTrailing,
  children,
  ...rest
}: ModalShellProps) {
  const ariaLabel = rest['aria-label'];
  const paneRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useMemo(() => `modal-title-${++modalTitleSeq}`, []);
  // A dialog its caller mounts only while open closes the same way when the
  // caller renders it inside <AnimatePresence>: removing it closes the modal,
  // which lets go once its own fade-out is done.
  const [present, safeToRemove] = usePresence();
  const shown = open && present;
  const animated = motionMode !== 'none';
  const animatedExit = motionMode === 'standard';
  // Focus returns as soon as the modal closes, while a closing panel may still
  // be fading out (inert) below.
  useOverlayFocus({ open: shown, panelRef: paneRef, initialFocus: 'first', deferInitialFocus: true, restore: 'always' });

  const release = React.useRef({ present, safeToRemove });
  release.current = { present, safeToRemove };
  React.useEffect(() => {
    // Nothing of ours fades out: let the caller's AnimatePresence go on.
    if (!present && (!open || !animatedExit)) safeToRemove?.();
  }, [present, open, animatedExit, safeToRemove]);

  // Keep the latest onClose/dismissible in refs so the focus/trap effects below
  // depend ONLY on `open`. Call sites pass fresh inline `onClose` arrows, so a
  // parent re-render (e.g. a background chat stream re-rendering TerminalShell
  // while a modal is open) would otherwise re-run those effects — tearing down
  // and re-capturing focus mid-open, bouncing focus and clobbering the restore
  // target with an in-modal node.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = React.useRef(dismissible);
  dismissibleRef.current = dismissible;

  // Dismissal reads the latest callback without resetting focus.
  React.useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissibleRef.current) {
        e.preventDefault();
        // stopImmediatePropagation, not stopPropagation: the shell's listener
        // is registered on the same window target.
        if (captureEscape) e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
    };
    window.addEventListener('keydown', onKey, { capture: captureEscape });
    return () => window.removeEventListener('keydown', onKey, { capture: captureEscape });
  }, [shown, captureEscape]);

  const layers = shown ? (
    <ModalLayers
      key="modal"
      animated={animated}
      frozenGlass={glass === 'frozen'}
      paneRef={paneRef}
      titleId={titleId}
      onClose={onClose}
      title={title}
      titleGlyph={titleGlyph}
      accent={accent}
      width={width}
      maxHeight={maxHeight}
      anchor={anchor}
      dismissible={dismissible}
      layer={layer}
      headerTrailing={headerTrailing}
      ariaLabel={ariaLabel}
    >
      {children}
    </ModalLayers>
  ) : null;

  // Without an exit the modal unmounts with `open`. Otherwise the closed modal
  // stays a moment as an inert ghost while it fades out; AnimatePresence keeps
  // rendering it with the props it last had open.
  if (!animatedExit) return layers ? createPortal(layers, document.body) : null;
  return createPortal(
    <AnimatePresence onExitComplete={() => { if (!release.current.present) release.current.safeToRemove?.(); }}>
      {layers}
    </AnimatePresence>,
    document.body,
  );
}

interface ModalLayersProps {
  animated: boolean;
  frozenGlass: boolean;
  paneRef: React.RefObject<HTMLDivElement | null>;
  titleId: string;
  onClose: () => void;
  title?: React.ReactNode;
  titleGlyph?: React.ReactNode;
  accent: string;
  width: number;
  maxHeight?: string;
  anchor: 'center' | 'top';
  dismissible: boolean;
  layer: 'modal' | 'window';
  headerTrailing?: React.ReactNode;
  ariaLabel?: string;
  children: React.ReactNode;
}

function ModalLayers({
  animated,
  frozenGlass,
  paneRef,
  titleId,
  onClose,
  title,
  titleGlyph,
  accent,
  width,
  maxHeight,
  anchor,
  dismissible,
  layer,
  headerTrailing,
  ariaLabel,
  children,
}: ModalLayersProps) {
  // A closing modal is no longer a layer: hidden from assistive tech and Esc
  // routing (escapeLayers matches dialog roles), inert, and click-through.
  const leaving = !useIsPresent();
  const dismiss = dismissible && !leaving ? onClose : undefined;
  // A stacked/replacement modal must appear immediately. Capturing here
  // would bake the old dialog into its background and leave a blank frame
  // when the hand-over below hides the retiring scrim. Choose once per open.
  const [allowCapture] = React.useState(() => modalsOnScreen.size === 0);
  const glass = useFrozenGlass(paneRef, frozenGlass, allowCapture);
  // While frozen glass captures the window, neither scrim nor panel is drawn
  // (the capture is the page as it was); the entrance plays once it is done.
  const holding = glass.phase === 'capturing';

  const scrimRef = React.useRef<HTMLDivElement>(null);
  const scrimOpacity = useMotionValue(animated ? 0 : 1);
  const onScreen = React.useRef<ModalOnScreen | null>(null);
  React.useLayoutEffect(() => {
    if (!animated) return;
    const self: ModalOnScreen = {
      leaving: false,
      takingOver: false,
      openedAt: performance.now(),
      scrim: scrimRef.current,
      takeOver: () => {
        self.takingOver = true;
        // jump() stops a running fade-in and is what motion renders from; the
        // style write covers the frame before its next render.
        scrimOpacity.jump(1);
        if (scrimRef.current) scrimRef.current.style.opacity = '1';
      },
    };
    onScreen.current = self;
    for (const other of modalsOnScreen) if (other.leaving) handOver(other, self);
    modalsOnScreen.add(self);
    return () => { modalsOnScreen.delete(self); };
  }, [animated, scrimOpacity]);
  React.useLayoutEffect(() => {
    const self = onScreen.current;
    if (!self) return;
    if (!leaving) {
      // Reopened while fading out.
      self.leaving = false;
      if (scrimRef.current) scrimRef.current.style.visibility = '';
      return;
    }
    self.leaving = true;
    const now = performance.now();
    for (const other of modalsOnScreen) {
      if (!other.leaving && now - other.openedAt < SAME_MOMENT_MS) handOver(self, other);
    }
  }, [leaving]);

  return (
    <>
      {/* Dim scrim — a SIBLING of the panel, never its ancestor. If the glass
          panel were nested inside this (translucent, opacity-fading) element,
          its backdrop-filter would sample the scrim's flat fill instead of the
          real app content and render clear. Keeping them siblings lets the panel
          frost through to the page exactly like the drawer does. */}
      <motion.div
        ref={scrimRef}
        className="ui-scrim ui-scrim--modal"
        data-layer={layer === 'window' ? 'window' : undefined}
        data-glass={holding ? 'capturing' : undefined}
        aria-hidden={leaving || undefined}
        style={{ pointerEvents: leaving ? 'none' : undefined, opacity: scrimOpacity }}
        initial={animated ? { opacity: 0 } : false}
        animate={animated && holding ? { opacity: 0 } : { opacity: 1, transition: SCRIM_IN }}
        exit={{ opacity: 0, transition: TRANSITION.exit }}
        onMouseDown={dismiss}
      />
      {/* Transparent, un-animated centering layer (no bg/opacity/transform, so it
          doesn't isolate the panel's backdrop). Clicks on its empty area dismiss. */}
      <div
        className="ui-modal-positioner"
        data-anchor={anchor}
        data-layer={layer === 'window' ? 'window' : undefined}
        aria-hidden={leaving || undefined}
        inert={leaving}
        style={leaving ? { pointerEvents: 'none' } : undefined}
        onMouseDown={dismiss}
      >
        <motion.div
          ref={paneRef}
          className="ui-modal-panel ui-overlay-surface term-glass"
          data-glass={glass.phase === 'live' ? undefined : glass.phase}
          tabIndex={-1}
          role={leaving ? undefined : 'dialog'}
          aria-modal={leaving ? undefined : 'true'}
          // An explicit aria-label wins over the visible (uppercased, terse)
          // title, e.g. the diff viewer names itself by file path.
          aria-labelledby={title && !ariaLabel ? titleId : undefined}
          aria-label={ariaLabel}
          style={{ width, maxWidth: '92vw', maxHeight }}
          variants={PANEL_VARIANTS}
          custom={onScreen}
          initial={animated ? 'closed' : false}
          animate={animated && holding ? 'closed' : 'open'}
          exit="leaving"
          onMouseDown={(e) => e.stopPropagation()}
        >
        {glass.layer}
        {title && (
          <div className="ui-overlay-header" style={{ justifyContent: 'space-between' }}>
            <span
              className="ui-overlay-title"
              id={titleId}
              style={{ color: accent, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              {titleGlyph ? <span aria-hidden>{titleGlyph}</span> : null}
              {title}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {headerTrailing}
              {dismissible && (
                <button
                  type="button"
                  className="ui-overlay-close"
                  onClick={onClose}
                  title="Close (esc)"
                  aria-label="Close"
                >
                  ×
                </button>
              )}
            </span>
          </div>
        )}
        {children}
        </motion.div>
      </div>
    </>
  );
}
