import './mobile.css';
import React, { useEffect, useId, useRef, useState } from 'react';

/** The same controls stay mounted across widths; launchers retain their own
 * state and behavior. On narrow windows they open as a labelled toolbar. */
export function ResponsiveToolbar({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  return (
    <div ref={root} className="workspace-toolbar" data-open={open || undefined}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}>
      <button ref={trigger} type="button" className="workspace-toolbar__trigger t-icon-btn"
        aria-label="Workspace views" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(value => !value)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      <div id={id} className="workspace-toolbar__actions" role="group" aria-label="Workspace view controls"
        onClick={event => {
          if (!open || !(event.target as HTMLElement).closest('button')) return;
          setOpen(false);
          // Don't leave keyboard focus on a control hidden by the closed panel.
          // A view that already moved focus into its content keeps that focus.
          if (event.currentTarget.contains(document.activeElement)) trigger.current?.focus();
        }}>
        {children}
      </div>
    </div>
  );
}
