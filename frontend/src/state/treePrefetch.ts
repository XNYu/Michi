import { createContext, useCallback, useContext, useEffect, useRef, type PointerEvent } from 'react';

export const TREE_PREFETCH_INTENT_MS = 120;
export const TreePrefetchContext = createContext<(nodeId: string) => void>(() => {});

/** Ignore pointer flyovers; keyboard focus expresses intent immediately. */
export function useTreePrefetchIntent(nodeId: string | null) {
  const prefetch = useContext(TreePrefetchContext);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  useEffect(() => cancel, [cancel, nodeId]);
  const onFocus = useCallback(() => {
    cancel();
    if (nodeId) prefetch(nodeId);
  }, [cancel, nodeId, prefetch]);
  const onPointerEnter = useCallback((event: PointerEvent) => {
    cancel();
    if (event.pointerType !== 'touch' && nodeId) {
      timer.current = setTimeout(() => prefetch(nodeId), TREE_PREFETCH_INTENT_MS);
    }
  }, [cancel, nodeId, prefetch]);
  return { onPointerEnter, onPointerLeave: cancel, onFocus, onBlur: cancel };
}
