import { describe, it, expect } from 'vitest';
import { finalizeAssistant, stripInlineMetadataSentinels } from './assistantParsing';

describe('finalizeAssistant — follow-up sentinel stripping', () => {
  it('preserves prose that contains "[FOLLOW-UP" not in the tail block', () => {
    // Mid-prose mentions should not be eaten by the regex — only the tail
    // group at the end (consecutive sentinels with only whitespace between)
    // gets stripped.
    const raw = [
      '[TITLE: T]',
      'When the model writes [FOLLOW-UP 1/3: foo] inline, the parser groups',
      'them — see below.',
      '',
      '[FOLLOW-UP 1/3: real q1?]',
      '[FOLLOW-UP 2/3: real q2?]',
      '[FOLLOW-UP 3/3: real q3?]',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.followUps).toEqual(['real q1?', 'real q2?', 'real q3?']);
    // The mid-prose mention is part of visible text.
    expect(r.visibleText).toContain('writes [FOLLOW-UP 1/3: foo] inline');
  });
});

describe('stripInlineMetadataSentinels', () => {
  it('removes per-question [FOLLOW-UP n/3: ...] sentinels', () => {
    const input = 'Body\n[FOLLOW-UP 1/3: q1?]\n[FOLLOW-UP 2/3: q2?]\n[FOLLOW-UP 3/3: q3?]';
    // Trailing newlines collapse — the sentinels left blank lines behind that
    // the normaliser folds into a single \n\n.
    expect(stripInlineMetadataSentinels(input)).toBe('Body\n\n');
  });

  it('is idempotent on already-clean text', () => {
    const clean = 'A normal reply with no sentinels.';
    expect(stripInlineMetadataSentinels(clean)).toBe(clean);
    expect(stripInlineMetadataSentinels(stripInlineMetadataSentinels(clean))).toBe(clean);
  });
});
