import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PopoverSurface, MenuItem as MenuRow } from './ui/Popover';
import { useMenuConfirm } from './ui/useMenuConfirm';

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
  /**
   * When true, the section is always visible regardless of the search filter.
   * Useful for action rows like "New workspace" that should stay pinned at the
   * bottom.
   */
  pinned?: boolean;
}

export interface ContextMenuProps {
  /** Screen-space anchor (usually the MouseEvent's clientX / clientY). With
   *  `anchorBottom`, `y` is where the menu's top goes when it flips BELOW its
   *  trigger (the trigger's bottom edge + gap). */
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
  menuKind?: 'context' | 'workspace' | 'agents';
  /** Optional fixed width in px. */
  width?: number;
  /** Optional max-height in px; overflows scroll. */
  maxHeight?: number;
  /** Show a filter input at the top. */
  searchable?: boolean;
  /** Placeholder text for the search input. Defaults to "filter…". */
  searchPlaceholder?: string;
  /**
   * If set, place the menu so its bottom edge sits at this y coordinate
   * (i.e. anchor the menu ABOVE this y, useful for toolbar chips at the
   * bottom of the pane). Overrides the default below-cursor placement. When
   * there is clearly more room below, the menu flips to start at `y`; either
   * way its height is capped to that side so it never covers the trigger.
   */
  anchorBottom?: number;
  /** The element that opened the menu. Presses on it are not "outside" clicks,
   *  so the trigger's own click can toggle the menu closed instead of the menu
   *  closing on mousedown and reopening on click. */
  trigger?: HTMLElement | null;
}

/**
 * Full text of a row whose description is clamped (agent descriptions run to a
 * paragraph). Sits beside the menu at the hovered row, flipping to the left when
 * the right side has no room. Pointer-transparent so it never steals the hover.
 */
function MenuDetailCard({ menuRef, rowTop, title, text }: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  rowTop: number;
  title: string;
  text: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const menu = menuRef.current;
    if (!card || !menu) return;
    const m = menu.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = m.right + 6;
    if (left + c.width > vw - 8) left = m.left - 6 - c.width;
    left = Math.max(8, Math.min(left, vw - c.width - 8));
    const top = Math.max(8, Math.min(rowTop, vh - c.height - 8));
    setPlace((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [menuRef, rowTop, title, text]);
  return (
    <PopoverSurface
      ref={cardRef}
      menuKind="detail"
      role="tooltip"
      left={place?.left ?? -9999}
      top={place?.top ?? 0}
      width="var(--m-width)"
      maxWidth="calc(100vw - 16px)"
      zIndex={1101}
      style={{ pointerEvents: 'none', visibility: place ? 'visible' : 'hidden' }}
    >
      <div className="michi-menu-detail-title">{title}</div>
      <div className="michi-menu-detail-body">{text}</div>
    </PopoverSurface>
  );
}

const DETAIL_DELAY_MS = 250;

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
  menuKind = 'context',
  width,
  maxHeight,
  searchable,
  searchPlaceholder,
  anchorBottom,
  trigger,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // cap: max height when anchored to a toolbar trigger (space on the chosen side).
  const [pos, setPos] = useState<{ x: number; y: number; cap?: number }>({ x, y });
  // Hovered (or arrow-selected) row whose clamped description is shown in full.
  const [detail, setDetail] = useState<{ id: string; rowTop: number } | null>(null);
  const detailTimer = useRef<number | undefined>(undefined);
  const detailShownRef = useRef(false);
  detailShownRef.current = detail !== null;
  const [filter, setFilter] = useState('');
  // Keyboard-navigable active index for searchable menus (-1 = nothing highlighted).
  const [activeIdx, setActiveIdx] = useState(-1);
  const { blinkingId, confirm, cancel } = useMenuConfirm();

  // --- Stable refs for values used inside the dismiss effect ---
  // React 18 flushes discrete-event state updates synchronously, which means
  // a parent re-render during a mousedown can cause useEffect cleanup to run
  // *while the native event is still bubbling*. If `onClose` or `sections`
  // sit in the dependency array the cleanup removes the document listener and
  // the rAF-delayed re-registration leaves a 1-frame gap where outside clicks
  // are silently dropped. Refs let the listener always call the latest
  // callback without re-cycling the effect.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const triggerRef = useRef(trigger);
  useLayoutEffect(() => { triggerRef.current = trigger; }, [trigger]);
  const sectionsRef = useRef(sections);
  useLayoutEffect(() => { sectionsRef.current = sections; }, [sections]);
  const dismiss = useCallback(() => {
    cancel();
    onCloseRef.current();
  }, [cancel]);

  // Fire an item's action after a short macOS-style confirm blink, then close.
  // Guards against double-fire (ignores clicks while a blink is already in
  // flight) and honors prefers-reduced-motion by running immediately.
  const fireWithBlink = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return;
      confirm(item.id, () => {
        const current = sectionsRef.current.flatMap((section) => section.items).find((candidate) => candidate.id === item.id);
        if (!current || current.disabled) return;
        current.run();
        onCloseRef.current();
      });
    },
    [confirm],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reposition = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let nx = x;
      if (nx + rect.width > vw - 8) nx = Math.max(8, vw - rect.width - 8);
      nx = Math.max(8, nx);
      let ny = y;
      let cap: number | undefined;
      if (anchorBottom !== undefined) {
        // Toolbar trigger: prefer above it, flip below (to `y`) when there is
        // clearly more room there — same rule as ComposerModelPicker. The cap
        // makes a long list scroll instead of sliding over the trigger.
        const aboveSpace = Math.min(anchorBottom, vh) - 8;
        const belowSpace = vh - 8 - y;
        const above = aboveSpace >= Math.min(240, vh / 2) || aboveSpace >= belowSpace;
        cap = Math.max(80, Math.min(above ? aboveSpace : belowSpace, vh - 16));
        const height = Math.min(rect.height, cap);
        ny = above ? anchorBottom - height : y;
        // Anchors are captured at open; if the viewport shrinks while the menu
        // is up they go stale, so still keep the whole menu on screen.
        ny = Math.max(8, Math.min(ny, vh - 8 - height));
      } else {
        if (ny + rect.height > vh - 8) ny = Math.max(8, vh - rect.height - 8);
        if (ny < 8) ny = 8;
      }
      setPos((prev) => (prev.x !== nx || prev.y !== ny || prev.cap !== cap ? { x: nx, y: ny, cap } : prev));
    };
    reposition();
    // Watch for content-driven height changes (e.g. async sections that
    // grow from a "Loading…" placeholder to the real list) so the menu
    // re-anchors to the chip instead of staying pinned to the original
    // small-content position.
    const ro = new ResizeObserver(reposition);
    ro.observe(el);
    window.addEventListener('resize', reposition);
    return () => { ro.disconnect(); window.removeEventListener('resize', reposition); };
  }, [x, y, anchorBottom]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      if (e.target instanceof Node && triggerRef.current?.contains(e.target)) return;
      dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
        return;
      }
      // Single-letter accelerators (e.g. R/E/D/A). Skip while the filter input
      // owns the keystroke, and ignore when modifier keys are held so we don't
      // intercept browser shortcuts like ⌘R.
      if (searchable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return;
      const k = e.key.toUpperCase();
      for (const section of sectionsRef.current) {
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
  }, [searchable, fireWithBlink, dismiss]);

  const run = (item: MenuItem) => fireWithBlink(item);

  const hideDetail = useCallback(() => {
    window.clearTimeout(detailTimer.current);
    setDetail(null);
  }, []);

  // Show the full description for a row whose sublabel is clamped. The first
  // card waits a beat so crossing the list doesn't flash cards; once one is up,
  // moving to another row swaps it immediately, like native tooltips.
  const showDetailFor = useCallback((id: string, row: HTMLElement) => {
    window.clearTimeout(detailTimer.current);
    const sub = row.querySelector<HTMLElement>('.michi-menu-sublabel');
    if (!sub || sub.scrollHeight <= sub.clientHeight + 1) {
      setDetail(null);
      return;
    }
    const next = { id, rowTop: row.getBoundingClientRect().top };
    if (detailShownRef.current) setDetail(next);
    else detailTimer.current = window.setTimeout(() => setDetail(next), DETAIL_DELAY_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(detailTimer.current), []);

  useLayoutEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  useEffect(() => {
    if (searchable) searchRef.current?.focus();
  }, [searchable]);

  // Reset active index when the filter changes so Enter always fires the
  // top match. Start at 0 (first item highlighted) once the user types.
  useEffect(() => {
    setActiveIdx(filter ? 0 : -1);
    hideDetail();
  }, [filter, hideDetail]);

  const q = filter.toLowerCase();
  const filtered: MenuSection[] = q
    ? sections.map((s) => {
        if (s.pinned) return s;
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

  // Flat list of enabled items from non-pinned sections for keyboard navigation.
  const flatItems = filtered
    .filter((s) => !s.pinned)
    .flatMap((s) => s.items.filter((it) => !it.disabled));

  // Handle arrow/enter in the search input for keyboard navigation.
  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cancel();
        const next = e.key === 'ArrowDown'
          ? Math.min(flatItems.length - 1, activeIdx + 1)
          : Math.max(0, activeIdx - 1);
        setActiveIdx(next);
        // Keyboard selection previews the full description too, once the
        // newly active row has rendered.
        const item = flatItems[next];
        requestAnimationFrame(() => {
          const row = ref.current?.querySelector<HTMLElement>('[data-active="true"]');
          if (item?.sublabel && row) showDetailFor(item.id, row);
          else hideDetail();
        });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = flatItems[activeIdx];
        if (item) fireWithBlink(item);
        return;
      }
    },
    [flatItems, activeIdx, fireWithBlink, dismiss, cancel, showDetailFor, hideDetail],
  );

  const detailItem = detail
    ? filtered.flatMap((s) => s.items).find((it) => it.id === detail.id)
    : undefined;

  return (
    <>
    <PopoverSurface
      ref={ref}
      menuKind={menuKind}
      role="menu"
      aria-label={menuKind === 'workspace' ? 'Workspaces' : menuKind === 'agents' ? 'Agents' : 'Actions'}
      left={pos.x}
      top={pos.y}
      width={width ?? 'var(--m-width)'}
      maxWidth="calc(100vw - 16px)"
      maxHeight={pos.cap ?? 'calc(100dvh - 16px)'}
      // Right-click menus historically sit above every other popover (eg
      // the Contexts popover hosts one internally). Preserve that.
      zIndex={1100}
      onContextMenu={(e) => e.preventDefault()}
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', userSelect: 'none' }}
    >
      {searchable && (
        <div className="michi-menu-search">
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => { cancel(); setFilter(e.target.value); }}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder ?? 'filter…'}
            aria-label={searchPlaceholder ?? 'Filter options'}
          />
        </div>
      )}
      <ul
        className="michi-menu-list"
        style={{ maxHeight: maxHeight ?? 'var(--m-maxHeight)' }}
        onMouseLeave={hideDetail}
        onScroll={hideDetail}
      >
        {(() => {
          let flatIdx = 0;
          return filtered
            .filter((s) => !s.pinned)
            .map((section, si) => {
              // Default: glyphs render on the right (state-indicator style). A
              // section can opt back into leading icons with trailingGlyph: false.
              const trailing = section.trailingGlyph !== false;
              return (
                <React.Fragment key={si}>
                  {si > 0 && (
                    <li
                      aria-hidden="true"
                      className="michi-menu-divider"
                    />
                  )}
                  {section.label && (
                    <li
                      aria-hidden="true"
                      className="michi-menu-section"
                    >
                      {section.label}
                    </li>
                  )}
                  {section.items.map((item) => {
                    // Only enabled items participate in keyboard navigation.
                    const myFlatIdx = item.disabled ? -1 : flatIdx++;
                    const isActive = searchable && myFlatIdx >= 0 && myFlatIdx === activeIdx;
                    return (
                      <MenuRow
                        key={item.id}
                        role="menuitem"
                        onClick={() => run(item)}
                        danger={item.danger}
                        disabled={item.disabled}
                        active={isActive}
                        className={blinkingId === item.id ? 'ui-menu-blink' : undefined}
                        onMouseEnter={(e) => {
                          if (searchable && myFlatIdx >= 0) setActiveIdx(myFlatIdx);
                          if (item.sublabel) showDetailFor(item.id, e.currentTarget);
                          else hideDetail();
                        }}
                      >
                        {!trailing && item.glyph && (
                          <span className="michi-menu-glyph" aria-hidden="true">
                            {item.glyph}
                          </span>
                        )}
                        <span className="michi-menu-label">
                          <span>{item.label}</span>
                          {item.sublabel && (
                            <span className="michi-menu-caption michi-menu-sublabel">
                              {item.sublabel}
                            </span>
                          )}
                        </span>
                        {item.keys && (
                          <span className="michi-menu-keys">
                            {item.keys}
                          </span>
                        )}
                        {trailing && item.glyph && (
                          <span className="michi-menu-glyph" aria-hidden="true">
                            {item.glyph}
                          </span>
                        )}
                      </MenuRow>
                    );
                  })}
                </React.Fragment>
              );
            });
        })()}
      </ul>
      {filtered.some((s) => s.pinned) && (
        <ul className="michi-menu-list michi-menu-pinned">
          {filtered
            .filter((s) => s.pinned)
            .map((section, si) => {
              const trailing = section.trailingGlyph !== false;
              return (
                <React.Fragment key={`pinned-${si}`}>
                  {section.label && (
                    <li
                      aria-hidden="true"
                      className="michi-menu-section"
                    >
                      {section.label}
                    </li>
                  )}
                  {section.items.map((item) => (
                    <MenuRow
                      key={item.id}
                      role="menuitem"
                      onClick={() => run(item)}
                      danger={item.danger}
                      disabled={item.disabled}
                      className={blinkingId === item.id ? 'ui-menu-blink' : undefined}
                    >
                      {!trailing && item.glyph && (
                        <span className="michi-menu-glyph" aria-hidden="true">
                          {item.glyph}
                        </span>
                      )}
                      <span className="michi-menu-label">
                        <span>{item.label}</span>
                        {item.sublabel && (
                          <span className="michi-menu-caption michi-menu-sublabel">
                            {item.sublabel}
                          </span>
                        )}
                      </span>
                      {item.keys && (
                        <span className="michi-menu-keys">
                          {item.keys}
                        </span>
                      )}
                      {trailing && item.glyph && (
                        <span className="michi-menu-glyph" aria-hidden="true">
                          {item.glyph}
                        </span>
                      )}
                    </MenuRow>
                  ))}
                </React.Fragment>
              );
            })}
        </ul>
      )}
    </PopoverSurface>
    {detail && detailItem?.sublabel && (
      <MenuDetailCard
        menuRef={ref}
        rowTop={detail.rowTop}
        title={detailItem.label}
        text={detailItem.sublabel}
      />
    )}
    </>
  );
}
