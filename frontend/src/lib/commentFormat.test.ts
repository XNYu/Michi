import { describe, expect, it } from 'vitest';
import type { PendingComment } from '../state/chatTypes';
import {
  QUOTE_PREVIEW_MAX,
  formatCommentsBlock,
  joinMessageParts,
  renderComment,
  truncateQuotePreview,
} from './commentFormat';

const QUOTED_CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

function mkComment(
  id: string,
  quotedText: string,
  body: string,
): PendingComment {
  return { id, quotedText, body, createdAt: 0 };
}

describe('truncateQuotePreview', () => {
  it('returns input unchanged when under the cap', () => {
    expect(truncateQuotePreview('short passage')).toBe('short passage');
  });

  it('uses middle-ellipsis to keep both ends when exceeding the cap', () => {
    const input = 'a'.repeat(200);
    const out = truncateQuotePreview(input);
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('a')).toBe(true);
    expect(out).toContain(' ... ');
    expect(out.length).toBeLessThanOrEqual(QUOTE_PREVIEW_MAX + 2); // +2 safety for trim variance
  });

  it('operates on code points so CJK characters count as one each', () => {
    // 120 CJK chars — each is one code point but multiple UTF-16 units only for surrogates.
    const cjk = '一'.repeat(120);
    const out = truncateQuotePreview(cjk);
    expect(out).toContain(' ... ');
    // Roughly half on each side of the ellipsis.
    const [head, tail] = out.split(' ... ');
    expect(head.length).toBeGreaterThan(30);
    expect(tail.length).toBeGreaterThan(30);
    // Head+tail well under the original length.
    expect(head.length + tail.length).toBeLessThan(120);
  });

  it('honors a custom max', () => {
    const out = truncateQuotePreview('abcdefghijklmnop', 10);
    expect(out).toContain(' ... ');
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('p')).toBe(true);
  });
});

describe('renderComment', () => {
  it('prefixes every quote line with > and appends the body', () => {
    const c = mkComment('c1', 'line one\nline two', 'my reply');
    expect(renderComment(c)).toBe('> line one\n> line two\n\nmy reply');
  });

  it('does not double-prefix quotes that already start with >', () => {
    const c = mkComment('c1', '> already quoted', 'reply');
    expect(renderComment(c)).toBe('> already quoted\n\nreply');
  });

  it('renders quote-only when body is blank', () => {
    const c = mkComment('c1', 'just a quote', '   ');
    expect(renderComment(c)).toBe('> just a quote');
  });

  it('truncates overly long quotes with middle-ellipsis', () => {
    const long = 'x'.repeat(250);
    const c = mkComment('c1', long, 'reply');
    const out = renderComment(c);
    expect(out).toContain(' ... ');
    expect(out).toContain('reply');
  });

  it('normalizes CRLF line endings to LF', () => {
    const c = mkComment('c1', 'a\r\nb', 'reply');
    expect(renderComment(c)).toBe('> a\n> b\n\nreply');
  });
});

describe('formatCommentsBlock', () => {
  it('returns empty string for an empty array', () => {
    expect(formatCommentsBlock([])).toBe('');
  });

  it('formats a single comment with the section header', () => {
    const out = formatCommentsBlock([mkComment('c1', 'hello', 'hi back')]);
    expect(out).toBe(
      '## My Comments on Previous Reply\n\n> hello\n\nhi back',
    );
  });

  it('separates multiple comments with a horizontal rule', () => {
    const out = formatCommentsBlock([
      mkComment('c1', 'first quote', 'first reply'),
      mkComment('c2', 'second quote', 'second reply'),
    ]);
    expect(out).toBe(
      [
        '## My Comments on Previous Reply',
        '',
        '> first quote',
        '',
        'first reply',
        '',
        '---',
        '',
        '> second quote',
        '',
        'second reply',
      ].join('\n'),
    );
  });
});

describe('joinMessageParts', () => {
  it('returns just the user text when nothing else is present', () => {
    expect(joinMessageParts(null, null, 'hello world')).toBe('hello world');
  });

  it('puts the comment block before the user text', () => {
    const block = '## My Comments on Previous Reply\n\n> q\n\nb';
    expect(joinMessageParts(block, null, 'question?')).toBe(
      `${block}\n\nquestion?`,
    );
  });

  it('labels quote-reply text as selected assistant context', () => {
    const block = '## My Comments on Previous Reply\n\n> q1\n\nb1';
    expect(joinMessageParts(block, 'quoted line', 'the question')).toBe(
      `${block}\n\n${QUOTED_CONTEXT}\n\nSelected assistant passage:\n> quoted line\n\nUser's reply:\nthe question`,
    );
  });

  it('allows comment-only send (empty user text, null quote)', () => {
    const block = '## My Comments on Previous Reply\n\n> q\n\nb';
    expect(joinMessageParts(block, null, '')).toBe(block);
  });

  it('does not double-prefix quote lines that already start with >', () => {
    expect(joinMessageParts(null, '> already', 'next')).toBe(
      `${QUOTED_CONTEXT}\n\nSelected assistant passage:\n> already\n\nUser's reply:\nnext`,
    );
  });

  it('trims stray whitespace on all inputs', () => {
    expect(joinMessageParts('  block  ', '  q  ', '  text  ')).toBe(
      `block\n\n${QUOTED_CONTEXT}\n\nSelected assistant passage:\n> q\n\nUser's reply:\ntext`,
    );
  });
});
