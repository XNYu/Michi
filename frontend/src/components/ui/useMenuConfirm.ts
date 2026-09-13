import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Matches --m-clickDelay and ui-menu-blink. Navigation never uses this delay.
export const MENU_CONFIRM_MS = 160;

export function useMenuConfirm() {
  const [blinkingId, setBlinkingId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setBlinkingId(null);
  }, []);
  useLayoutEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const confirm = useCallback((id: string, action: () => void) => {
    if (timer.current !== null) return;
    if (document.documentElement.dataset.reduceMotion === 'on' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    setBlinkingId(id);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setBlinkingId(null);
      action();
    }, MENU_CONFIRM_MS);
  }, []);
  return { blinkingId, confirm, cancel };
}
