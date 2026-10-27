import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { PopoverSurface } from '../../../ui/Popover';
import { BranchIcon } from '../../icons';
import { BorderBtn } from '../../primitives';
import './michiPage.css';

const WIDTH = 360;
const GAP = 6;
const PAD = 8;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const BLOCK_SUGGESTIONS = ['Why is this late?', 'Re-plan by week', 'Explain this block'] as const;
export const PAGE_SUGGESTIONS = ["These aren't one project", 'A conversation is missing', 'Add background'] as const;

/**
 * Ask about one part of the workspace document. The question opens as a new
 * Michi thread with the part quoted, so it is a branch off the page rather
 * than a chat inside it. Keys stay inside: Escape closes this, not the page.
 */
export function AskPopover({
  anchor,
  label,
  suggestions,
  placeholder = 'Ask about this block…',
  onSubmit,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  suggestions: readonly string[];
  placeholder?: string;
  onSubmit: (question: string) => void;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [value, setValue] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Right-aligned under the anchor; above it when the viewport runs out.
  const place = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const box = surfaceRef.current?.getBoundingClientRect();
    const width = box?.width || WIDTH;
    const height = box?.height || 0;
    const left = Math.max(PAD, Math.min(window.innerWidth - width - PAD, rect.right - width));
    let top = rect.bottom + GAP;
    if (top + height > window.innerHeight - PAD && rect.top - GAP - height >= PAD) top = rect.top - GAP - height;
    setPosition((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    inputRef.current?.focus({ preventScroll: true });
  }, [place]);

  // Every way out hands focus back to the button that opened this.
  const close = useCallback(() => {
    anchor.focus({ preventScroll: true });
    onCloseRef.current();
  }, [anchor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Tab') {
        // Tab cycles inside the popover.
        const surface = surfaceRef.current;
        if (!surface) return;
        const items = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!surface.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surfaceRef.current?.contains(target) || anchor.contains(target))) return;
      close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, close, place]);

  const submit = (text: string) => {
    const question = text.trim();
    if (!question) return;
    anchor.focus({ preventScroll: true });
    onSubmit(question);
  };

  return (
    <PopoverSurface
      ref={surfaceRef}
      role="dialog"
      aria-label={`Ask about ${label}`}
      width={WIDTH}
      maxWidth={`calc(100vw - ${PAD * 2}px)`}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      animate={false}
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <div className="michi-ask">
        <div className="michi-ask__about">
          <span className="michi-ask__about-glyph" aria-hidden="true"><BranchIcon size={12} /></span>
          About
          <span className="michi-ask__chip" title={label}>{label}</span>
        </div>
        <div className="michi-ask__suggestions">
          {suggestions.map((s) => (
            <BorderBtn key={s} className="michi-ask__suggestion" onClick={() => submit(s)}>{s}</BorderBtn>
          ))}
        </div>
        <form
          className="michi-ask__field"
          onSubmit={(event) => {
            event.preventDefault();
            submit(value);
          }}
        >
          <span className="michi-ask__prompt" aria-hidden="true">›_</span>
          <input
            ref={inputRef}
            className="michi-ask__input"
            aria-label={`Question about ${label}`}
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="submit" className="michi-ask__send" aria-label="Send" disabled={!value.trim()}>
            <ArrowUp size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </form>
      </div>
    </PopoverSurface>
  );
}
