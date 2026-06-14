import { useCallback, useMemo, useRef } from 'react';

interface Options {
  enabled?: boolean;
  durationMs?: number;
  onLongPress: () => void;
}

/**
 * Generic long-press hook. We use 450ms per the spec. Triggers `onLongPress`
 * when the user holds without dragging more than ~10px. Spreads onTouchStart /
 * onMouseDown / onTouchEnd / onMouseUp / onTouchMove handlers via `handlers`.
 */
export function useLongPress<E extends HTMLElement>({
  enabled = true,
  durationMs = 450,
  onLongPress,
}: Options) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const start = useCallback(
    (x: number, y: number) => {
      if (!enabled) return;
      startPos.current = { x, y };
      fired.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, durationMs);
    },
    [enabled, durationMs, onLongPress],
  );

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
  }, []);

  const move = useCallback((x: number, y: number) => {
    if (!startPos.current) return;
    const dx = x - startPos.current.x;
    const dy = y - startPos.current.y;
    if (dx * dx + dy * dy > 100) cancel();
  }, [cancel]);

  // Stabilise the handler bag so spreading it onto a child doesn't force
  // listener re-binding on every parent render — matters under streaming
  // because chunk dispatches re-render every visible message.
  const handlers = useMemo(
    () => ({
      onTouchStart: (e: React.TouchEvent<E>) => {
        const t = e.touches[0];
        start(t.clientX, t.clientY);
      },
      onTouchMove: (e: React.TouchEvent<E>) => {
        const t = e.touches[0];
        move(t.clientX, t.clientY);
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
      onMouseDown: (e: React.MouseEvent<E>) => start(e.clientX, e.clientY),
      onMouseMove: (e: React.MouseEvent<E>) => move(e.clientX, e.clientY),
      onMouseUp: cancel,
      onMouseLeave: cancel,
    }),
    [start, move, cancel],
  );

  return { handlers, didFire: fired };
}
