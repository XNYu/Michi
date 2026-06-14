import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared visual shell for every floating panel in the terminal UI
 * (right-click menus, slash/@ autocompletes, header dropdowns, side
 * popovers). Owns the surface tokens — bg, border, radius, shadow, font —
 * so every popover renders consistently. Positioning is intentionally NOT
 * the surface's job; callers compute `left/top` (and any flip/clamp
 * behaviour) and pass the result in. The surface forwards a ref so a
 * caller can measure itself for that flip pass.
 *
 * Two variants:
 *   - 'menu'    (default): popover/dropdown look. Radius/shadow tuned to
 *                          read as a floating list.
 *   - 'tooltip'          : smaller pill used for icon hover labels.
 */
export type PopoverVariant = 'menu' | 'tooltip';

export interface PopoverSurfaceProps {
  /** Viewport-space coordinates. Callers handle measurement / flip.
   *  Pass `top` OR `bottom` (and `left` OR `right`) — undefined sides
   *  collapse to CSS `auto`, the same as setting them yourself. */
  left?: number | string;
  right?: number | string;
  top?: number | string;
  bottom?: number | string;
  variant?: PopoverVariant;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  /** Stacking. Defaults: menu=1000, tooltip=1050. Override per call site to
   *  preserve historical layering (some menus sit above modals etc). */
  zIndex?: number;
  /** Animate in. Defaults to true; tooltip variant defaults to false to
   *  avoid flicker on rapid hover-in/out. */
  animate?: boolean;
  role?: string;
  'aria-label'?: string;
  /** Inline overrides for the rare callsite that needs e.g. `bottom`
   *  anchoring instead of `top`. Merged last so it wins. */
  style?: React.CSSProperties;
  className?: string;
  /** Mouse handlers — used by callers that need to stop propagation
   *  (e.g. a popover nested inside another popover). */
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}

/**
 * Floating surface, portaled to document.body. Body-portal escapes any
 * transformed/will-change ancestor that would otherwise hijack our
 * `position: fixed` containing block — every popover in this app needs
 * that escape hatch, so we do it here once.
 */
export const PopoverSurface = React.forwardRef<HTMLDivElement, PopoverSurfaceProps>(
  function PopoverSurface(props, ref) {
    const {
      left,
      right,
      top,
      bottom,
      variant = 'menu',
      width,
      minWidth,
      maxWidth,
      maxHeight,
      zIndex,
      animate = variant === 'menu',
      role,
      style,
      className,
      onMouseDown,
      onClick,
      onContextMenu,
      children,
    } = props;
    const ariaLabel = props['aria-label'];

    const isTooltip = variant === 'tooltip';
    const defaultZ = isTooltip ? 1050 : 1000;

    const baseStyle: React.CSSProperties = {
      position: 'fixed',
      left,
      right,
      top,
      bottom,
      width,
      minWidth,
      maxWidth,
      maxHeight,
      overflow: maxHeight !== undefined ? 'auto' : undefined,
      background: `var(${isTooltip ? '--ui-tooltip-bg' : '--ui-popover-bg'})`,
      border: `var(${isTooltip ? '--ui-tooltip-border' : '--ui-popover-border'})`,
      borderRadius: `var(${isTooltip ? '--ui-tooltip-radius' : '--ui-popover-radius'})`,
      boxShadow: `var(${isTooltip ? '--ui-tooltip-shadow' : '--ui-popover-shadow'})`,
      fontFamily: 'var(--ui-font)',
      fontSize: isTooltip ? 11 : 11.5,
      color: 'var(--term-fg)',
      zIndex: zIndex ?? defaultZ,
      animation: animate ? 'fadeIn 150ms ease-out both' : undefined,
      ...style,
    };

    return createPortal(
      <div
        ref={ref}
        role={role}
        aria-label={ariaLabel}
        className={className}
        style={baseStyle}
        onMouseDown={onMouseDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {children}
      </div>,
      document.body,
    );
  },
);

/**
 * Compact tooltip pill anchored to a button's bounding rect. Centers
 * horizontally below the anchor; consumers can opt out of the auto-anchor
 * by passing explicit `left/top`. Uses the tooltip variant of
 * PopoverSurface so it inherits the shared tooltip tokens.
 */
export function Tooltip({
  anchorRef,
  label,
  kbd,
  offset = 6,
  zIndex,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  label: React.ReactNode;
  kbd?: React.ReactNode;
  offset?: number;
  zIndex?: number;
}) {
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + offset });
  }, [anchorRef, offset]);
  if (!pos) return null;
  return (
    <PopoverSurface
      variant="tooltip"
      left={pos.left}
      top={pos.top}
      zIndex={zIndex}
      role="tooltip"
      style={{
        transform: 'translateX(-50%)',
        padding: '3px 7px',
        color: 'var(--term-mid)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span>{label}</span>
      {kbd && <span style={{ color: 'var(--term-faint)', fontSize: 10 }}>{kbd}</span>}
    </PopoverSurface>
  );
}

export interface MenuItemProps {
  /** Currently highlighted by keyboard/selection. Pure visual; click is
   *  driven by onClick. */
  active?: boolean;
  /** Destructive action — uses --term-danger for label color. */
  danger?: boolean;
  /** Greyed out and non-interactive (cursor: not-allowed). */
  disabled?: boolean;
  onClick?: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLLIElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLLIElement>;
  onContextMenu?: React.MouseEventHandler<HTMLLIElement>;
  title?: string;
  role?: string;
  'aria-selected'?: boolean;
  /** Inline overrides for the rare callsite that needs custom layout. */
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}

/**
 * A clickable row inside a PopoverSurface. Owns padding, font size, hover
 * background, and the danger/disabled visual states via the `.ui-menu-item`
 * CSS class. Children are arbitrary so callers can drop in icons, labels,
 * keyboard hints, or badges as needed.
 *
 * Hover is CSS-driven, not inline JS — that's the bug pattern we're
 * consolidating away from. Active state is exposed via `data-active` so the
 * same hover background applies for keyboard-highlighted rows.
 */
export function MenuItem(props: MenuItemProps) {
  const {
    active,
    danger,
    disabled,
    onClick,
    onMouseDown,
    onMouseEnter,
    onContextMenu,
    title,
    role,
    style,
    className,
    children,
  } = props;
  const ariaSelected = props['aria-selected'];

  return (
    <li
      role={role}
      title={title}
      aria-selected={ariaSelected}
      aria-disabled={disabled || undefined}
      data-active={active ? 'true' : undefined}
      data-danger={danger ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      onClick={() => {
        if (disabled) return;
        onClick?.();
      }}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      className={`ui-menu-item${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </li>
  );
}
