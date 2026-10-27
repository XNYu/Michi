import React from 'react';

/** Keep a fixed, portaled surface attached while its viewport or measured size changes. */
export function useAnchoredPosition({ anchor, surfaceRef, measure, dependencies = [] }: {
  anchor: HTMLElement | null;
  surfaceRef: React.RefObject<HTMLElement | null>;
  measure: () => void;
  dependencies?: React.DependencyList;
}) {
  const measureRef = React.useRef(measure);
  measureRef.current = measure;
  React.useLayoutEffect(() => {
    const update = () => measureRef.current();
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (anchor) observer?.observe(anchor);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
    // Consumer dependencies describe the geometry; callbacks stay fresh by ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, surfaceRef, ...dependencies]);
}
