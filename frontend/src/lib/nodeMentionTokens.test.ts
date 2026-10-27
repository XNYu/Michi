import { describe, expect, it } from 'vitest';
import { backendEntityId } from '../config/backendIdentity';
import { encodeNodeMentionToken, readNodeMentionTokens, replaceNodeMentionTokens } from './nodeMentionTokens';

describe('node mention wire tokens', () => {
  it('keeps existing local tokens byte-for-byte compatible', () => {
    expect(encodeNodeMentionToken('n-123_abc')).toBe('@node:n-123_abc');
    expect(readNodeMentionTokens('see @node:n-123_abc.')).toEqual([
      { nodeId: 'n-123_abc', start: 4, end: 19 },
    ]);
    expect(replaceNodeMentionTokens('@node:n-123_abc: next', () => 'Local')).toBe('Local: next');
  });

  it('round-trips the complete renderer identity without decoding its component escapes again', () => {
    const nodeId = backendEntityId('ssh:東京/a', "n:1/file.(draft)!~*'");
    const token = encodeNodeMentionToken(nodeId);
    expect(token.slice('@node:'.length)).not.toMatch(/[.:!~*'()]/g);
    expect(token.startsWith('@node:')).toBe(true);
    expect(token).toContain('%253A');
    expect(readNodeMentionTokens(`${token}. Next`)).toEqual([
      { nodeId, start: 0, end: token.length },
    ]);
  });

  it('retains component escapes in common legacy bare remote tokens', () => {
    const nodeId = backendEntityId('ssh/a', 'n:1');
    const token = `@node:${nodeId}`;
    expect(readNodeMentionTokens(`${token}, next`)).toEqual([
      { nodeId, start: 0, end: token.length },
    ]);
  });

  it.each([
    '@node:n1%', '@node:n1%ZZ', '@node:%E0%A4', '@node:remote:ssh:n1%0',
    '@node:remote::n1', '@node:remote:ssh:', '@node:', '@nodes:n1', 'plain @node text',
  ])('does not consume an invalid token or a similar-looking phrase: %s', (text) => {
    expect(readNodeMentionTokens(text)).toEqual([]);
    expect(replaceNodeMentionTokens(text, () => 'REPLACED')).toBe(text);
  });

  it('separates multiple encoded references from trailing punctuation and preserves line breaks', () => {
    const firstId = backendEntityId('a', 'n.1');
    const secondId = backendEntityId('b', 'n(2)');
    const first = encodeNodeMentionToken(firstId);
    const second = encodeNodeMentionToken(secondId);
    const text = `${first}, ${second}).\n@node:local\t\nDone`;
    expect(readNodeMentionTokens(text).map((token) => token.nodeId)).toEqual([firstId, secondId, 'local']);
    expect(replaceNodeMentionTokens(text, () => '')).toBe(', ).\n\nDone');
  });
});
