import type { ChatMessage, ChatNodeState, ProjectEdge } from './chatTypes';
import { visibleMessageText } from './assistantBlocks';

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
  /** The child's first message: what the user asked, on one line, cut short. */
  question?: string;
  /** The reply to that question once it has finished, as plain text, cut short. */
  reply?: string;
}

const QUESTION_CHARS = 160;
const REPLY_CHARS = 180;

function childTitle(n: ChatNodeState): string {
  return (
    n.title ||
    n.messages.find((m) => m.role === 'user')?.text.slice(0, 40) ||
    'Untitled'
  );
}

function cut(words: string, limit: number): string | undefined {
  if (!words) return undefined;
  return words.length > limit ? `${words.slice(0, limit).trimEnd()}…` : words;
}

/** Markdown down to its words, on one line. Underscores inside a word (snake_case) stay. */
function markdownWords(text: string, limit: number): string | undefined {
  return cut(
    text
      .slice(0, limit * 4)
      .replace(/```[^\n]*\n?/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
      .replace(/[*`~|]+/g, '')
      .replace(/(^|[^\p{L}\p{N}_])_+|_+(?=[^\p{L}\p{N}_]|$)/gu, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
    limit,
  );
}

/**
 * The child's opening exchange: the question its first message asked and the
 * reply to it. A reply still streaming is left out: the anchor map is read at
 * structural rhythm, so a live reply would show whatever text it had at the
 * last structural change.
 */
function openingExchange(n: ChatNodeState): { question?: string; reply?: string } {
  const asked = n.messages.findIndex((m) => m.role === 'user');
  if (asked < 0) return {};
  const question = cut(n.messages[asked].text.replace(/\s+/g, ' ').trim(), QUESTION_CHARS);
  const answered = n.messages.findIndex((m, i) => i > asked && m.role === 'assistant');
  if (answered < 0) return { question };
  const answer = n.messages[answered];
  const live = n.status === 'streaming' && answered === n.messages.length - 1;
  if (answer.streaming || live) return { question };
  return { question, reply: markdownWords(visibleMessageText(answer), REPLY_CHARS) };
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
      ...openingExchange(child),
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
