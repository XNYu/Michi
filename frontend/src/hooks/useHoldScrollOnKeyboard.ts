import { useEffect, useRef, type RefObject } from 'react';

/** Within this distance of its end a scroller counts as at the bottom. */
const AT_BOTTOM_PX = 24;

/**
 * Keeps a scroller's content still on screen while the on-screen keyboard
 * comes up or goes down, unless the scroller is at its bottom. Mobile Safari
 * does not resize the layout for the keyboard; it pans the page so the
 * focused field clears it, which carries the content up with it. A scroller
 * read somewhere above its end scrolls back by the pan instead; at the bottom
 * the pan is wanted, since it lifts the last lines above the keyboard. When
 * the pan reverses, only what was scrolled back is given back.
 * `onAdjust` runs before each such scroll, so the caller can mark it as its own.
 */
export function useHoldScrollOnKeyboard(
  scrollRef: RefObject<HTMLElement | null>,
  active: boolean,
  onAdjust?: () => void,
): void {
  const onAdjustRef = useRef(onAdjust);
  onAdjustRef.current = onAdjust;
  useEffect(() => {
    const el = scrollRef.current;
    if (!active || !el || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const screenTop = () => el.getBoundingClientRect().top - (viewport?.offsetTop ?? 0);
    let baseline = screenTop();
    // Scrolled back so far and not yet given back (<= 0).
    let held = 0;
    const scrollBy = (delta: number) => {
      const before = el.scrollTop;
      onAdjustRef.current?.();
      el.scrollTop = before + delta;
      return el.scrollTop - before;
    };
    const onShift = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Node && target !== document && el.contains(target)) return;
      const now = screenTop();
      const moved = Math.round(now - baseline);
      if (moved === 0) return;
      if (moved < 0) {
        const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - AT_BOTTOM_PX;
        if (!atBottom) held += scrollBy(moved);
      } else if (held < 0) {
        held += scrollBy(Math.min(moved, -held));
      }
      baseline = screenTop();
    };
    // Layout above the scroller (a banner, the top bar) moves it too; that is not a pan.
    const resync = () => { baseline = screenTop(); };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resync) : null;
    ro?.observe(el);
    viewport?.addEventListener('resize', onShift);
    viewport?.addEventListener('scroll', onShift);
    window.addEventListener('scroll', onShift, true);
    document.addEventListener('focusin', resync);
    return () => {
      ro?.disconnect();
      viewport?.removeEventListener('resize', onShift);
      viewport?.removeEventListener('scroll', onShift);
      window.removeEventListener('scroll', onShift, true);
      document.removeEventListener('focusin', resync);
    };
  }, [scrollRef, active]);
}
