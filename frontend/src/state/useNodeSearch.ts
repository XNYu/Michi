import { useBackendScope } from '../hooks/useBackendScope';
import { useEffect, useRef, useState } from 'react';
import { searchNodesGrouped, type NodeGroupedResult, type NodeGroupedSnippet } from '../services/api';

export interface NodeSearchState {
  nodes: NodeGroupedResult[];
  totalNodes: number;
  loading: boolean;
}

const EMPTY: NodeSearchState = { nodes: [], totalNodes: 0, loading: false };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function readSnippet(raw: unknown): NodeGroupedSnippet | null {
  if (!isObject(raw) || typeof raw.snippet !== 'string') return null;
  return { messageId: text(raw.messageId), role: raw.role === 'user' ? 'user' : 'assistant', snippet: raw.snippet };
}

function readHit(raw: unknown): NodeGroupedResult | null {
  if (!isObject(raw) || typeof raw.nodeId !== 'string' || !raw.nodeId || typeof raw.workspaceId !== 'string') return null;
  return {
    nodeId: raw.nodeId,
    nodeTitle: typeof raw.nodeTitle === 'string' ? raw.nodeTitle : null,
    workspaceId: raw.workspaceId,
    workspaceName: text(raw.workspaceName),
    treeId: typeof raw.treeId === 'string' ? raw.treeId : null,
    lastMessageAt: count(raw.lastMessageAt),
    totalMatches: count(raw.totalMatches),
    breadcrumb: Array.isArray(raw.breadcrumb) ? raw.breadcrumb.filter((s): s is string => typeof s === 'string') : [],
    snippets: Array.isArray(raw.snippets) ? raw.snippets.flatMap((s) => readSnippet(s) ?? []) : [],
  };
}

/**
 * The search answer as the palette draws it. The backend may answer with
 * something else (an error body, an older shape): anything without a
 * `results` list is no results, and a hit missing what the palette needs is
 * dropped, so a bad answer never takes the palette down.
 */
export function readNodeSearchAnswer(raw: unknown): { results: NodeGroupedResult[]; totalNodes: number } {
  if (!isObject(raw) || !Array.isArray(raw.results)) return { results: [], totalNodes: 0 };
  const results = raw.results.flatMap((r) => readHit(r) ?? []);
  const total = typeof raw.totalNodes === 'number' && Number.isFinite(raw.totalNodes) ? raw.totalNodes : results.length;
  return { results, totalNodes: Math.max(total, results.length) };
}

/**
 * Server-side node-grouped FTS search for the command palette.
 *
 * Returns deduplicated nodes, time-sorted (most recent activity first),
 * each with a root-first breadcrumb trail and up to 3 best-matching
 * snippets with `<mark>` tags for highlight rendering.
 */
export function useNodeSearch(debouncedQuery: string, connectionId?: string): NodeSearchState {
  const scope = useBackendScope(connectionId);
  const key = JSON.stringify([scope.key, debouncedQuery.trim()]);
  const [snapshot, setSnapshot] = useState<{ key: string; value: NodeSearchState }>({ key, value: EMPTY });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const setState = (value: NodeSearchState) => setSnapshot({ key, value });
    const q = debouncedQuery.trim();
    if (!q) {
      setState(EMPTY);
      return;
    }
    const reqId = ++reqIdRef.current;
    const controller = new AbortController();
    let cancelled = false;

    setState({ ...EMPTY, loading: true });

    (async () => {
      try {
        const { results, totalNodes } = readNodeSearchAnswer(await searchNodesGrouped(q, undefined, 30, { connectionId: scope.connectionId, signal: controller.signal }));
        if (cancelled || reqId !== reqIdRef.current) return;
        setState({ nodes: results, totalNodes, loading: false });
      } catch {
        if (cancelled || reqId !== reqIdRef.current) return;
        setState(EMPTY);
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [debouncedQuery, key, scope.key, scope.connectionId]);

  return snapshot.key === key ? snapshot.value : { ...EMPTY, loading: !!debouncedQuery.trim() };
}
