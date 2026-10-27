import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PopoverSurface } from '../../../ui/Popover';
import { ChatIcon, FileIcon } from '../../icons';
import './michiPage.css';

const WIDTH = 340;
const GAP = 6;
const PAD = 8;

export interface SourceRow {
  key: string;
  kind: 'conversation' | 'background' | 'file';
  label: string;
  /** Right-hand detail: the conversation's age. */
  detail?: string;
  threadId?: string;
  path?: string;
  /** Native Pages keep the exact node/turn/message tuple in this callback. */
  onOpen?: () => void;
}

/**
 * Where a block's conclusion came from, hung from its Sources button.
 * Conversations Michi knows open in the thread peek.
 */
export function SourcesPopover({
  anchor,
  label,
  count,
  rows,
  onOpenThread,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  /** How many sources the block cites (a conversation and its file are one). */
  count: number;
  rows: readonly SourceRow[];
  onOpenThread: (threadId: string) => void;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = surfaceRef.current?.getBoundingClientRect();
    const width = box?.width || WIDTH;
    const height = box?.height || 0;
    const left = Math.max(PAD, Math.min(window.innerWidth - width - PAD, rect.right - width));
    let top = rect.bottom + GAP;
    if (top + height > window.innerHeight - PAD && rect.top - GAP - height >= PAD) top = rect.top - GAP - height;
    setPosition({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      anchor.focus({ preventScroll: true });
      onCloseRef.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surfaceRef.current?.contains(target) || anchor.contains(target))) return;
      onCloseRef.current();
    };
    const dismiss = () => onCloseRef.current();
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

  return (
    <PopoverSurface
      ref={surfaceRef}
      role="dialog"
      aria-label={`Sources for ${label}`}
      width={WIDTH}
      maxWidth={`calc(100vw - ${PAD * 2}px)`}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      animate={false}
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <div className="michi-doc-sources">
        <div className="michi-doc-caption">Sources · <span className="michi-doc-mono">{count}</span></div>
        <ul className="michi-doc-sources__list">
          {rows.map((row) => {
            const glyph = row.kind === 'file' ? <FileIcon size={12} /> : <ChatIcon size={12} />;
            const body = (
              <>
                <span className="michi-doc-sources__glyph" aria-hidden="true">{glyph}</span>
                <span className={`michi-doc-sources__label${row.kind === 'file' ? ' michi-doc-mono' : ''}`} title={row.label}>{row.label}</span>
                {row.detail && <span className="michi-doc-sources__detail michi-doc-mono">{row.detail}</span>}
              </>
            );
            return (
              <li key={row.key}>
                {row.onOpen || row.threadId ? (
                  <button
                    type="button"
                    className="michi-doc-sources__row michi-doc-sources__row--link"
                    onClick={() => {
                      onCloseRef.current();
                      if (row.onOpen) row.onOpen();
                      else onOpenThread(row.threadId!);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <span className="michi-doc-sources__row">{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </PopoverSurface>
  );
}
