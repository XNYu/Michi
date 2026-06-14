import type { ChatMessage, ChatNodeState, ProjectEdge } from './chatTypes';

// Task 2 will widen ProjectEdge itself; this private alias keeps tsc green until then.
type EdgeWithAnchor = ProjectEdge & { anchorMessageId?: string; createdAt?: number };

export interface ChildAnchor {
  childNodeId: string;
  title: string;
  /** Child transcript message count, captured by the structural anchor selector. */
  messageCount?: number;
  /** From edge.createdAt — set at fork time, NOT from child's first message. */
  createdAt: number;
  status: ChatNodeState['status'];
  quotedText?: string;
}

function childTitle(n: ChatNodeState): string {
  return (
    n.title ||
    n.messages.find((m) => m.role === 'user')?.text.slice(0, 40) ||
    'Untitled'
  );
}

export function buildAnchorMap(
  parentNodeId: string,
  edges: readonly EdgeWithAnchor[],
  nodes: Record<string, ChatNodeState | undefined>,
): Map<string, ChildAnchor[]> {
  const parent = nodes[parentNodeId];
  if (!parent) return new Map();
  const liveMsgIds = new Set(parent.messages.map((m) => m.id));
  const out = new Map<string, ChildAnchor[]>();
  for (const e of edges) {
    if (e.source !== parentNodeId) continue;
    if (e.kind !== undefined && e.kind !== 'branch') continue;
    if (!e.anchorMessageId || !liveMsgIds.has(e.anchorMessageId)) continue;
    const child = nodes[e.target];
    if (!child || child.deletedAt) continue;
    const arr = out.get(e.anchorMessageId) ?? [];
    arr.push({
      childNodeId: child.nodeId,
      title: childTitle(child),
      messageCount: child.messages.length,
      createdAt: e.createdAt ?? 0,
      status: child.status,
      quotedText: child.messages[0]?.quotedText,
    });
    out.set(e.anchorMessageId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export function findQuoteRange(
  haystack: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote) return null;
  const i = haystack.indexOf(quote);
  if (i < 0) return null;
  return { start: i, end: i + quote.length };
}

export function cleanupOrphanedAnchors(
  edges: readonly EdgeWithAnchor[],
  parentNodeId: string,
  liveMsgIds: ReadonlySet<string>,
): EdgeWithAnchor[] {
  let changed = false;
  const next = edges.map((e) => {
    if (e.source !== parentNodeId) return e;
    if (e.kind !== undefined && e.kind !== 'branch') return e;
    if (!e.anchorMessageId) return e;
    if (liveMsgIds.has(e.anchorMessageId)) return e;
    changed = true;
    const { anchorMessageId: _drop, ...rest } = e;
    return rest;
  });
  return changed ? next : (edges as EdgeWithAnchor[]);
}

/**
 * Mirrors trim logic at chatReducers.ts:416-440 so callers can compute
 * post-trim surviving message ids BEFORE dispatching `retry-trim`.
 */
export function computeSurvivingMessageIds(
  messages: readonly ChatMessage[],
  fromIndex: number | undefined,
): Set<string> {
  let kept: readonly ChatMessage[];
  if (fromIndex != null) {
    kept = messages.slice(0, fromIndex);
  } else {
    const len = messages.length;
    if (len >= 2 && messages[len - 1].role === 'assistant' && messages[len - 2].role === 'user') {
      kept = messages.slice(0, len - 2);
    } else if (len >= 1 && messages[len - 1].role === 'assistant') {
      kept = messages.slice(0, len - 1);
    } else {
      kept = messages;
    }
  }
  return new Set(kept.map((m) => m.id));
}
