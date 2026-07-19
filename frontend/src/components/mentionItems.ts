import type { ContextEntry, ChatNodeState } from '../state/chatStore';

export interface AtMentionItem {
  /** Unique key for dedup / rendering. */
  id: string;
  /** Display label shown in the popup. */
  label: string;
  /** Short description (e.g. "context · auto" or "node · 3 msgs"). */
  description?: string;
  /** What kind of mention this is. */
  kind: 'context' | 'node';
  /** The token inserted into the input (without the leading @). */
  token: string;
}

/**
 * Build the list of mentionable items from contexts + same-tree nodes.
 * Filters by query (case-insensitive substring match).
 */
export function buildAtMentionItems(
  query: string,
  contexts: ContextEntry[],
  sameTreeNodes: ChatNodeState[],
  currentNodeId: string,
): AtMentionItem[] {
  const q = query.toLowerCase();
  const items: AtMentionItem[] = [];

  for (const ctx of contexts) {
    const label = ctx.name;
    if (q && !label.toLowerCase().includes(q)) continue;
    items.push({
      id: `ctx-${ctx.id}`,
      label,
      description: `${ctx.type ?? 'doc'}${ctx.pinnedAt ? ' · pinned' : ''}`,
      kind: 'context',
      token: ctx.name,
    });
  }

  for (const node of sameTreeNodes) {
    if (node.nodeId === currentNodeId) continue;
    if (node.messages.length === 0) continue;
    const title = node.title || node.messages.find(m => m.role === 'user')?.text.slice(0, 50) || node.nodeId;
    // Generate a stable slug from the title for the @token.
    const token = `node:${node.nodeId}`;
    if (q && !title.toLowerCase().includes(q) && !node.nodeId.toLowerCase().includes(q)) continue;
    const msgCount = node.messages.length;
    items.push({
      id: `node-${node.nodeId}`,
      label: title,
      description: `node · ${msgCount} msg${msgCount !== 1 ? 's' : ''}`,
      kind: 'node',
      token,
    });
  }

  return items;
}
