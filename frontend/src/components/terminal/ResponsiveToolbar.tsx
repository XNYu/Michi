import './mobile.css';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';

/** Backstop for a skipped animationend: mobile-leave runs 110ms (mobile.css). */
const LEAVE_FALLBACK_MS = 160;

function reducedMotion() {
  return prefersReducedMotion(document.documentElement.dataset.reduceMotion === 'on');
}

/** The same controls stay mounted across widths; launchers retain their own
 * state and behavior. On narrow windows they open as a labelled toolbar. */
export function ResponsiveToolbar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // On narrow windows a closing panel plays mobile-leave before it hides.
  // While it leaves it is inert: no taps, no focus, out of the a11y tree.
  // Set together with the close, so no frame shows the panel already gone.
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  /** Close an open panel; `instant` when the viewport changed under it. */
  const close = useCallback((instant = false) => {
    setOpen(false);
    setLeaving(!instant && !reducedMotion());
  }, []);
  const openPanel = () => {
    setLeaving(false);
    setOpen(true);
  };

  useEffect(() => {
    if (!leaving) return;
    const fallback = window.setTimeout(() => setLeaving(false), LEAVE_FALLBACK_MS);
    return () => window.clearTimeout(fallback);
  }, [leaving]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const resize = () => close(true);
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', resize);
    };
  }, [open, close]);

  const leavingNow = leaving && !open;
  return (
    <div ref={root} className="workspace-toolbar" data-open={open || undefined} data-leaving={leavingNow || undefined}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
      onBlur={event => {
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close();
      }}>
      <button ref={trigger} type="button" className="workspace-toolbar__trigger t-icon-btn"
        aria-label="Workspace views" aria-expanded={open} aria-controls={id}
        onClick={() => (open ? close() : openPanel())}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      <div id={id} className="workspace-toolbar__actions" role="group" aria-label="Workspace view controls"
        aria-hidden={leavingNow || undefined} inert={leavingNow}
        onAnimationEnd={event => {
          if (event.target === event.currentTarget && event.animationName === 'mobile-leave') setLeaving(false);
        }}
        onClick={event => {
          if (!open || !(event.target as HTMLElement).closest('button')) return;
          close();
          // Don't leave keyboard focus on a control hidden by the closed panel.
          // A view that already moved focus into its content keeps that focus.
          if (event.currentTarget.contains(document.activeElement)) trigger.current?.focus();
        }}>
        {children}
      </div>
    </div>
  );
}
