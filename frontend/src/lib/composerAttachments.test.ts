import { describe, it, expect } from 'vitest';
import { appendAttachmentsSentinel } from './composerAttachments';

describe('appendAttachmentsSentinel', () => {
  it('returns input unchanged when no attachments', () => {
    expect(appendAttachmentsSentinel('hello', [])).toBe('hello');
  });

  it('joins multiple attachments with " | "', () => {
    const out = appendAttachmentsSentinel('compare', [
      { name: 'a.md', absPath: '/abs/a.md' },
      { name: 'b.md', absPath: '/abs/b.md' },
    ]);
    expect(out).toBe('compare\n\n[Attached files: a.md — /abs/a.md | b.md — /abs/b.md]');
  });
});
