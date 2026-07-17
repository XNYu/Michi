import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared centered modal shell. Every dialog (New Workspace, Move Thread, Create
 * Digest, Command Palette, Confirm) renders through this so they share one
 * scrim, one z-index rung, the frosted `.term-glass` surface, `fadeIn`+`scaleIn`,
 * portal-to-body (escapes the sidebar's clipping stacking context), window-level
 * Escape, focus trap + restore, and `role="dialog"`/`aria-modal`/`aria-labelledby`.
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
  /** center (default) or top-anchored (command/search palettes). */
  anchor?: 'center' | 'top';
  /** Click-scrim / Escape dismiss. Default true. */
  dismissible?: boolean;
  /** Extra header content on the trailing side (e.g. a subtitle chip). */
  headerTrailing?: React.ReactNode;
  'aria-label'?: string;
  children: React.ReactNode;
}

let modalTitleSeq = 0;

export function ModalShell({
  open,
  onClose,
  title,
  titleGlyph,
  accent = 'var(--term-accent)',
  width = 480,
  anchor = 'center',
  dismissible = true,
  headerTrailing,
  children,
  ...rest
}: ModalShellProps) {
  const ariaLabel = rest['aria-label'];
  const paneRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useMemo(() => `modal-title-${++modalTitleSeq}`, []);
  // Remember what was focused when we opened so we can restore it on close.
  const restoreRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: keep Tab cycling within the pane.
      const pane = paneRef.current;
      if (!pane) return;
      const focusables = pane.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    // Focus the first focusable inside the pane (unless a child already grabbed
    // focus via autoFocus). Deferred a frame so portaled content is mounted.
    const raf = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (!pane) return;
      if (pane.contains(document.activeElement) && document.activeElement !== pane) return;
      const focusable = pane.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      // Restore focus to the trigger element.
      restoreRef.current?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return createPortal(
    <div
      className="ui-scrim ui-scrim--modal"
      data-anchor={anchor}
      onMouseDown={dismissible ? onClose : undefined}
    >
      <div
        ref={paneRef}
        className="ui-modal-panel term-glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        style={{ width, maxWidth: '92vw' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
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
      </div>
    </div>,
    document.body,
  );
}
