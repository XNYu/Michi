import { describe, it, expect } from 'vitest';
import { appendAttachmentsSentinel } from './composerAttachments';

describe('appendAttachmentsSentinel', () => {
  it('returns input unchanged when no attachments', () => {
    expect(appendAttachmentsSentinel('hello', [])).toBe('hello');
  });

  it('appends a single attachment with absolute path', () => {
    const out = appendAttachmentsSentinel('summarise this', [
      { name: 'doc.pdf', absPath: '/Users/me/doc.pdf' },
    ]);
    expect(out).toBe('summarise this\n\n[Attached files: doc.pdf — /Users/me/doc.pdf]');
  });

  it('joins multiple attachments with " | "', () => {
    const out = appendAttachmentsSentinel('compare', [
      { name: 'a.md', absPath: '/abs/a.md' },
      { name: 'b.md', absPath: '/abs/b.md' },
    ]);
    expect(out).toBe('compare\n\n[Attached files: a.md — /abs/a.md | b.md — /abs/b.md]');
  });

  it('handles empty input string', () => {
    const out = appendAttachmentsSentinel('', [{ name: 'x.txt', absPath: '/x.txt' }]);
    expect(out).toBe('\n\n[Attached files: x.txt — /x.txt]');
  });
});
