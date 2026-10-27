import { describe, it, expect } from 'vitest';
import { sanitizeContextName } from './sanitizeContextName';

describe('sanitizeContextName', () => {
  it('falls back to "context" for empty result', () => {
    expect(sanitizeContextName('   .md', [])).toBe('context');
    expect(sanitizeContextName('', [])).toBe('context');
  });

  it('dedups with numeric suffix when name collides', () => {
    expect(sanitizeContextName('notes.md', ['notes'])).toBe('notes-2');
    expect(sanitizeContextName('notes.md', ['notes', 'notes-2'])).toBe('notes-3');
  });
});
