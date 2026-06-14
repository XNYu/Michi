import React, { useCallback, useRef, useState } from 'react';

interface ResizeHandleProps {
  /** Current pane element ref — used to read its width at drag start. */
  paneRef: React.RefObject<HTMLElement>;
  /** Called on every pointer move during drag with the current width. */
  onResize: (width: number) => void;
  /** Called on double-click to reset width. */
  onReset: () => void;
  /** Called when drag begins. */
  onResizeStart?: () => void;
  /** Called when drag ends. */
  onResizeEnd?: () => void;
  /** Min width in px. */
  min?: number;
}

const MIN_DEFAULT = 280;

/**
 * Vertical resize handle rendered at the right edge of a pane.
 * Drag to resize (live updates on every pointer move); double-click to reset.
 */
export default function ResizeHandle({
  paneRef,
  onResize,
  onReset,
  onResizeStart,
  onResizeEnd,
  min = MIN_DEFAULT,
}: ResizeHandleProps) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = paneRef.current;
      if (!el) return;
      dragging.current = true;
      setActive(true);
      onResizeStart?.();
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      let pendingW: number | null = null;
      let rafId: number | null = null;
      const flush = () => {
        rafId = null;
        if (pendingW != null) {
          onResize(pendingW);
          pendingW = null;
        }
      };
      const onMove = (ev: PointerEvent) => {
        pendingW = Math.round(Math.max(min, startW + ev.clientX - startX));
        if (rafId == null) rafId = requestAnimationFrame(flush);
      };
      const onUp = () => {
        dragging.current = false;
        setActive(false);
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (pendingW != null) {
          onResize(pendingW);
          pendingW = null;
        }
        onResizeEnd?.();
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    },
    [paneRef, onResize, min, onResizeStart, onResizeEnd],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReset();
      }}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => {
        if (!dragging.current) setActive(false);
      }}
      title="Drag to resize · Double-click to reset"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 8,
        height: '100%',
        cursor: 'col-resize',
        zIndex: 10,
        background: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 3,
          height: 36,
          borderRadius: 2,
          background: 'var(--term-fg-muted, rgba(120,120,120,0.55))',
          opacity: active ? 1 : 0,
          transition: 'opacity 150ms',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
