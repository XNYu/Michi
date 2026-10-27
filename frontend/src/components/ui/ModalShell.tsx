import React from 'react';
import { createPortal } from 'react-dom';
import { useOverlayFocus } from './useOverlayFocus';

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
  maxHeight,
  captureEscape = false,
  anchor = 'center',
  dismissible = true,
  headerTrailing,
  children,
  ...rest
}: ModalShellProps) {
  const ariaLabel = rest['aria-label'];
  const paneRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useMemo(() => `modal-title-${++modalTitleSeq}`, []);
  useOverlayFocus({ open, panelRef: paneRef, initialFocus: 'first', deferInitialFocus: true, restore: 'always' });

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
    if (!open) return;
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
  }, [open, captureEscape]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Dim scrim — a SIBLING of the panel, never its ancestor. If the glass
          panel were nested inside this (translucent, opacity-fading) element,
          its backdrop-filter would sample the scrim's flat fill instead of the
          real app content and render clear. Keeping them siblings lets the panel
          frost through to the page exactly like the drawer does. */}
      <div
        className="ui-scrim ui-scrim--modal"
        onMouseDown={dismissible ? onClose : undefined}
      />
      {/* Transparent, un-animated centering layer (no bg/opacity/transform, so it
          doesn't isolate the panel's backdrop). Clicks on its empty area dismiss. */}
      <div
        className="ui-modal-positioner"
        data-anchor={anchor}
        onMouseDown={dismissible ? onClose : undefined}
      >
        <div
          ref={paneRef}
          className="ui-modal-panel term-glass"
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          // An explicit aria-label wins over the visible (uppercased, terse)
          // title, e.g. the diff viewer names itself by file path.
          aria-labelledby={title && !ariaLabel ? titleId : undefined}
          aria-label={ariaLabel}
          style={{ width, maxWidth: '92vw', maxHeight }}
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
      </div>
    </>,
    document.body,
  );
}
