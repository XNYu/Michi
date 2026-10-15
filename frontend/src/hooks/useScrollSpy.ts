import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Fraction of the scroll viewport, measured from its top edge, used as the
 * reading line. A section becomes current once its heading scrolls above
 * this line, so a heading entering the upper third wins over the tail of
 * the previous section.
 */
export const SCROLL_SPY_ACTIVATION_RATIO = 0.3;

/** Input that only the user produces; any of these ends a pin. */
const USER_SCROLL_INTENT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export interface ScrollSpyMetrics {
  /** Section tops relative to the scroller's visible top edge, in document order. */
  tops: readonly number[];
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Index of the section that owns the reading line, or -1 with no sections. */
export function pickActiveSection({ tops, scrollTop, scrollHeight, clientHeight }: ScrollSpyMetrics): number {
  if (tops.length === 0) return -1;
  // At the very top, including a document too short to scroll, the first
  // section is current.
  if (scrollTop <= 0) return 0;
  // Short trailing sections can never reach the reading line, so the end
  // of the scroll range belongs to the last section.
  if (scrollTop + clientHeight >= scrollHeight - 1) return tops.length - 1;
  const line = clientHeight * SCROLL_SPY_ACTIVATION_RATIO;
  let active = 0;
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index] > line) break;
    active = index;
  }
  return active;
}

export interface ScrollSpy {
  /** Current section id; the first id when nothing has been measured yet. */
  activeId: string | null;
  /**
   * Make `id` current and hold it while a programmatic scroll runs, so a
   * smooth scroll does not flicker through the sections it passes. The pin
   * ends when that scroll settles or the user scrolls.
   */
  pin: (id: string) => void;
}

/**
 * Track which section of `scroller` the reader is on. `getElement` maps an
 * id to its section element and must be referentially stable.
 */
export function useScrollSpy(
  scroller: HTMLElement | null,
  ids: readonly string[],
  getElement: (id: string) => HTMLElement | null,
): ScrollSpy {
  const [spiedId, setSpiedId] = useState<string | null>(null);
  const idsRef = useRef(ids);
  const getElementRef = useRef(getElement);
  const pinnedRef = useRef(false);

  const measure = useCallback(() => {
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const present: string[] = [];
    const tops: number[] = [];
    for (const id of idsRef.current) {
      const element = getElementRef.current(id);
      if (!element) continue;
      present.push(id);
      tops.push(element.getBoundingClientRect().top - scrollerTop);
    }
    const index = pickActiveSection({
      tops,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
    setSpiedId(index >= 0 ? present[index] : null);
  }, [scroller]);

  // Sections are committed with the ids, so measure before paint to avoid a
  // frame with a stale highlight.
  useLayoutEffect(() => {
    idsRef.current = ids;
    getElementRef.current = getElement;
    if (!pinnedRef.current) measure();
  }, [ids, getElement, measure]);

  useEffect(() => {
    if (!scroller) return undefined;
    let frame = 0;
    const schedule = () => {
      if (pinnedRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const release = () => {
      pinnedRef.current = false;
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('scrollend', release);
    for (const type of USER_SCROLL_INTENT_EVENTS) {
      scroller.addEventListener(type, release, { passive: true });
    }
    window.addEventListener('resize', schedule);
    return () => {
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('scrollend', release);
      for (const type of USER_SCROLL_INTENT_EVENTS) {
        scroller.removeEventListener(type, release);
      }
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, measure]);

  const pin = useCallback((id: string) => {
    pinnedRef.current = true;
    setSpiedId(id);
  }, []);

  const activeId = spiedId !== null && ids.includes(spiedId) ? spiedId : ids[0] ?? null;
  return { activeId, pin };
}

/**
 * Scroll `scroller` just enough to show `child` in full, leaving every
 * ancestor scroll position alone. Element.scrollIntoView would also scroll
 * the page, which on a stacked layout drags the reader back to the outline.
 */
export function revealInScroller(
  scroller: HTMLElement,
  child: HTMLElement,
  { padding = 0, behavior = 'auto' }: { padding?: number; behavior?: ScrollBehavior } = {},
): void {
  const viewport = scroller.clientHeight;
  if (scroller.scrollHeight <= viewport) return;
  const origin = scroller.getBoundingClientRect().top + scroller.clientTop;
  const rect = child.getBoundingClientRect();
  const top = rect.top - origin;
  const bottom = rect.bottom - origin;
  let delta = 0;
  if (top < padding) {
    delta = top - padding;
  } else if (bottom > viewport - padding) {
    // An item taller than the viewport aligns its top instead of its bottom.
    delta = Math.min(top - padding, bottom - (viewport - padding));
  }
  if (delta !== 0) scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
}
