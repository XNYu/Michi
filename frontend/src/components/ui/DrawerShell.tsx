import React from 'react';
import { motion, MotionConfigContext, type Transition } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
import './DrawerShell.css';
import { useOverlayFocus } from './useOverlayFocus';
import './OverlaySurface.css';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const EXIT_TIMEOUT_MS = 220;
// The scrim fades in like the shared .ui-scrim (fadeIn at --t-enter) and out
// a little faster, inside the panel's slide.
const SCRIM_IN: Transition = { duration: DUR.enter, ease: 'easeOut' };
const SCRIM_OUT: Transition = { duration: DUR.scrimExit, ease: EASE.out };

function subscribeMotionPreference(notify: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener('change', notify);
  return () => query?.removeEventListener('change', notify);
}

function prefersReducedMotion() {
  return window.matchMedia?.(REDUCED_MOTION).matches ?? false;
}

/** Shared right-anchored drawer. Presence includes the retiring panel. */
export interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  motion?: 'standard' | 'instant';
  onPresenceChange?: (present: boolean) => void;
  /** Uppercased in the header via CSS; pass plain text e.g. "Settings". */
  title: React.ReactNode;
  /** Right-aligned header controls (e.g. add / file buttons). */
  headerActions?: React.ReactNode;
  /** Optional count/badge shown right after the title. */
  titleBadge?: React.ReactNode;
  /** Handle Escape at the drawer level. Set false when a nested overlay (e.g. a
   *  lightbox) should consume Escape first. Default true. */
  closeOnEscape?: boolean;
  /** How the header offers onClose. 'close' (default) is the trailing ×.
   *  'back' puts a back chevron before the title instead, for a drawer that
   *  fills a phone screen and reads as a page. */
  closeControl?: 'close' | 'back';
  /** Override the default CSS width (440px). Applied as an inline style. */
  width?: number;
  /** Default true. False keeps the page usable beside the drawer: no scrim,
   *  no outside-click close, no aria-modal (still a labelled dialog that takes
   *  focus on open and gives it back on close). */
  modal?: boolean;
  'aria-label'?: string;
  children: React.ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  motion: motionMode = 'standard',
  onPresenceChange,
  title,
  headerActions,
  titleBadge,
  closeOnEscape = true,
  closeControl = 'close',
  width,
  modal = true,
  children,
  ...rest
}: DrawerShellProps) {
  const ariaLabel = rest['aria-label'];
  const panelRef = React.useRef<HTMLDivElement>(null);
  useOverlayFocus({ open, panelRef, trap: modal, initialFocus: 'panel', trackOutsideFocus: !modal });
  const osReduced = React.useSyncExternalStore(subscribeMotionPreference, prefersReducedMotion, () => false);
  // MotionRoot maps the in-app Reduce motion preference to 'always'.
  const appReduced = React.useContext(MotionConfigContext).reducedMotion === 'always';
  const instant = motionMode === 'instant' || osReduced || appReduced;
  const [retained, setRetained] = React.useState(open);
  const present = open || (!instant && retained);

  React.useLayoutEffect(() => {
    onPresenceChange?.(present);
    return () => onPresenceChange?.(false);
  }, [present, onPresenceChange]);

  React.useEffect(() => {
    if (open) {
      if (!retained) setRetained(true);
      return;
    }
    if (!retained) return;
    if (instant) {
      setRetained(false);
      return;
    }
    // transitionend is not guaranteed for hidden windows or interrupted CSS.
    const timer = window.setTimeout(() => setRetained(false), EXIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [open, instant, retained]);

  React.useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeOnEscape]);

  if (!present) return null;

  return (
    <>
      {modal && (
        <motion.div
          className="ui-scrim ui-scrim--drawer drawer-shell-scrim"
          data-state={open ? 'open' : 'closed'}
          onMouseDown={open ? onClose : undefined}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          initial={{ opacity: 0 }}
          animate={open ? { opacity: 1, transition: SCRIM_IN } : { opacity: 0, transition: SCRIM_OUT }}
        />
      )}
      <div
        ref={panelRef}
        className="ui-drawer-panel ui-overlay-surface term-glass drawer-shell-panel"
        data-glass="solid"
        data-state={open ? 'open' : 'closed'}
        data-motion={instant ? 'instant' : 'standard'}
        tabIndex={-1}
        inert={!open}
        role="dialog"
        aria-modal={modal || undefined}
        aria-hidden={!open || undefined}
        aria-label={typeof title === 'string' ? title : ariaLabel}
        style={width ? { width } : undefined}
        onTransitionEnd={(event) => {
          if (!open && event.target === event.currentTarget && event.propertyName === 'transform') {
            setRetained(false);
          }
        }}
      >
        <div className="ui-overlay-header">
          {closeControl === 'back' && (
            <button
              type="button"
              className="ui-overlay-close drawer-shell-back"
              onClick={onClose}
              title="Back (esc)"
              aria-label="Back"
            >
              <svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 3L5 8l5 5" />
              </svg>
            </button>
          )}
          <span className="ui-overlay-title">{closeControl === 'back' ? title : <>▸ {title}</>}</span>
          {titleBadge}
          <span style={{ flex: 1 }} />
          {headerActions}
          {closeControl === 'close' && (
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
        </div>
        {children}
      </div>
    </>
  );
}
