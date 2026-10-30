import { useEffect, useRef } from 'react';

/** How far from the left screen edge, in CSS px, a swipe may start. */
export const EDGE_SWIPE_ZONE = 24;
/** Rightward travel, in CSS px, that completes the swipe. */
export const EDGE_SWIPE_DISTANCE = 48;
/** Travel before the direction counts: vertical or leftward first is a scroll. */
const DIRECTION_SLOP = 10;

/** Content that takes every touch for itself (a map, a drag handle) keeps
 *  its gesture, and so do an open modal and a text selection being adjusted. */
function edgeSwipeAllowed(target: EventTarget | null): boolean {
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (getComputedStyle(el).touchAction === 'none') return false;
  }
  return true;
}

/**
 * Calls onSwipe when one finger starts at the left screen edge and moves
 * right. Touch events, not pointer events: the browser cancels a pointer as
 * soon as it starts scrolling something under the finger, and touch events
 * keep arriving. Listeners are passive, so scrolling is never held up, and a
 * mouse never produces a touch event.
 */
export function useEdgeSwipe(enabled: boolean, onSwipe: () => void): void {
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => { onSwipeRef.current = onSwipe; }, [onSwipe]);

  useEffect(() => {
    if (!enabled) return;
    let start: { id: number; x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      start = null;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX > EDGE_SWIPE_ZONE || !edgeSwipeAllowed(e.target)) return;
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      const touch = e.touches.length === 1 ? Array.from(e.touches).find(t => t.identifier === id) : undefined;
      if (!touch) { start = null; return; }
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dx < -DIRECTION_SLOP || (dy > DIRECTION_SLOP && dy >= dx)) { start = null; return; }
      if (dx >= EDGE_SWIPE_DISTANCE && dx > dy * 2) {
        start = null;
        onSwipeRef.current();
      }
    };
    const onEnd = () => { start = null; };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('touchstart', onStart, options);
    window.addEventListener('touchmove', onMove, options);
    window.addEventListener('touchend', onEnd, options);
    window.addEventListener('touchcancel', onEnd, options);
    return () => {
      window.removeEventListener('touchstart', onStart, options);
      window.removeEventListener('touchmove', onMove, options);
      window.removeEventListener('touchend', onEnd, options);
      window.removeEventListener('touchcancel', onEnd, options);
    };
  }, [enabled]);
}
