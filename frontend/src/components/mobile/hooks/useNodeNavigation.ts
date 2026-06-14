import { useCallback, useRef } from 'react';

const MAX_TRACKED = 64;

/**
 * Records the scroll position of each visited node so navigating back restores
 * the same offset rather than snapping to the top. Caller wires up:
 *   - rememberScroll(currentNodeId, scrollTop) on scroll/before-leave
 *   - getScroll(nextNodeId) when entering a node, then setScrollTop on the el
 *
 * Bounded to MAX_TRACKED nodes via insertion-order eviction — stops the Map
 * from growing without bound across long sessions of branch-hopping.
 */
export function useNodeNavigation() {
  const positions = useRef<Map<string, number>>(new Map());

  const rememberScroll = useCallback((nodeId: string, scrollTop: number) => {
    const m = positions.current;
    if (m.has(nodeId)) m.delete(nodeId);
    m.set(nodeId, scrollTop);
    while (m.size > MAX_TRACKED) {
      const oldest = m.keys().next().value as string | undefined;
      if (!oldest) break;
      m.delete(oldest);
    }
  }, []);

  const getScroll = useCallback((nodeId: string): number | undefined => {
    return positions.current.get(nodeId);
  }, []);

  const forget = useCallback((nodeId: string) => {
    positions.current.delete(nodeId);
  }, []);

  return { rememberScroll, getScroll, forget };
}
