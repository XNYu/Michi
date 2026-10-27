export interface NodeMentionToken {
  nodeId: string;
  start: number;
  end: number;
}

// Keep punctuation outside the token. In particular, remote renderer IDs
// contain ':' and may already contain percent escapes; encode the complete ID
// once here and decode once on read, preserving those existing escapes.
export function encodeNodeMentionToken(nodeId: string): string {
  const payload = encodeURIComponent(nodeId).replace(/[.!~*'()]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `@node:${payload}`;
}

const ID_COMPONENT = '(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+';
const TOKEN_PATTERN = `@node:(remote:${ID_COMPONENT}:${ID_COMPONENT}(?!:)|(?!remote:)${ID_COMPONENT})(?![A-Za-z0-9_%])`;

/**
 * Read encoded wire tokens and common legacy bare remote IDs. The latter keep
 * their component escapes verbatim; only the new encoded form is decoded.
 * Legacy IDs with unescaped punctuation cannot distinguish that punctuation
 * from surrounding prose, so newly emitted tokens always encode it.
 */
export function readNodeMentionTokens(text: string): NodeMentionToken[] {
  const tokens: NodeMentionToken[] = [];
  for (const match of text.matchAll(new RegExp(TOKEN_PATTERN, 'g'))) {
    const payload = match[1];
    let nodeId: string;
    try {
      nodeId = payload.startsWith('remote:') ? payload : decodeURIComponent(payload);
    } catch {
      // An incomplete/invalid escape is prose, never a partial node reference.
      continue;
    }
    tokens.push({ nodeId, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Replace complete tokens, preserving the historical horizontal-space policy. */
export function replaceNodeMentionTokens(
  text: string,
  replace: (nodeId: string, trailing: string) => string,
): string {
  let result = '';
  let cursor = 0;
  for (const token of readNodeMentionTokens(text)) {
    let end = token.end;
    while (text[end] === ' ' || text[end] === '\t') end += 1;
    result += text.slice(cursor, token.start) + replace(token.nodeId, text.slice(token.end, end));
    cursor = end;
  }
  return result + text.slice(cursor);
}
