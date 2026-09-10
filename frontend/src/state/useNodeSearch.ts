import { useEffect, useRef, useState } from 'react';
import { searchNodesGrouped, type NodeGroupedResult } from '../services/api';

export interface NodeSearchState {
  nodes: NodeGroupedResult[];
  totalNodes: number;
  loading: boolean;
}

const EMPTY: NodeSearchState = { nodes: [], totalNodes: 0, loading: false };

/**
 * Server-side node-grouped FTS search for the command palette.
 *
 * Returns deduplicated nodes, time-sorted (most recent activity first),
 * each with a root-first breadcrumb trail and up to 3 best-matching
 * snippets with `<mark>` tags for highlight rendering.
 */
export function useNodeSearch(debouncedQuery: string): NodeSearchState {
  const [state, setState] = useState<NodeSearchState>(EMPTY);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      setState(EMPTY);
      return;
    }
    const reqId = ++reqIdRef.current;
    let cancelled = false;

    setState((prev) => ({ ...prev, loading: true }));

    (async () => {
      try {
        const { results, totalNodes } = await searchNodesGrouped(q);
        if (cancelled || reqId !== reqIdRef.current) return;
        setState({ nodes: results, totalNodes, loading: false });
      } catch {
        if (cancelled || reqId !== reqIdRef.current) return;
        setState(EMPTY);
      }
    })();

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  return state;
}
