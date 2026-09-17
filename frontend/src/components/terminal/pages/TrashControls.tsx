import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Eye, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import { PopoverSurface } from '../../ui/Popover';

let tooltipWarmUntil = 0;

export function TrashIconButton({ icon: Icon, tooltip, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; tooltip: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (open) tooltipWarmUntil = Date.now() + 600;
    setOpen(false);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', onKey);
    };
  }, [hide, open]);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !surface.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const box = surface.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2)),
      top: rect.bottom + box.height + 12 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - box.height - 6),
    });
  }, [open]);
  return <>
    <button {...props} type="button" ref={anchor} className={`trash-icon-button ${props.className ?? ''}`} aria-describedby={open ? id : undefined}
      onPointerEnter={event => {
        if (event.pointerType === 'touch' || props.disabled) return;
        clearTimeout(timer.current);
        const top = anchor.current?.getBoundingClientRect().top;
        timer.current = setTimeout(() => {
          if (anchor.current?.getBoundingClientRect().top === top) setOpen(true);
        }, Date.now() < tooltipWarmUntil ? 0 : 450);
      }}
      onPointerLeave={hide}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true); }}
      onBlur={hide}
      onPointerDown={hide}
      onClick={event => { hide(); props.onClick?.(event); }}>
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
    {open && !props.disabled && <PopoverSurface ref={surface} variant="tooltip" role="tooltip" left={position.left} top={position.top} style={{ padding: '6px 9px', pointerEvents: 'none' }}>
      <span id={id}>{tooltip}</span>
    </PopoverSurface>}
  </>;
}

export function TrashMenu({ anchor, onClose, onPreview, onRestore, onDelete }: {
  anchor: HTMLButtonElement;
  onClose: () => void;
  onPreview: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = surface.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(innerWidth - box.width - 8, rect.right - box.width)), top: Math.max(8, Math.min(innerHeight - box.height - 8, rect.bottom + 5)) });
    surface.current?.querySelector('button')?.focus();
  }, [anchor]);
  useEffect(() => {
    const dismiss = () => closeRef.current();
    const outside = (event: PointerEvent) => { if (!surface.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) dismiss(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); anchor.focus({ preventScroll: true }); }
        dismiss();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(surface.current?.querySelectorAll('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
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
  const run = (action: () => void) => {
    anchor.focus({ preventScroll: true });
    onClose();
    action();
  };
  return <PopoverSurface ref={surface} menuKind="context" animate={false} role="menu" aria-label="Trash actions" width={208} left={position.left} top={position.top} className="trash-menu">
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => run(onPreview)}><Eye size={14} aria-hidden="true" />Preview</button>
    <button type="button" role="menuitem" className="ui-menu-item" onClick={() => run(onRestore)}><Undo2 size={14} aria-hidden="true" />Restore</button>
    <div className="michi-menu-divider" role="separator" />
    <button type="button" role="menuitem" className="ui-menu-item" data-danger="true" onClick={() => run(onDelete)}><Trash2 size={14} aria-hidden="true" />Delete permanently...</button>
  </PopoverSurface>;
}

export function TrashHighlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLocaleLowerCase();
  let start = 0, hit: number;
  while ((hit = lower.indexOf(needle, start)) !== -1) {
    parts.push(text.slice(start, hit), <mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    start = hit + needle.length;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}
