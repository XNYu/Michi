/**
 * The links the assistant writes into its answers, rendered as chips:
 *   michi://node/<nodeId>                       a Michi thread
 *   michi://node/<nodeId>?message=<messageId>   one message of it
 *   michi://page/<pageId>                       a Spaces page
 *   michi://page/<pageId>?block=<blockId>       one block of it
 * Nothing else with these schemes is a link.
 */
export type AssistantLink =
  | { kind: 'node'; id: string; messageId?: string }
  | { kind: 'page'; id: string; blockId?: string };

const NODE_RE = /^michi:\/\/node\/([^/?#\s]+)\/?(?:\?message=([^&#\s]+))?$/i;
const PAGE_RE = /^michi:\/\/page\/([^/?#\s]+)\/?(?:\?block=([^&#\s]+))?$/i;
const ID_RE = /^[A-Za-z0-9._:~@+=-]{1,256}$/;

/** A decoded id, or null when it isn't one ('.' and '..' are path segments, never ids). */
function decodeId(raw: string | undefined): string | null {
  if (!raw) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return ID_RE.test(id) && !/^\.+$/.test(id) ? id : null;
}

export function parseAssistantLink(href: string | null | undefined): AssistantLink | null {
  if (typeof href !== 'string') return null;
  const value = href.trim();
  const node = NODE_RE.exec(value);
  if (node) {
    const id = decodeId(node[1]);
    if (!id) return null;
    if (node[2] === undefined) return { kind: 'node', id };
    const messageId = decodeId(node[2]);
    return messageId ? { kind: 'node', id, messageId } : null;
  }
  const page = PAGE_RE.exec(value);
  if (page) return withBlock('page', page);
  return null;
}

function withBlock<K extends 'page'>(kind: K, match: RegExpExecArray): { kind: K; id: string; blockId?: string } | null {
  const id = decodeId(match[1]);
  if (!id) return null;
  if (match[2] === undefined) return { kind, id };
  const blockId = decodeId(match[2]);
  return blockId ? { kind, id, blockId } : null;
}

export function isAssistantLink(href: string | null | undefined): boolean {
  return parseAssistantLink(href) !== null;
}
