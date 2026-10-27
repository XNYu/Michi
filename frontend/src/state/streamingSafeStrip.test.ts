import { describe, it, expect } from 'vitest';
import { stripSentinelsStreamingSafe, extractAssistantMetadata } from './assistantParsing';

describe('stripSentinelsStreamingSafe — remapOffset', () => {
  it('clamps offsets inside an unresolved tail-hold to that tail start', () => {
    const raw = 'body[TITLE: a';
    const { visibleText, remapOffset } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('body');
    // Anywhere inside the tail-hold maps to visible end (== "body".length).
    for (let i = 4; i <= raw.length; i++) expect(remapOffset(i)).toBe(4);
  });
});

describe('extractAssistantMetadata', () => {
  it('extracts title and followups, leaves text alone', () => {
    const raw = [
      '[TITLE: T]',
      '',
      'body',
      '',
      '[FOLLOW-UP 1/3: q1?]',
      '[FOLLOW-UP 2/3: q2?]',
      '[FOLLOW-UP 3/3: q3?]',
    ].join('\n');
    const r = extractAssistantMetadata(raw);
    expect(r.title).toBe('T');
    expect(r.followUps).toEqual(['q1?', 'q2?', 'q3?']);
  });

  it('returns null/empty when no metadata sentinels', () => {
    const r = extractAssistantMetadata('just some prose with no sentinels');
    expect(r.title).toBeNull();
    expect(r.followUps).toEqual([]);
  });
});
