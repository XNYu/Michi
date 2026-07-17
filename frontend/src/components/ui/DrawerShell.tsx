import React from 'react';

/**
 * Shared right-anchored slide-in drawer. Every drawer in the app (Settings,
 * Artifacts, Export) now renders through this so they are identical by
 * construction: a full-height (top:0 → bottom:0) frosted `.term-glass` panel
 * at a unified 440px / 50vw, a warm scrim that click-dismisses, `slideInRight`,
 * window-level Escape, and the `▸ TITLE` mono header with an × close button.
 *
 * Before this, Settings + Artifacts followed the pattern by copy-paste while
 * ExportPanel diverged on every axis (opaque, `bottom:22` so not full-height,
 * 480/60vw, its own animation, no scrim). Layering + the scrim material come
 * from index.css (`.ui-drawer-panel`, `.ui-scrim--drawer`).
 */
export interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  /** Uppercased in the header via CSS; pass plain text e.g. "Settings". */
  title: React.ReactNode;
  /** Right-aligned header controls (e.g. add / file buttons). */
  headerActions?: React.ReactNode;
  /** Optional count/badge shown right after the title. */
  titleBadge?: React.ReactNode;
  /** Handle Escape at the drawer level. Set false when a nested overlay (e.g. a
   *  lightbox) should consume Escape first. Default true. */
  closeOnEscape?: boolean;
  'aria-label'?: string;
  children: React.ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  title,
  headerActions,
  titleBadge,
  closeOnEscape = true,
  children,
  ...rest
}: DrawerShellProps) {
  const ariaLabel = rest['aria-label'];

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

  if (!open) return null;

  return (
    <>
      <div
        className="ui-scrim ui-scrim--drawer"
        onMouseDown={onClose}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />
      <div
        className="ui-drawer-panel term-glass"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
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
