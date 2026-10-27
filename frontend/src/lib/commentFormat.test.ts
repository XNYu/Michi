import { describe, expect, it } from 'vitest';
import type { PendingComment } from '../state/chatTypes';
import { formatCommentsBlock, joinMessageParts, renderComment, truncateQuotePreview } from './commentFormat';

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
});

describe('renderComment with artifact source', () => {
  it('renders without body when body is empty (source present)', () => {
    const c: PendingComment = {
      id: 'c3',
      quotedText: 'passage only',
      body: '',
      createdAt: 0,
      source: { type: 'artifact', name: 'Doc', filePath: 'doc.md' },
    };
    // addPendingComment guards against empty body, but renderComment should handle it gracefully
    const out = renderComment(c);
    expect(out).toContain('From artifact "Doc" at `doc.md`:');
    expect(out).toContain('> passage only');
    expect(out).toContain('The full document is available at `doc.md`.');
    expect(out).not.toContain('\n\n\n'); // no double blank line from missing body
  });

  it('includes line numbers and section when selector is provided', () => {
    const c: PendingComment = {
      id: 'c4',
      quotedText: 'domainOwner field',
      body: 'what does this do?',
      createdAt: 0,
      source: {
        type: 'artifact',
        name: 'Config Spec',
        filePath: 'docs/config.md',
        selector: {
          exact: 'domainOwner field',
          prefix: 'required for all types. ',
          suffix: ' This determines the routing',
          startOffset: 420,
          endOffset: 437,
          startLine: 42,
          endLine: 42,
          section: '## Configuration Fields > ### domainOwner',
        },
      },
    };
    const out = renderComment(c);
    expect(out).toContain('line 42');
    expect(out).toContain('section "## Configuration Fields > ### domainOwner"');
    expect(out).toContain('Context before: "required for all types. "');
    expect(out).toContain('Context after: " This determines the routing"');
    expect(out).toContain('Read lines 42-42 for the exact passage.');
  });
});

describe('formatCommentsBlock', () => {
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
  it('allows comment-only send (empty user text, null quote)', () => {
    const block = '## My Comments on Previous Reply\n\n> q\n\nb';
    expect(joinMessageParts(block, null, '')).toBe(block);
  });
});

it('does not tell the agent old line numbers locate the current file passage', () => {
  const result = renderComment({ ...mkComment('c', 'old text', 'fix this'), source: {
    type: 'artifact', filePath: 'spec.md', selector: { exact: 'old text', startLine: 8, endLine: 9 },
    snapshot: { hashKind: 'sha256-text-utf8', contentHash: 'abc123', backendConnectionId: 'local', projectId: 'p', resolvedFilePath: '/actual/spec.md' },
  } });
  expect(result).toContain('lines 8-9');
  expect(result).toContain('sha256-text-utf8 abc123');
  expect(result).toContain('current file may differ');
  expect(result).not.toContain('Read lines 8-9 for the exact passage');
});

it('sends the complete old selection when a snapshot is the only retained version', () => {
  const exact = '完整旧版选段🙂'.repeat(100);
  const result = renderComment({ ...mkComment('long', 'short preview', 'edit this'), source: {
    type: 'artifact', filePath: 'a.md', selector: { exact },
    snapshot: { hashKind: 'sha256-text-utf8', contentHash: 'old', backendConnectionId: 'local', projectId: 'p', resolvedFilePath: '/a.md' },
  } });
  expect(result).toContain(exact);
  expect(result).not.toContain('short preview');
});
