import { useEffect, useState } from 'react';

/** The bottom of the layout viewport that the visual viewport leaves uncovered. */
export function keyboardInsetOf(viewport: VisualViewport): number {
  return Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * How much of the layout viewport's bottom an on-screen keyboard covers, in
 * CSS px. Mobile Safari does not resize the layout viewport for the keyboard,
 * so a bottom-fixed element needs this offset to stay above it. 0 when inactive
 * or when visualViewport is unavailable.
 */
export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!active || !viewport) {
      setInset(0);
      return;
    }
    const measure = () => setInset(keyboardInsetOf(viewport));
    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
    };
  }, [active]);
  return inset;
}
