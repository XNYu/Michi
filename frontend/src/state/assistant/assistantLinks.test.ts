import { describe, expect, it } from 'vitest';
import { parseAssistantLink } from './assistantLinks';

describe('parseAssistantLink', () => {
  it('accepts native threads and rejects retired external links', () => {
    expect(parseAssistantLink('michi://node/n-123')).toEqual({ kind: 'node', id: 'n-123' });
    for (const href of ['desk://thread/cc:abc_1', 'desk://project/p1', 'desk://project/p1?block=b1']) {
      expect(parseAssistantLink(href)).toBeNull();
    }
  });

  it('reads a link to one message of a thread', () => {
    expect(parseAssistantLink('michi://node/n-123?message=a-9')).toEqual({ kind: 'node', id: 'n-123', messageId: 'a-9' });
    expect(parseAssistantLink('MICHI://Node/n-1/?message=self-n%2D1')).toEqual({ kind: 'node', id: 'n-1', messageId: 'self-n-1' });
    for (const href of ['michi://node/n-1?message=', 'michi://node/n-1?message=..', 'michi://node/n-1?message=a&x=1', 'michi://node/n-1?block=b1', 'michi://node/n-1?message=a#x']) {
      expect(parseAssistantLink(href)).toBeNull();
    }
  });

  it('reads Spaces page and block links', () => {
    expect(parseAssistantLink('michi://page/pg-adbd')).toEqual({ kind: 'page', id: 'pg-adbd' });
    expect(parseAssistantLink('michi://page/pg-1?block=block-24')).toEqual({ kind: 'page', id: 'pg-1', blockId: 'block-24' });
    expect(parseAssistantLink('MICHI://Page/pg-1/?block=b%2D2')).toEqual({ kind: 'page', id: 'pg-1', blockId: 'b-2' });
    for (const href of ['michi://page/', 'michi://page/pg-1?block=', 'michi://page/pg-1?block=..', 'michi://page/pg-1?block=b&x=1', 'michi://page/a/b']) {
      expect(parseAssistantLink(href)).toBeNull();
    }
  });

  it('rejects anything else', () => {
    for (const href of [
      '', 'https://example.com', 'javascript:alert(1)', 'michi://thread/x', 'desk://node/x',
      'michi://node/', 'michi://node/a/b', 'desk://thread/a?x=1', 'desk://thread/a#b', 'desk://thread/%3Cscript%3E',
      'desk://thread/%E0%A4%A', 'michi:node/x', ' michi://node/a b',
      'michi://node/..', 'desk://thread/.', 'desk://project/%2E%2E',
    ]) {
      expect(parseAssistantLink(href)).toBeNull();
    }
    expect(parseAssistantLink(undefined)).toBeNull();
  });
});
