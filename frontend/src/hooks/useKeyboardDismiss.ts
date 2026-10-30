import { useEffect, useRef } from 'react';
import { keyboardInsetOf } from './useKeyboardInset';

/** Above this inset the on-screen keyboard is up. */
const KEYBOARD_UP_PX = 120;
/** Below this inset it has gone down again (the gap avoids flicker mid-animation). */
const KEYBOARD_DOWN_PX = 60;

/**
 * Calls onDismiss when the on-screen keyboard goes down after it came up for
 * one of the caller's fields: Done, a swipe, Android's back key or a tap
 * elsewhere all end the same way. `owns` says whether that field has focus
 * now; a keyboard raised for another input does not count.
 */
export function useKeyboardDismiss(active: boolean, owns: () => boolean, onDismiss: () => void): void {
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) return;
    let up = false;
    let width = window.innerWidth;
    const measure = () => {
      // Rotation and pinch zoom resize the visual viewport too; neither is the keyboard.
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        up = false;
        return;
      }
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      const inset = keyboardInsetOf(viewport);
      if (inset >= KEYBOARD_UP_PX) {
        if (!up && ownsRef.current()) up = true;
      } else if (up && inset <= KEYBOARD_DOWN_PX) {
        up = false;
        onDismissRef.current();
      }
    };
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [active]);
}
