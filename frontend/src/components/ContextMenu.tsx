import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PopoverSurface, MenuItem as MenuRow } from './ui/Popover';

/**
 * macOS-style confirm blink: on click the row's highlight flashes once
 * (off → on → off), THEN the action fires and the menu closes. Must match the
 * `ui-menu-blink` animation duration in index.css so the run/close lands right
 * as the flash finishes. Skipped under prefers-reduced-motion.
 */
const BLINK_MS = 160;

export interface MenuItem {
  id: string;
  label: string;
  /** Optional secondary text, rendered muted after the label. */
  sublabel?: string;
  glyph?: string;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface MenuSection {
  /** Items rendered in order; a divider line separates sections. */
  items: MenuItem[];
  /** Optional small uppercase header rendered above the items. */
  label?: string;
  /**
   * Where to render an item's glyph. Defaults to `true` — glyphs sit on the
   * right edge (state-indicator style) and the leading icon gutter is
   * dropped so labels flush-left. Pass `false` to keep classic leading
   * action icons.
   */
  trailingGlyph?: boolean;
}

export interface ContextMenuProps {
  /** Screen-space anchor (usually the MouseEvent's clientX / clientY). */
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
  /** Optional fixed width in px. */
  width?: number;
  /** Optional max-height in px; overflows scroll. */
  maxHeight?: number;
  /** Show a filter input at the top. */
  searchable?: boolean;
  /**
   * If set, place the menu so its bottom edge sits at this y coordinate
   * (i.e. anchor the menu ABOVE this y, useful for toolbar chips at the
   * bottom of the pane). Overrides the default below-cursor placement.
   */
  anchorBottom?: number;
}

/**
 * Shell-neutral right-click menu. Positions itself at the cursor, flips
 * when it would overflow the viewport, closes on any outside click or
 * Escape. Visual shell (bg/border/radius/shadow) comes from
 * PopoverSurface; rows render through the shared MenuRow so hover and
 * danger/disabled states stay consistent with every other popover in
 * the app.
 */
export default function ContextMenu({
  x,
  y,
  sections,
  onClose,
  width,
  maxHeight,
  searchable,
  anchorBottom,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [filter, setFilter] = useState('');
  // id of the row currently playing the confirm blink (null = none).
  const [blinkingId, setBlinkingId] = useState<string | null>(null);
  const blinkTimer = useRef<number | null>(null);

  // Fire an item's action after a short macOS-style confirm blink, then close.
  // Guards against double-fire (ignores clicks while a blink is already in
  // flight) and honors prefers-reduced-motion by running immediately.
  const fireWithBlink = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return;
      if (blinkTimer.current !== null) return;
      const reduce =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduce) {
        item.run();
        onClose();
        return;
      }
      setBlinkingId(item.id);
      blinkTimer.current = window.setTimeout(() => {
        blinkTimer.current = null;
        item.run();
        onClose();
      }, BLINK_MS);
    },
    [onClose],
  );

  useEffect(
    () => () => {
      if (blinkTimer.current !== null) window.clearTimeout(blinkTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reposition = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = x;
      let ny = anchorBottom !== undefined ? anchorBottom - rect.height : y;
      if (nx + rect.width > vw - 8) nx = Math.max(8, vw - rect.width - 8);
      if (ny + rect.height > vh - 8) ny = Math.max(8, vh - rect.height - 8);
      if (ny < 8) ny = 8;
      setPos((prev) => (prev.x !== nx || prev.y !== ny ? { x: nx, y: ny } : prev));
    };
    reposition();
    // Watch for content-driven height changes (e.g. async sections that
    // grow from a "Loading…" placeholder to the real list) so the menu
    // re-anchors to the chip instead of staying pinned to the original
    // small-content position.
    const ro = new ResizeObserver(reposition);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, anchorBottom]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Single-letter accelerators (e.g. R/E/D/A). Skip while the filter input
      // owns the keystroke, and ignore when modifier keys are held so we don't
      // intercept browser shortcuts like ⌘R.
      if (searchable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const k = e.key.toUpperCase();
      for (const section of sections) {
        for (const item of section.items) {
          if (item.disabled || !item.keys) continue;
          if (item.keys.toUpperCase() === k) {
            e.preventDefault();
            fireWithBlink(item);
            return;
          }
        }
      }
    };
    // mousedown (not click) so clicks on other right-clickable elements can
    // open a fresh menu in the same gesture.
    // Delay registration by one frame so the mousedown that triggered the
    // menu open doesn't immediately close it via event delegation.
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', onDocDown);
    });
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, sections, searchable, fireWithBlink]);

  const run = (item: MenuItem) => fireWithBlink(item);

  useEffect(() => {
    if (searchable) searchRef.current?.focus();
  }, [searchable]);

  const q = filter.toLowerCase();
  const filtered: MenuSection[] = q
    ? sections.map((s) => {
        const matched = s.items.filter(
          (it) => it.label.toLowerCase().includes(q) || it.sublabel?.toLowerCase().includes(q),
        );
        const prefix: MenuItem[] = [];
        const rest: MenuItem[] = [];
        for (const it of matched) {
          if (it.label.toLowerCase().startsWith(q)) prefix.push(it);
          else rest.push(it);
        }
        return { ...s, items: [...prefix, ...rest] };
      })
    : sections;

  return (
    <PopoverSurface
      ref={ref}
      left={pos.x}
      top={pos.y}
      width={width}
      minWidth={width ? undefined : 200}
      // Right-click menus historically sit above every other popover (eg
      // the Contexts popover hosts one internally). Preserve that.
      zIndex={1100}
      onContextMenu={(e) => e.preventDefault()}
      style={{ padding: '4px 0', userSelect: 'none' }}
    >
      {searchable && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--term-line)' }}>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontSize: 11,
            }}
          />
        </div>
      )}
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          ...(maxHeight ? { maxHeight, overflowY: 'auto' } : null),
        }}
      >
        {filtered.map((section, si) => {
          // Default: glyphs render on the right (state-indicator style). A
          // section can opt back into leading icons with trailingGlyph: false.
          const trailing = section.trailingGlyph !== false;
          return (
            <React.Fragment key={si}>
              {si > 0 && (
                <li
                  aria-hidden="true"
                  style={{
                    height: 1,
                    background: 'var(--term-line)',
                    margin: '4px 0',
                    listStyle: 'none',
                  }}
                />
              )}
              {section.label && (
                <li
                  aria-hidden="true"
                  style={{
                    padding: '4px 10px 2px',
                    fontSize: 9,
                    letterSpacing: '.16em',
                    textTransform: 'uppercase',
                    color: 'var(--term-faint)',
                    fontFamily: 'var(--ui-font)',
                    listStyle: 'none',
                  }}
                >
                  {section.label}
                </li>
              )}
              {section.items.map((item) => (
                <MenuRow
                  key={item.id}
                  onClick={() => run(item)}
                  danger={item.danger}
                  disabled={item.disabled}
                  className={blinkingId === item.id ? 'ui-menu-blink' : undefined}
                >
                  {!trailing && item.glyph && (
                    <span
                      style={{
                        width: 14,
                        textAlign: 'center',
                        color: 'var(--term-mid)',
                        fontSize: 11,
                      }}
                    >
                      {item.glyph}
                    </span>
                  )}
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{item.label}</span>
                    {item.sublabel && (
                      <span style={{ color: 'var(--term-muted)', marginLeft: 6 }}>
                        {item.sublabel}
                      </span>
                    )}
                  </span>
                  {item.keys && (
                    <span
                      style={{
                        fontFamily: 'var(--ui-font)',
                        fontSize: 11,
                        color: 'var(--term-faint)',
                        minWidth: 12,
                        textAlign: 'right',
                      }}
                    >
                      {item.keys}
                    </span>
                  )}
                  {trailing && item.glyph && (
                    <span
                      style={{
                        width: 14,
                        textAlign: 'center',
                        color: 'var(--term-mid)',
                        fontSize: 11,
                      }}
                    >
                      {item.glyph}
                    </span>
                  )}
                </MenuRow>
              ))}
            </React.Fragment>
          );
        })}
      </ul>
    </PopoverSurface>
  );
}
