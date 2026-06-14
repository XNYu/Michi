import { describe, it, expect } from 'vitest';
import {
  stripSentinelsStreamingSafe,
  deriveVisibleMessage,
  extractAssistantMetadata,
} from './assistantParsing';

describe('stripSentinelsStreamingSafe — completed sentinels', () => {
  it('strips a completed [TITLE: ...] sentinel + trailing whitespace', () => {
    const { visibleText } = stripSentinelsStreamingSafe('[TITLE: hello]\n\nbody');
    expect(visibleText).toBe('body');
  });

  it('strips completed [FOLLOW-UP n/3: ...] sentinels', () => {
    const raw = 'body\n\n[FOLLOW-UP 1/3: q1?]\n[FOLLOW-UP 2/3: q2?]';
    const { visibleText } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('body\n\n');
  });

  it('strips multiple sentinels mixed with prose', () => {
    const raw = '[TITLE: T]\n\nA paragraph.\n\n[FOLLOW-UP 1/3: q?]';
    const { visibleText } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('A paragraph.\n\n');
  });
});

describe('stripSentinelsStreamingSafe — prose passthrough', () => {
  it('keeps plain prose `[note]` brackets in visibleText', () => {
    const raw = 'This is [note] inside text.';
    const { visibleText } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe(raw);
  });

  it('keeps markdown link `[label](url)` unchanged', () => {
    const raw = 'See [docs](https://example.com) for more.';
    const { visibleText } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe(raw);
  });

  it('keeps `[a]` then prose then real sentinel', () => {
    const raw = 'See [a] inline.\n\n[TITLE: T]';
    const { visibleText } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('See [a] inline.\n\n');
  });
});

describe('stripSentinelsStreamingSafe — incomplete sentinel tail (mid-stream)', () => {
  it('hides a `[T` tail (still possibly [TITLE:)', () => {
    const { visibleText } = stripSentinelsStreamingSafe('Hello [T');
    expect(visibleText).toBe('Hello ');
  });

  it('hides a `[TITLE:` tail', () => {
    const { visibleText } = stripSentinelsStreamingSafe('[TITLE:');
    expect(visibleText).toBe('');
  });

  it('hides a `[TITLE: abc` tail (sentinel still forming)', () => {
    const { visibleText } = stripSentinelsStreamingSafe('[TITLE: abc');
    expect(visibleText).toBe('');
  });

  it('hides a `[FOLLOW` / `[FOLLOW-UP` tail', () => {
    expect(stripSentinelsStreamingSafe('body\n\n[FOLLOW').visibleText).toBe('body\n\n');
    expect(stripSentinelsStreamingSafe('body\n\n[FOLLOW-UP 1/3: q').visibleText).toBe('body\n\n');
  });

  it('releases `[note` immediately when next char rules out sentinel', () => {
    // After `[n`, `n` is not a candidate next char for `[T` or `[F` — release.
    const { visibleText } = stripSentinelsStreamingSafe('[note');
    expect(visibleText).toBe('[note');
  });
});

describe('stripSentinelsStreamingSafe — visibleText is monotonic across raw growth', () => {
  // For each prefix of a representative raw stream, check that visibleText
  // never shrinks as more characters arrive.
  function prefixesOf(raw: string): string[] {
    const out: string[] = [];
    for (let i = 0; i <= raw.length; i++) out.push(raw.slice(0, i));
    return out;
  }

  function checkMonotonic(raw: string): void {
    let prev = '';
    for (const prefix of prefixesOf(raw)) {
      const { visibleText } = stripSentinelsStreamingSafe(prefix);
      expect(
        visibleText.length >= prev.length,
        `visibleText shrank from "${prev}" to "${visibleText}" at prefix "${prefix}"`,
      ).toBe(true);
      prev = visibleText;
    }
  }

  it('monotonic for "[TITLE: hi]\\n\\nbody"', () => {
    checkMonotonic('[TITLE: hi]\n\nbody');
  });

  it('monotonic for "Hello [note] world"', () => {
    checkMonotonic('Hello [note] world');
  });

  it('monotonic for "body [link](url) tail"', () => {
    checkMonotonic('body [link](url) tail');
  });

  it('monotonic for raw with prose then sentinel', () => {
    checkMonotonic('See [a] inline.\n\n[FOLLOW-UP 1/3: q?]');
  });
});

describe('stripSentinelsStreamingSafe — remapOffset', () => {
  it('identity-maps when no sentinels', () => {
    const raw = 'plain prose with [note] inside';
    const { remapOffset } = stripSentinelsStreamingSafe(raw);
    expect(remapOffset(0)).toBe(0);
    expect(remapOffset(5)).toBe(5);
    expect(remapOffset(raw.length)).toBe(raw.length);
  });

  it('compresses offset by the cut length when offset is past a sentinel', () => {
    const raw = '[TITLE: T]\n\nbody';
    const { visibleText, remapOffset } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('body');
    // raw position pointing at "b" (index 12 in raw) maps to 0 in visibleText.
    expect(remapOffset(12)).toBe(0);
    expect(remapOffset(raw.length)).toBe(visibleText.length);
  });

  it('snaps offsets that land inside a sentinel cut to the cut start', () => {
    const raw = '[TITLE: T]\n\nbody';
    const { remapOffset } = stripSentinelsStreamingSafe(raw);
    // Anywhere from 0..(end of cut) should map to 0 in visibleText.
    for (let i = 0; i < 12; i++) expect(remapOffset(i)).toBe(0);
  });

  it('clamps offsets inside an unresolved tail-hold to that tail start', () => {
    const raw = 'body[TITLE: a';
    const { visibleText, remapOffset } = stripSentinelsStreamingSafe(raw);
    expect(visibleText).toBe('body');
    // Anywhere inside the tail-hold maps to visible end (== "body".length).
    for (let i = 4; i <= raw.length; i++) expect(remapOffset(i)).toBe(4);
  });
});

describe('deriveVisibleMessage — message-shaped wrapper', () => {
  it('reads m.text and projects through stripSentinelsStreamingSafe', () => {
    const m = { text: '[TITLE: x]\n\nhello' };
    const r = deriveVisibleMessage(m);
    expect(r.visibleText).toBe('hello');
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
