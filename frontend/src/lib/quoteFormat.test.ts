import { formatQuotedMessage } from './quoteFormat';

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
