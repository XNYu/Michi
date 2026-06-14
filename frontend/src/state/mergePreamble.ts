import type { ChatNodeState } from './chatTypes';
import { visibleMessageText } from './assistantBlocks';
import { descendants, type NodeAlive, type TreeEdge } from './tree';

export const MERGE_PREAMBLE_TOKEN_WARN = 32_000;

function renderTranscript(node: ChatNodeState): string {
  const title = node.title || 'Untitled';
  const turns = node.messages
    .map((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return null;
      const text = (m.role === 'assistant' ? visibleMessageText(m) : m.text ?? '').trim();
      if (!text) return null;
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    })
    .filter((s): s is string => !!s)
    .join('\n\n');
  return `=== Thread: ${title} ===\n${turns}`;
}

/**
 * Expand each source node into [source, ...branch descendants], deduplicate,
 * and render each as a transcript block. Merge edges are not traversed
 * (matches tree.ts:descendants behavior).
 */
export function buildSubtreeContextBlocks(
  sourceIds: readonly string[],
  nodes: Readonly<Record<string, ChatNodeState>>,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): string[] {
  const ids = new Set<string>();
  for (const sid of sourceIds) {
    if (!nodes[sid]) continue;
    if (isAlive && !isAlive(sid)) continue;
    ids.add(sid);
    for (const did of descendants(sid, edges, isAlive)) ids.add(did);
  }
  return Array.from(ids)
    .map((id) => nodes[id])
    .filter((n): n is ChatNodeState => !!n)
    .map(renderTranscript);
}

export function estimateMergePreambleTokens(
  sourceIds: readonly string[],
  nodes: Readonly<Record<string, ChatNodeState>>,
  edges: readonly TreeEdge[],
  isAlive?: NodeAlive,
): number {
  const blocks = buildSubtreeContextBlocks(sourceIds, nodes, edges, isAlive);
  return Math.ceil(blocks.join('').length / 4);
}
