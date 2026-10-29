import React from 'react';
import { createPortal } from 'react-dom';
import { lastInputWasTouch } from '../../lib/inputModality';
import './Menu.css';

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
export type MenuKind = 'context' | 'workspace' | 'agents' | 'mentions' | 'slash' | 'composer' | 'usage' | 'detail';

export interface PopoverSurfaceProps {
  /** Viewport-space coordinates. Callers handle measurement / flip.
   *  Pass `top` OR `bottom` (and `left` OR `right`) — undefined sides
   *  collapse to CSS `auto`, the same as setting them yourself. */
  left?: number | string;
  right?: number | string;
  top?: number | string;
  bottom?: number | string;
  variant?: PopoverVariant;
  /** Tuned menu appearance, scoped independently of tooltips and other panels. */
  menuKind?: MenuKind;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  /** Stacking. Defaults: menu=1000, tooltip=1050. Override per call site to
   *  preserve historical layering (some menus sit above modals etc). */
  zIndex?: React.CSSProperties['zIndex'];
  /** Animate in. Defaults to true; tooltip variant defaults to false to
   *  avoid flicker on rapid hover-in/out. */
  animate?: boolean;
  /** Opt into the shared frosted-glass material (.term-glass): the surface
   *  drops its opaque bg/shadow so the glass primitive owns them (blur + wash +
   *  cast), matching the sidebar and Settings drawer. Border/radius/font stay. */
  glass?: boolean;
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
      menuKind,
      width,
      minWidth,
      maxWidth,
      maxHeight,
      zIndex,
      animate = variant === 'menu',
      glass = false,
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
    const defaultZ = isTooltip ? 'var(--z-tooltip)' : 'var(--z-popover)';
    // Tuned menus share the frosted .term-glass with the Command Palette and
    // drawers; the right-click menu is the deliberate solid exception.
    const useGlass = glass || (menuKind !== undefined && menuKind !== 'context');

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
      // When `glass`, hand bg + shadow to the .term-glass class (frosted material
      // shared with the sidebar / Settings drawer); keep border/radius here.
      background: menuKind || useGlass ? undefined : `var(${isTooltip ? '--ui-tooltip-bg' : '--ui-popover-bg'})`,
      border: menuKind ? undefined : `var(${isTooltip ? '--ui-tooltip-border' : '--ui-popover-border'})`,
      borderRadius: menuKind ? undefined : `var(${isTooltip ? '--ui-tooltip-radius' : '--ui-popover-radius'})`,
      boxShadow: menuKind || useGlass ? undefined : `var(${isTooltip ? '--ui-tooltip-shadow' : '--ui-popover-shadow'})`,
      fontFamily: menuKind ? undefined : 'var(--ui-font)',
      fontSize: menuKind ? undefined : isTooltip ? 'var(--fs-sm)' : 'var(--fs-md)',
      color: 'var(--term-fg)',
      zIndex: zIndex ?? defaultZ,
      animation: animate && !menuKind ? 'fadeIn var(--t-soft) ease-out both' : undefined,
      ...style,
    };

    return createPortal(
      <div
        ref={ref}
        role={role}
        aria-label={ariaLabel}
        className={[menuKind && 'michi-menu', useGlass && 'term-glass', className].filter(Boolean).join(' ') || undefined}
        data-menu={menuKind}
        data-menu-animate={menuKind && animate ? 'true' : undefined}
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

export type TooltipSide = 'bottom' | 'right';

interface TooltipAnchorProps {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
}

/**
 * Compact tooltip pill anchored to a button's bounding rect. Centers
 * horizontally below the anchor, then clamps inside the viewport and flips
 * above when there is no room below. Uses the tooltip variant of
 * PopoverSurface so it inherits the shared tooltip tokens.
 *
 * Renders nothing when it mounts right after a tap: the tap's synthetic hover
 * would otherwise leave the pill up until the next tap elsewhere.
 */
export function Tooltip({
  anchorRef,
  label,
  kbd,
  offset = 6,
  zIndex,
  animate = false,
  side = 'bottom',
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  label: React.ReactNode;
  kbd?: React.ReactNode;
  offset?: number;
  zIndex?: React.CSSProperties['zIndex'];
  /** Fade the pill in. Off by default so hover-driven callers do not flicker. */
  animate?: boolean;
  /** Preferred placement. `right` is used by the collapsed rail. */
  side?: TooltipSide;
}) {
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const [fromTouch] = React.useState(lastInputWasTouch);
  const bubbleRef = React.useRef<HTMLDivElement>(null);

  const measure = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el || fromTouch) return;
    const r = el.getBoundingClientRect();
    const bubble = bubbleRef.current;
    const width = bubble?.offsetWidth ?? 0;
    const height = bubble?.offsetHeight ?? 0;
    const margin = 8;
    let left: number;
    let top: number;
    if (side === 'right') {
      left = r.right + offset;
      top = r.top + r.height / 2 - height / 2;
      top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin));
      if (width > 0 && left + width > window.innerWidth - margin) {
        const flipped = r.left - offset - width;
        left = flipped >= margin ? flipped : Math.max(margin, window.innerWidth - width - margin);
      }
    } else {
      const center = r.left + r.width / 2;
      left = width > 0
        ? Math.min(
            Math.max(center - width / 2, margin),
            Math.max(margin, window.innerWidth - width - margin),
          )
        : center;
      top = r.bottom + offset;
      if (height > 0 && top + height > window.innerHeight - margin) {
        const above = r.top - offset - height;
        if (above >= margin) top = above;
      }
    }
    setPos((prev) => (
      prev !== null && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5
        ? prev
        : { left, top }
    ));
  }, [anchorRef, fromTouch, offset, side]);

  // Run once before paint, then again after the pill mounts so the clamp and
  // flip use its real size. `hasPosition` flips once and triggers the second pass.
  const hasPosition = pos !== null;
  React.useLayoutEffect(() => {
    if (fromTouch) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [fromTouch, measure, label, kbd, hasPosition, side]);

  if (fromTouch || pos === null) return null;
  return (
    <PopoverSurface
      ref={bubbleRef}
      variant="tooltip"
      left={pos.left}
      top={pos.top}
      zIndex={zIndex}
      role="tooltip"
      animate={animate}
      style={{
        padding: '3px 7px',
        color: 'var(--term-mid)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 'calc(100vw - 16px)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {kbd && <span style={{ flex: 'none', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)' }}>{kbd}</span>}
    </PopoverSurface>
  );
}

export interface HoverTipProps {
  label: React.ReactNode;
  kbd?: React.ReactNode;
  /** Hover dwell before the pill appears. Keyboard focus is immediate. */
  delayMs?: number;
  /** Suppress the pill without remounting the anchor (keeps its transitions). */
  disabled?: boolean;
  offset?: number;
  zIndex?: React.CSSProperties['zIndex'];
  side?: TooltipSide;
  children: React.ReactElement<TooltipAnchorProps>;
}

/**
 * Attach a delayed hover/focus tooltip to one anchor element. The anchor is
 * cloned (no wrapper DOM) so layout is unchanged, and its own handlers/ref are
 * chained ahead of the tooltip's. Hover uses `delayMs`; focus is immediate.
 */
export function HoverTip({
  label,
  kbd,
  delayMs = 450,
  disabled = false,
  offset,
  zIndex,
  side,
  children,
}: HoverTipProps) {
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = React.useState(false);
  const childRef = children.props.ref;

  const clearTimer = React.useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const hide = React.useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const showNow = React.useCallback(() => {
    if (disabled || lastInputWasTouch()) return;
    clearTimer();
    setOpen(true);
  }, [clearTimer, disabled]);

  const showAfterHover = React.useCallback(() => {
    if (disabled || lastInputWasTouch()) return;
    clearTimer();
    if (delayMs <= 0) {
      setOpen(true);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setOpen(true);
    }, delayMs);
  }, [clearTimer, delayMs, disabled]);

  React.useEffect(() => {
    if (disabled) hide();
    return clearTimer;
  }, [clearTimer, disabled, hide]);

  const setAnchor = React.useCallback((el: HTMLElement | null) => {
    anchorRef.current = el;
    if (typeof childRef === 'function') childRef(el);
    else if (childRef != null) {
      (childRef as React.MutableRefObject<HTMLElement | null>).current = el;
    }
  }, [childRef]);

  const anchor = React.cloneElement(children, {
    ref: setAnchor,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseEnter?.(event);
      showAfterHover();
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      showNow();
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      children.props.onPointerDown?.(event);
      hide();
    },
  });

  return (
    <>
      {anchor}
      {open && !disabled && (
        <Tooltip
          anchorRef={anchorRef}
          label={label}
          kbd={kbd}
          offset={offset}
          zIndex={zIndex}
          side={side}
          animate
        />
      )}
    </>
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
  /** DOM id, e.g. for a list's aria-activedescendant. */
  id?: string;
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
    id,
    style,
    className,
    children,
  } = props;
  const ariaSelected = props['aria-selected'];

  return (
    <li
      id={id}
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
