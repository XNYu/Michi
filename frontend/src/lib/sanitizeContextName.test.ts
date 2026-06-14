import { describe, it, expect } from 'vitest';
import { sanitizeContextName } from './sanitizeContextName';

describe('sanitizeContextName', () => {
  it('strips extension and keeps allowed chars', () => {
    expect(sanitizeContextName('design-doc.md', [])).toBe('design-doc');
    expect(sanitizeContextName('Spec_v3.pdf', [])).toBe('Spec_v3');
  });

  it('replaces disallowed chars with "-"', () => {
    expect(sanitizeContextName('weird name (v2).txt', [])).toBe('weird-name-v2');
  });

  it('collapses runs of dashes', () => {
    expect(sanitizeContextName('a    b!!c.md', [])).toBe('a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(sanitizeContextName('--hello--.md', [])).toBe('hello');
  });

  it('preserves non-ASCII Unicode letters', () => {
    expect(sanitizeContextName('我和Vic_完整总结_v2.md', [])).toBe('我和Vic_完整总结_v2');
    expect(sanitizeContextName('L_关系记述.md', [])).toBe('L_关系记述');
    expect(sanitizeContextName('données-résumé.txt', [])).toBe('données-résumé');
  });

  it('falls back to "context" for empty result', () => {
    expect(sanitizeContextName('   .md', [])).toBe('context');
    expect(sanitizeContextName('', [])).toBe('context');
  });

  it('dedups with numeric suffix when name collides', () => {
    expect(sanitizeContextName('notes.md', ['notes'])).toBe('notes-2');
    expect(sanitizeContextName('notes.md', ['notes', 'notes-2'])).toBe('notes-3');
  });

  it('dedup is case-insensitive', () => {
    expect(sanitizeContextName('Notes.md', ['notes'])).toBe('Notes-2');
  });
});
