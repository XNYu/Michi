import React from 'react';
import './DrawerShell.css';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const EXIT_TIMEOUT_MS = 220;

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
  /** Override the default CSS width (440px). Applied as an inline style. */
  width?: number;
  'aria-label'?: string;
  children: React.ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  motion = 'standard',
  onPresenceChange,
  title,
  headerActions,
  titleBadge,
  closeOnEscape = true,
  width,
  children,
  ...rest
}: DrawerShellProps) {
  const ariaLabel = rest['aria-label'];
  const panelRef = React.useRef<HTMLDivElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const reduced = React.useSyncExternalStore(subscribeMotionPreference, prefersReducedMotion, () => false);
  const instant = motion === 'instant' || reduced;
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

  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (open) {
      const previous = document.activeElement;
      if (previous instanceof HTMLElement && !panel?.contains(previous)) returnFocusRef.current = previous;
      panel?.focus({ preventScroll: true });
    } else {
      const previous = returnFocusRef.current;
      // Restore after React's DOM/selection commit, not in layout cleanup.
      if (previous?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
      returnFocusRef.current = null;
    }
  }, [open]);

  React.useEffect(() => () => {
    const previous = returnFocusRef.current;
    if (previous?.isConnected && document.activeElement === document.body) previous.focus({ preventScroll: true });
  }, []);

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
      <div
        className="ui-scrim ui-scrim--drawer drawer-shell-scrim"
        data-state={open ? 'open' : 'closed'}
        onMouseDown={onClose}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />
      <div
        ref={panelRef}
        className="ui-drawer-panel term-glass drawer-shell-panel"
        data-state={open ? 'open' : 'closed'}
        data-motion={instant ? 'instant' : 'standard'}
        tabIndex={-1}
        {...(!open ? { inert: '' } : {})}
        role="dialog"
        aria-modal="true"
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
          <span className="ui-overlay-title">▸ {title}</span>
          {titleBadge}
          <span style={{ flex: 1 }} />
          {headerActions}
          <button
            type="button"
            className="ui-overlay-close"
            onClick={onClose}
            title="Close (esc)"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
