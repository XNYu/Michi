import React from 'react';

/** Small filled circle; animates with the pulse keyframe when `pulse` is set. */
export function Dot({ color, size = 6, pulse = false }: { color: string; size?: number; pulse?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 99,
        background: color,
        color,
        flexShrink: 0,
        boxShadow: pulse ? '0 0 6px 0 currentColor' : undefined,
        animation: pulse ? 'tpulse 1.4s ease-in-out infinite' : 'none',
      }}
    />
  );
}

/** Thin keyboard tag like `⌘K`. */
export function KBD({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 10,
        padding: '1px 5px',
        border: '1px solid var(--term-line)',
        color: 'var(--term-mid)',
        background: 'var(--term-surface)',
        lineHeight: 1.3,
      }}
    >
      {children}
    </span>
  );
}

/** Clickable list row. Hover lifts background to --term-alt unless `active`.
 *  Use for sidebar nav items, thread rows, structure-tree rows, digest entries,
 *  settings options, and palette swatches. */
export function Row({
  active = false,
  className,
  children,
  ...rest
}: { active?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const cls = ['t-row-hover', active && 'is-active', className].filter(Boolean).join(' ');
  return <div className={cls} {...rest}>{children}</div>;
}

/** Tab — focused state suppresses hover, hover hints the bottom border too.
 *  Use for topbar pane tabs and settings section tabs. */
export function Tab({
  focused = false,
  className,
  children,
  ...rest
}: { focused?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const cls = ['t-tab-hover', focused && 'is-focused', className].filter(Boolean).join(' ');
  return <div className={cls} {...rest}>{children}</div>;
}

/** Bordered button — hover lifts background. For topbar map / digest buttons,
 *  retry, reset. */
export function BorderBtn({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['t-border-btn', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest}>{children}</button>;
}

/** Inline icon-button (×, +, stop, retry text). Hover brightens text to
 *  --term-fg, or to --term-danger when `danger`. No background change. */
export function IconBtn({
  danger = false,
  className,
  children,
  ...rest
}: { danger?: boolean } & React.HTMLAttributes<HTMLSpanElement>) {
  const cls = [
    danger ? 't-icon-danger-hover' : 't-icon-hover',
    className,
  ].filter(Boolean).join(' ');
  return <span className={cls} {...rest}>{children}</span>;
}

/** Hover-revealed ⋯ kebab for sidebar rows. Self-anchors to the right edge
 *  of the nearest `position: relative` ancestor and paints a left-fading
 *  gradient (transparent → --term-alt) that masks whatever sits behind it,
 *  matching the Claude Code thread-list hover pattern. The parent row must
 *  show `--term-alt` while hovered or pinned (`open`) so the gradient blends
 *  seamlessly; consumers force that bg when the menu is open. */
export function RowKebab({
  open = false,
  onOpen,
  ariaLabel = 'More actions',
  title = 'More actions',
}: {
  open?: boolean;
  onOpen: (anchor: { x: number; y: number }) => void;
  ariaLabel?: string;
  title?: string;
}) {
  const cls = ['row-kebab', open && 'is-open'].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      aria-hidden={!open || undefined}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 28,
        paddingRight: 10,
        // 28px transparent-to-alt fade, then a solid alt strip the kebab
        // sits on. Bleeds into the row's hover/active background.
        background:
          'linear-gradient(to right, transparent 0%, var(--term-alt) 28px)',
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open || undefined}
        title={title}
        onMouseDown={(e) => {
          // Block the row's onMouseDown/onClick.
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          // Anchor menu just below the button's left edge so it reads as
          // attached to the kebab. ContextMenu flips on viewport overflow.
          onOpen({ x: r.left, y: r.bottom + 2 });
        }}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          width: 16,
          height: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-faint)',
          flexShrink: 0,
          lineHeight: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" />
          <circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
        </svg>
      </button>
    </span>
  );
}

/** Bracketed uppercase tag used for status labels. */
export function Tag({
  color = 'var(--term-mid)',
  bg = 'transparent',
  strong = false,
  children,
}: {
  color?: string;
  bg?: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 10,
        padding: '2px 6px',
        border: `1px solid ${color}`,
        color,
        background: bg,
        fontWeight: strong ? 700 : 500,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}
