import React, { useEffect, useRef, useState } from 'react';
import { PopoverSurface } from '../../../ui/Popover';
import { useAnchoredPosition } from '../../../ui/useAnchoredPosition';

const GAP = 4;
const PAD = 8;

interface Entry { surface: () => HTMLElement | null }
/** Open popovers, innermost last: Esc and outside clicks belong to the innermost. */
const stack: Entry[] = [];

export type DbAnchor = HTMLElement | { x: number; y: number };

function anchorRect(anchor: DbAnchor): { left: number; right: number; top: number; bottom: number } {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
}

/**
 * A floating panel for the database UI (menus, filter/sort/group panels,
 * pickers): hangs under its anchor (above when the viewport runs out),
 * focuses its first control, and closes on Esc or a press outside. Nested
 * panels close innermost first. Keys inside never reach the page's own
 * shortcuts (Esc leaving the page, ↑/↓ moving the peek).
 */
export function DbPopover({
  anchor,
  onClose,
  align = 'start',
  width,
  role = 'dialog',
  label,
  className,
  restoreFocus = true,
  children,
}: {
  anchor: DbAnchor;
  /** `escape`: Esc (give up); `outside`: a press elsewhere (keep what was picked). */
  onClose: (reason: 'escape' | 'outside') => void;
  align?: 'start' | 'end';
  width?: number;
  role?: 'dialog' | 'menu';
  label: string;
  className?: string;
  restoreFocus?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useAnchoredPosition({ anchor: anchor instanceof HTMLElement ? anchor : null, surfaceRef: ref, dependencies: [anchor, align, width], measure: () => {
    const rect = anchorRect(anchor);
    const box = ref.current?.getBoundingClientRect();
    const w = box?.width || width || 240;
    const h = box?.height || 0;
    const wantLeft = align === 'end' ? rect.right - w : rect.left;
    const left = Math.max(PAD, Math.min(window.innerWidth - w - PAD, wantLeft));
    let top = rect.bottom + GAP;
    if (top + h > window.innerHeight - PAD && rect.top - GAP - h >= PAD) top = rect.top - GAP - h;
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  } });

  useEffect(() => {
    const entry: Entry = { surface: () => ref.current };
    stack.push(entry);
    const top = () => stack[stack.length - 1] === entry;
    const focusable = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button, [tabindex="0"], [role="menuitem"], [role="menuitemradio"]');
    (focusable ?? ref.current)?.focus({ preventScroll: true });
    const returnTo = anchor instanceof HTMLElement ? anchor : null;

    const onKey = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current('escape');
        if (restoreFocus) returnTo?.focus({ preventScroll: true });
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!top()) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (returnTo?.contains(target)) return;
      onCloseRef.current('outside');
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
    // Opened once per mount: the anchor of an open panel does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PopoverSurface
      ref={ref}
      menuKind="context"
      animate={false}
      role={role}
      aria-label={label}
      width={width}
      left={pos?.left ?? 0}
      top={pos?.top ?? 0}
      zIndex="var(--z-context-menu)"
      className={`michi-db-pop${className ? ` ${className}` : ''}`}
      style={pos ? undefined : { visibility: 'hidden' }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="michi-db-pop__body"
        tabIndex={-1}
        // Keys typed here are the panel's: the page's shortcuts never see them.
        onKeyDown={(event) => {
          if (event.key !== 'Escape') event.stopPropagation();
        }}
      >
        {children}
      </div>
    </PopoverSurface>
  );
}

/** One row of a database menu: icon, label, optional right-hand hint. With `checked` it is one choice of several (a radio item). */
export function DbMenuItem({
  icon,
  label,
  hint,
  danger,
  disabled,
  checked,
  onSelect,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: (item: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      className="michi-db-mi"
      data-danger={danger ? 'true' : undefined}
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.closest('.michi-db-pop__body')?.querySelectorAll<HTMLButtonElement>('.michi-db-mi:not(:disabled)') ?? []);
        const at = items.indexOf(event.currentTarget);
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      <span className="michi-db-mi__icon" aria-hidden="true">{icon}</span>
      <span className="michi-db-mi__label">{label}</span>
      {hint !== undefined && <span className="michi-db-mi__hint">{hint}</span>}
    </button>
  );
}

/** A toggle switch row, as the group panel's options. */
export function DbSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="michi-db-switch" onClick={() => onChange(!checked)}>
      <span className="michi-db-switch__label">{label}</span>
      <span className="michi-db-switch__track" aria-hidden="true" />
    </button>
  );
}
