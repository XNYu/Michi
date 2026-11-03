import React from 'react';
import { createPortal } from 'react-dom';
import {
  animate,
  motion,
  MotionConfigContext,
  MotionGlobalConfig,
  useIsPresent,
  type TargetAndTransition,
  type Transition,
} from 'motion/react';
import { lastInputWasTouch } from '../../lib/inputModality';
import { EASE } from '../../motion/tokens';
import './Menu.css';

// Menus are opened many times a day: barely-there growth in, a quick fade out.
const MENU_IN_MS = 120;
const MENU_IN: Transition = { duration: MENU_IN_MS / 1000, ease: EASE.out };
const MENU_OUT: TargetAndTransition = { opacity: 0, transition: { duration: 0.08, ease: EASE.out } };
const MENU_FROM_SCALE = 0.97;
const EASE_OUT_CSS = `cubic-bezier(${EASE.out.join(', ')})`;
/**
 * Callers place a surface from its measured box: in their layout effects, and
 * again when their ResizeObserver reports over the next frames. A scaled box
 * would misplace it, so the growth holds transparent and unscaled this long.
 */
const PLACE_MS = 34;
/** One native animation from mount: test and tooling waits see it as running. */
const GROW_KEYFRAMES: Keyframe[] = [
  { offset: 0, opacity: 0, transform: 'none', easing: 'step-end' },
  { offset: PLACE_MS / (PLACE_MS + MENU_IN_MS), opacity: 0, transform: `scale(${MENU_FROM_SCALE})`, easing: EASE_OUT_CSS },
  { offset: 1, opacity: 1, transform: 'none' },
];
const FADE_KEYFRAMES: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
/** Surfaces that open per keystroke or on hover keep their plain CSS fade. */
const FADE_ONLY_MENUS: ReadonlySet<MenuKind> = new Set<MenuKind>(['mentions', 'slash', 'detail', 'usage']);
/** A press this recent is what opened the menu, so the menu grows from it. */
const OPENING_PRESS_MS = 1000;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

let lastPress: { x: number; y: number; at: number } | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (event) => {
    lastPress = { x: event.clientX, y: event.clientY, at: performance.now() };
  }, { capture: true, passive: true });
  // A key after the press means the keyboard opened whatever comes next.
  window.addEventListener('keydown', () => { lastPress = null; }, { capture: true, passive: true });
}

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
   *  avoid flicker on rapid hover-in/out. A menu surface grows in from the
   *  press that opened it (opacity + scale .97→1, 120ms) and, when the caller
   *  renders it inside `<AnimatePresence>`, fades out (80ms) as an inert ghost.
   *  Tooltips, hover cards and the @ / slash autocompletes only fade in. */
  animate?: boolean;
  /** Replaces the default fade-out of a menu surface (a motion target with its
   *  own transition). Plays only inside the caller's `<AnimatePresence>`. */
  exit?: TargetAndTransition;
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
      exit,
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
    // Menus grow in with motion; everything else keeps the CSS fade below. A
    // caller transform would fight the growth.
    const grows = animate && !isTooltip && role !== 'tooltip'
      && !(menuKind && FADE_ONLY_MENUS.has(menuKind)) && style?.transform === undefined;

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
      animation: animate && !menuKind && !grows ? 'fadeIn var(--t-soft) ease-out both' : undefined,
      ...style,
    };
    const surfaceClassName = [menuKind && 'michi-menu', useGlass && 'term-glass', className].filter(Boolean).join(' ') || undefined;

    if (grows) {
      return createPortal(
        <GrowingSurface
          surfaceRef={ref}
          sides={{ left, right, top, bottom }}
          exit={exit ?? MENU_OUT}
          role={role}
          ariaLabel={ariaLabel}
          className={surfaceClassName}
          menuKind={menuKind}
          style={baseStyle}
          onMouseDown={onMouseDown}
          onClick={onClick}
          onContextMenu={onContextMenu}
        >
          {children}
        </GrowingSurface>,
        document.body,
      );
    }

    return createPortal(
      <div
        ref={ref}
        role={role}
        aria-label={ariaLabel}
        className={surfaceClassName}
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

/**
 * A surface's size as it settles, for callers that place it from a measured
 * box: while a menu grows in (scale .97→1), its on-screen box is smaller.
 * Returns the box too, for its position.
 */
export function measureSurface(surface: HTMLElement): { box: DOMRect; width: number; height: number; scaleY: number } {
  const box = surface.getBoundingClientRect();
  const match = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(surface).transform);
  const [a, b, c, d] = match ? match[1].split(',').map(Number) : [1, 0, 0, 1];
  const scaleX = Math.hypot(a, b) || 1;
  const scaleY = Math.hypot(c, d) || 1;
  return { box, width: box.width / scaleX, height: box.height / scaleY, scaleY };
}

type Sides = Pick<PopoverSurfaceProps, 'left' | 'right' | 'top' | 'bottom'>;

/** The corner a surface is anchored by. */
function sideOrigin(sides: Sides): string {
  const vertical = sides.bottom !== undefined && sides.top === undefined ? 'bottom' : 'top';
  const horizontal = sides.right !== undefined && sides.left === undefined ? 'right' : 'left';
  return `${vertical} ${horizontal}`;
}

/** The point the menu grows from: the press that opened it, else its anchored corner. */
function growthOrigin(node: HTMLElement, sides: Sides): string {
  const box = node.getBoundingClientRect();
  if (lastPress && performance.now() - lastPress.at < OPENING_PRESS_MS && box.width > 0 && box.height > 0) {
    const x = Math.min(Math.max(lastPress.x - box.left, 0), box.width);
    const y = Math.min(Math.max(lastPress.y - box.top, 0), box.height);
    return `${x}px ${y}px`;
  }
  return sideOrigin(sides);
}

function prefersReduced(config: string | undefined): boolean {
  // MotionRoot: 'always' is the in-app Reduce motion preference, 'user' the OS.
  return config === 'always' || (config === 'user' && (window.matchMedia?.(REDUCED_MOTION)?.matches ?? false));
}

function GrowingSurface({
  surfaceRef,
  sides,
  exit,
  role,
  ariaLabel,
  className,
  menuKind,
  style,
  onMouseDown,
  onClick,
  onContextMenu,
  children,
}: {
  surfaceRef: React.ForwardedRef<HTMLDivElement>;
  sides: Sides;
  exit: TargetAndTransition;
  role?: string;
  ariaLabel?: string;
  className?: string;
  menuKind?: MenuKind;
  style: React.CSSProperties;
  onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}) {
  // Leaving (inside the caller's AnimatePresence): no longer a layer. The role
  // goes too, because Esc routing matches menus and lists by role alone.
  const leaving = !useIsPresent();
  const reducedMotion = React.useContext(MotionConfigContext).reducedMotion;
  const nodeRef = React.useRef<HTMLDivElement | null>(null);
  const entranceRef = React.useRef<Animation | null>(null);
  const live = React.useRef({ sides, reducedMotion });
  live.current = { sides, reducedMotion };

  const setNode = React.useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    if (typeof surfaceRef === 'function') surfaceRef(node);
    else if (surfaceRef) surfaceRef.current = node;
  }, [surfaceRef]);

  // Started before paint so the first frame is already transparent. The scale
  // only begins after PLACE_MS, once the caller has measured and placed it.
  React.useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || MotionGlobalConfig.skipAnimations || typeof node.animate !== 'function') return;
    const reduced = prefersReduced(live.current.reducedMotion);
    const entrance = reduced
      ? node.animate(FADE_KEYFRAMES, { duration: MENU_IN_MS, easing: EASE_OUT_CSS })
      : node.animate(GROW_KEYFRAMES, { duration: PLACE_MS + MENU_IN_MS, easing: 'linear' });
    entranceRef.current = entrance;
    let frame = 0;
    if (!reduced) {
      node.style.transformOrigin = sideOrigin(live.current.sides);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { node.style.transformOrigin = growthOrigin(node, live.current.sides); });
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      entrance.cancel();
      entranceRef.current = null;
    };
  }, []);

  const wasLeaving = React.useRef(leaving);
  React.useLayoutEffect(() => {
    const node = nodeRef.current;
    if (node && leaving) {
      // The exit takes over from wherever the entrance got to.
      const entrance = entranceRef.current;
      if (entrance?.playState === 'running') {
        try { entrance.commitStyles(); } catch { /* not rendered: nothing to hold */ }
        entrance.cancel();
      }
    } else if (node && wasLeaving.current) {
      // Reopened while fading out: AnimatePresence brings the same surface back.
      node.style.transform = '';
      animate(node, { opacity: 1 }, MENU_IN);
    }
    wasLeaving.current = leaving;
  }, [leaving]);

  return (
    <motion.div
      ref={setNode}
      role={leaving ? undefined : role}
      aria-label={ariaLabel}
      aria-hidden={leaving || undefined}
      inert={leaving}
      className={className}
      data-menu={menuKind}
      // Plays the shared menu entrance, in its own (motion) form.
      data-menu-animate="true"
      data-menu-motion="grow"
      style={{ ...style, pointerEvents: leaving ? 'none' : style.pointerEvents }}
      exit={exit}
      onMouseDown={leaving ? undefined : onMouseDown}
      onClick={leaving ? undefined : onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </motion.div>
  );
}

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
