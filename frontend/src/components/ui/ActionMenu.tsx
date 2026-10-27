import React from 'react';
import { PopoverSurface } from './Popover';

export interface ActionMenuEntry {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
}

/** A focused button menu for row actions. Context menus keep their active-descendant model. */
export function ActionMenu({ anchor, onClose, label, items, width = 208 }: {
  anchor: HTMLButtonElement;
  onClose: () => void;
  label: string;
  items: readonly ActionMenuEntry[];
  width?: number;
}) {
  const surface = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = surface.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(innerWidth - box.width - 8, rect.right - box.width)),
      top: Math.max(8, Math.min(innerHeight - box.height - 8, rect.bottom + 5)),
    });
    surface.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor]);
  React.useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = (event: PointerEvent) => {
      if (!surface.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); anchor.focus({ preventScroll: true }); }
        dismiss();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keydown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor]);
  return (
    <PopoverSurface ref={surface} menuKind="context" animate={false} role="menu" aria-label={label}
      width={width} left={position.left} top={position.top} className="trash-menu">
      {items.map((item) => <React.Fragment key={item.id}>
        {item.dividerBefore && <div className="michi-menu-divider" role="separator" />}
        <button type="button" role="menuitem" className="ui-menu-item" disabled={item.disabled}
          data-danger={item.danger ? 'true' : undefined} onClick={() => {
            anchor.focus({ preventScroll: true });
            onClose();
            item.onSelect();
          }}>
          {item.icon}{item.label}
        </button>
      </React.Fragment>)}
    </PopoverSurface>
  );
}
