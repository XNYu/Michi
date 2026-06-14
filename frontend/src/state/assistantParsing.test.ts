import { describe, it, expect } from 'vitest';
import { finalizeAssistant, stripInlineMetadataSentinels } from './assistantParsing';

describe('finalizeAssistant — follow-up sentinel stripping', () => {
  it('strips standard well-formed sentinels (closing brackets present, own lines)', () => {
    const raw = [
      '[TITLE: Some title]',
      '',
      'Body paragraph.',
      '',
      '[FOLLOW-UP 1/3: q1?]',
      '[FOLLOW-UP 2/3: q2?]',
      '[FOLLOW-UP 3/3: q3?]',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.title).toBe('Some title');
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
    expect(r.visibleText).toBe('Body paragraph.');
  });

  it('strips sentinels even when ALL three closing brackets are missing', () => {
    // Reproduces the bug from the screenshot: model dropped every "]" and the
    // whole follow-up block leaked into visible text.
    const raw = [
      '[TITLE: T]',
      '',
      'Body.',
      '',
      '[FOLLOW-UP 1/3: q1?  [FOLLOW-UP 2/3: q2?  [FOLLOW-UP 3/3: q3?',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
    expect(r.visibleText).toBe('Body.');
  });

  it('strips sentinels when brackets are missing AND each on its own line', () => {
    const raw = [
      '[TITLE: T]',
      'Body.',
      '[FOLLOW-UP 1/3: q1?',
      '[FOLLOW-UP 2/3: q2?',
      '[FOLLOW-UP 3/3: q3?',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
    expect(r.visibleText).toBe('Body.');
  });

  it('handles mixed: q1 unclosed, q2 closed, q3 unclosed at EOF', () => {
    const raw = [
      '[TITLE: T]',
      'Body.',
      '[FOLLOW-UP 1/3: q1? [FOLLOW-UP 2/3: q2?] [FOLLOW-UP 3/3: q3?',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
    expect(r.visibleText).toBe('Body.');
  });

  it('trims trailing whitespace inside unclosed-sentinel question text', () => {
    const raw = '[FOLLOW-UP 1/3: q1?   \n[FOLLOW-UP 2/3: q2?\n[FOLLOW-UP 3/3: q3?';
    const r = finalizeAssistant(raw);
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
  });

  it('strips [TITLE: ...] that appears mid-body, not just at the start', () => {
    // User-reported screenshot bug: the michi agent emitted the title sentinel
    // after a paragraph of body text instead of as the first line. finalize
    // should still extract the title and strip the bracket from visible text.
    const raw = [
      '看看当前工作区的状态。',
      '',
      '[TITLE: Workspace snapshot]',
      '',
      '当前在 dev 分支。',
    ].join('\n');
    const r = finalizeAssistant(raw);
    expect(r.title).toBe('Workspace snapshot');
    expect(r.visibleText).not.toContain('[TITLE:');
    expect(r.visibleText).toContain('看看当前工作区的状态');
    expect(r.visibleText).toContain('当前在 dev 分支');
  });

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
  it('removes [TITLE: ...] anywhere in the text', () => {
    expect(stripInlineMetadataSentinels('Body\n\n[TITLE: T]\n\nMore'))
      .toBe('Body\n\nMore');
  });

  it('removes [FOLLOW-UPS: a | b | c] legacy form', () => {
    expect(stripInlineMetadataSentinels('Body\n\n[FOLLOW-UPS: a? | b? | c?]'))
      .toBe('Body\n\n');
  });

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

  it('returns input unchanged when there is no opening bracket', () => {
    expect(stripInlineMetadataSentinels('plain text')).toBe('plain text');
    expect(stripInlineMetadataSentinels('')).toBe('');
  });

  it('preserves other bracketed prose like [note] or [link](url)', () => {
    const input = 'See [note] and a [link](url) here.';
    expect(stripInlineMetadataSentinels(input)).toBe(input);
  });
});
