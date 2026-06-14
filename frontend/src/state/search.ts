import { visibleMessageText } from './assistantBlocks';
import type { ChatNodeState, Project } from './chatTypes';

export interface MessageMatch {
  projectId: string;
  projectName: string;
  workspaceId: string; // mirrors projectId for clarity in callers
  workspaceName: string; // mirrors projectName
  nodeId: string;
  threadName: string;
  messageIdx: number;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
  matchOffsetInSnippet: [number, number];
}

export interface SearchResult {
  matches: MessageMatch[];
  truncated: boolean;
  totalUnbounded: number;
}

const RESULT_CAP = 300;
const SNIPPET_WINDOW = 60; // chars on each side of the match

/**
 * Pure substring search across all chat messages in the given projects.
 *
 * - Case-insensitive substring match on `messages[*].text`.
 * - Skips trashed nodes (`deletedAt` set) and digest nodes (`kind === 'digest'`).
 * - Snippet is a ~120-char window centered on the first match in the message,
 *   with `matchOffsetInSnippet` giving the [start, end) of the match within
 *   the snippet for highlight rendering.
 * - Caps the returned matches at 300 but keeps counting beyond the cap so the
 *   caller can show a "+N more" hint.
 * - Empty / whitespace-only query returns an empty result with no work done.
 *
 * Pure: no React, no DOM, no I/O, no state. Safe to call from anywhere.
 */
export function searchMessages(
  nodes: Record<string, ChatNodeState>,
  projects: Project[],
  query: string,
): SearchResult {
  const trimmed = query.trim();
  if (!trimmed) return { matches: [], truncated: false, totalUnbounded: 0 };
  const lowerQ = trimmed.toLowerCase();

  const matches: MessageMatch[] = [];
  let totalUnbounded = 0;

  for (const project of projects) {
    for (const nodeId of project.chatIds) {
      const node = nodes[nodeId];
      if (!node) continue;
      if (node.deletedAt) continue;
      if (node.kind === 'digest') continue;

      const threadName = node.title ?? '(untitled)';

      for (let i = 0; i < node.messages.length; i++) {
        const m = node.messages[i];
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const visible = visibleMessageText(m);
        const lower = visible.toLowerCase();
        const idx = lower.indexOf(lowerQ);
        if (idx === -1) continue;

        totalUnbounded++;
        if (matches.length >= RESULT_CAP) continue;

        const snippetStart = Math.max(0, idx - SNIPPET_WINDOW);
        const snippetEnd = Math.min(visible.length, idx + lowerQ.length + SNIPPET_WINDOW);
        const snippet = visible.slice(snippetStart, snippetEnd);
        const matchInSnippet: [number, number] = [
          idx - snippetStart,
          idx - snippetStart + lowerQ.length,
        ];

        matches.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: project.id,
          workspaceName: project.name,
          nodeId,
          threadName,
          messageIdx: i,
          messageId: m.id,
          role: m.role,
          snippet,
          matchOffsetInSnippet: matchInSnippet,
        });
      }
    }
  }

  return {
    matches,
    truncated: totalUnbounded > matches.length,
    totalUnbounded,
  };
}
