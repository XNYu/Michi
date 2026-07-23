import { formatQuotedMessage, QuoteSource } from './quoteFormat';

const CONTEXT =
  'Context: The user selected the passage below from the previous assistant reply. Treat it as source context, not as text authored by the user.';

describe('formatQuotedMessage', () => {
  test('labels selected assistant text before the branch prompt', () => {
    expect(formatQuotedMessage('hello\nworld', 'tell me more')).toBe(
      `${CONTEXT}\n\nSelected assistant passage:\n> hello\n> world\n\nUser's branch question:\ntell me more`,
    );
  });

  test('preserves already-quoted lines', () => {
    expect(formatQuotedMessage('> already quoted\nfresh line', 'why?')).toBe(
      `${CONTEXT}\n\nSelected assistant passage:\n> already quoted\n> fresh line\n\nUser's branch question:\nwhy?`,
    );
  });

  test('normalizes CRLF to LF', () => {
    expect(formatQuotedMessage('a\r\nb', 'x')).toBe(
      `${CONTEXT}\n\nSelected assistant passage:\n> a\n> b\n\nUser's branch question:\nx`,
    );
  });

  test('empty prompt degrades to labeled quote context', () => {
    expect(formatQuotedMessage('hello', '')).toBe(
      `${CONTEXT}\n\nSelected assistant passage:\n> hello`,
    );
  });

  test('empty quote returns prompt only', () => {
    expect(formatQuotedMessage('', 'just ask')).toBe('just ask');
  });

  test('both empty returns empty', () => {
    expect(formatQuotedMessage('', '')).toBe('');
  });

  test('trims prompt whitespace', () => {
    expect(formatQuotedMessage('x', '   why   ')).toBe(
      `${CONTEXT}\n\nSelected assistant passage:\n> x\n\nUser's branch question:\nwhy`,
    );
  });
});

describe('formatQuotedMessage with artifact source', () => {
  const source: QuoteSource = {
    type: 'artifact',
    name: 'API Spec',
    filePath: 'docs/api-spec.md',
  };

  test('uses artifact context prefix with name and path', () => {
    const result = formatQuotedMessage('some code', 'explain this', source);
    expect(result).toContain('from artifact "API Spec" at `docs/api-spec.md`');
    expect(result).toContain('Selected passage:');
    expect(result).toContain('> some code');
    expect(result).toContain('The full document is available at `docs/api-spec.md`. Read it if you need more context.');
    expect(result).toContain("User's branch question:\nexplain this");
  });

  test('omits name gracefully when not provided', () => {
    const noName: QuoteSource = { type: 'artifact', filePath: 'src/index.ts' };
    const result = formatQuotedMessage('line 1', 'what is this?', noName);
    expect(result).toContain('from an artifact document at `src/index.ts`');
    expect(result).toContain('The full document is available at `src/index.ts`');
  });

  test('empty prompt with artifact source returns context only', () => {
    const result = formatQuotedMessage('hello', '', source);
    expect(result).toContain('from artifact "API Spec"');
    expect(result).toContain('The full document is available at `docs/api-spec.md`');
    expect(result).not.toContain("User's branch question:");
  });

  test('without source, uses original assistant-reply context', () => {
    const result = formatQuotedMessage('hello', 'why?');
    expect(result).toContain('from the previous assistant reply');
    expect(result).not.toContain('The full document is available');
  });
});
