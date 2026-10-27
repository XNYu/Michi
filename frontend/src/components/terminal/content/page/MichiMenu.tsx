import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MenuItem, PopoverSurface } from '../../../ui/Popover';
import './michiPage.css';

const GAP = 4;
const PAD = 8;

export interface MichiMenuItem {
  id: string;
  label: string;
  glyph?: React.ReactNode;
  /** Shortcut hint on the right, e.g. `/` or `⌫`. */
  keys?: string;
  /** A second, muted line. */
  sub?: string;
  /** Muted count after the label (Sources 3). */
  count?: number;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

export type MichiMenuEntry = MichiMenuItem | { divider: true; id: string } | { caption: string; id: string };

const isItem = (e: MichiMenuEntry): e is MichiMenuItem => 'onSelect' in e;

const plainKey = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey;

/**
 * A small menu hung from a button (the block menu, Add block, This isn't
 * right). Focus moves into the list; arrows move, Enter or Space picks, Esc
 * or Tab closes and hands focus back to the button. Keys are taken in the
 * capture phase so the page's own shortcuts never see them.
 */
export function MichiMenu({
  anchor,
  label,
  entries,
  onClose,
  align = 'start',
  width = 220,
}: {
  anchor: HTMLElement;
  label: string;
  entries: readonly MichiMenuEntry[];
  /** `restoreFocus`: put focus back on the anchor (not after an outside click). */
  onClose: (restoreFocus: boolean) => void;
  align?: 'start' | 'end';
  width?: number;
}) {
  const baseId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const items = useMemo(() => entries.filter(isItem), [entries]);
  const enabled = useMemo(() => items.filter((i) => !i.disabled), [items]);
  const [active, setActive] = useState(() => enabled[0]?.id ?? null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = surfaceRef.current?.getBoundingClientRect();
    const w = box?.width || width;
    const h = box?.height || 0;
    const wanted = align === 'end' ? rect.right - w : rect.left;
    const left = Math.max(PAD, Math.min(window.innerWidth - w - PAD, wanted));
    let top = rect.bottom + GAP;
    if (top + h > window.innerHeight - PAD && rect.top - GAP - h >= PAD) top = rect.top - GAP - h;
    setPosition({ left, top });
    listRef.current?.focus({ preventScroll: true });
  }, [align, anchor, width]);

  useEffect(() => {
    const pick = (item: MichiMenuItem | undefined) => {
      if (!item || item.disabled) return;
      onCloseRef.current(true);
      item.onSelect();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!plainKey(event) || event.isComposing) return;
      const list = enabledRef.current;
      const at = list.findIndex((i) => i.id === activeRef.current);
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (!list.length) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive(list[(at + step + list.length) % list.length].id);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        if (list.length) setActive(list[event.key === 'Home' ? 0 : list.length - 1].id);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        pick(list[at]);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surfaceRef.current?.contains(target) || anchor.contains(target))) return;
      onCloseRef.current(false);
    };
    const dismiss = () => onCloseRef.current(false);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor]);

  const itemDomId = (id: string) => `${baseId}-${id}`;

  return (
    <PopoverSurface
      ref={surfaceRef}
      menuKind="context"
      animate={false}
      width={width}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      className="michi-doc-menu"
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <ul
        ref={listRef}
        className="michi-menu-list"
        role="menu"
        tabIndex={-1}
        aria-label={label}
        aria-activedescendant={active ? itemDomId(active) : undefined}
      >
        {entries.map((entry) => {
          if ('divider' in entry) return <li key={entry.id} className="michi-menu-divider" role="separator" />;
          if ('caption' in entry) return <li key={entry.id} className="michi-menu-section michi-doc-menu__caption" role="presentation">{entry.caption}</li>;
          return (
            <MenuItem
              key={entry.id}
              id={itemDomId(entry.id)}
              role="menuitem"
              active={entry.id === active}
              danger={entry.danger}
              disabled={entry.disabled}
              title={entry.title}
              className={entry.sub ? 'michi-doc-menu__item--sub' : undefined}
              onMouseEnter={() => { if (!entry.disabled) setActive(entry.id); }}
              onClick={() => {
                onClose(true);
                entry.onSelect();
              }}
            >
              {entry.glyph && <span className="michi-menu-glyph" aria-hidden="true">{entry.glyph}</span>}
              <span className="michi-menu-label michi-doc-menu__label">
                <span className="michi-doc-menu__title">
                  {entry.label}
                  {entry.count != null && <span className="michi-doc-menu__count michi-doc-mono">{entry.count}</span>}
                </span>
                {entry.sub && <span className="michi-doc-menu__sub">{entry.sub}</span>}
              </span>
              {entry.keys && <span className="michi-menu-keys michi-doc-menu__keys" aria-hidden="true">{entry.keys}</span>}
            </MenuItem>
          );
        })}
      </ul>
    </PopoverSurface>
  );
}
