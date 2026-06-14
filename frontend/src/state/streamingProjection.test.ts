import { describe, it, expect } from 'vitest';
import { weaveToolCalls, type Segment } from './streamingProjection';
import type { ToolCallState } from './chatTypes';

const identity = (n: number) => n;

function tool(id: string, textOffset: number | undefined, status = 'completed'): ToolCallState {
  return { id, title: `t-${id}`, status, textOffset };
}

function texts(segments: Segment[]): string[] {
  return segments.flatMap((s) => (s.kind === 'text' ? [s.text] : []));
}

function toolIdsByGroup(segments: Segment[]): string[][] {
  return segments.flatMap((s) => (s.kind === 'tool-group' ? [s.tools.map((t) => t.id)] : []));
}

describe('weaveToolCalls — streaming gating', () => {
  const smooth = 'paragraph one\n\nparagraph two';
  const rawLen = smooth.length;

  it('emits no chip when raw has not reached the tool offset', () => {
    const segs = weaveToolCalls(
      smooth.slice(0, 5),
      5, // rawLen ahead of smooth not relevant — rawLen vs textOffset is the gate
      [tool('a', 100)],
      identity,
      { forceFinal: false },
    );
    expect(toolIdsByGroup(segs)).toEqual([]);
    expect(texts(segs)).toEqual([smooth.slice(0, 5)]);
  });

  it('emits no chip when smoothText has not caught up to the (remapped) offset', () => {
    const segs = weaveToolCalls(
      smooth.slice(0, 5),
      rawLen,
      [tool('a', 20)],
      identity,
      { forceFinal: false },
    );
    expect(toolIdsByGroup(segs)).toEqual([]);
  });

  it('emits no chip when smooth-covered position has no markdown-safe boundary', () => {
    // smoothText opens a bold span that hasn't closed — there is no safe
    // markdown boundary anywhere; streaming → wait.
    const segs = weaveToolCalls('open **bold', 11, [tool('a', 0)], identity, {
      forceFinal: false,
    });
    expect(toolIdsByGroup(segs)).toEqual([]);
    expect(texts(segs)).toEqual(['open **bold']);
  });

  it('emits chip at the next safe boundary once it exists', () => {
    // \n\n is at index 13–14, safe slice index = 15.
    const segs = weaveToolCalls(smooth, rawLen, [tool('a', 0)], identity, {
      forceFinal: false,
    });
    expect(toolIdsByGroup(segs)).toEqual([['a']]);
    expect(texts(segs).join('')).toBe(smooth);
  });
});

describe('weaveToolCalls — forceFinal terminal state', () => {
  it('falls back to smoothText.length when no boundary exists', () => {
    const segs = weaveToolCalls('Done.', 5, [tool('a', 5)], identity, {
      forceFinal: true,
    });
    expect(texts(segs)).toEqual(['Done.']);
    expect(toolIdsByGroup(segs)).toEqual([['a']]);
  });

  it('appends tools with no textOffset at the very end (legacy spawn-style)', () => {
    const segs = weaveToolCalls('Body text.', 10, [tool('a', undefined)], identity, {
      forceFinal: true,
    });
    expect(toolIdsByGroup(segs)).toEqual([['a']]);
    expect(texts(segs)).toEqual(['Body text.']);
  });

  it('streaming mode never renders an undefined-offset tool', () => {
    const segs = weaveToolCalls('Body text.', 10, [tool('a', undefined)], identity, {
      forceFinal: false,
    });
    expect(toolIdsByGroup(segs)).toEqual([]);
  });
});

describe('weaveToolCalls — tool grouping', () => {
  it('coalesces adjacent tools at the same boundary into one group', () => {
    const smooth = 'before\n\nafter';
    const segs = weaveToolCalls(
      smooth,
      smooth.length,
      [tool('a', 0), tool('b', 0), tool('c', 0)],
      identity,
      { forceFinal: false },
    );
    // \n\n at 6–7, safe at 8.
    expect(texts(segs)).toEqual([smooth.slice(0, 8), smooth.slice(8)]);
    expect(toolIdsByGroup(segs)).toEqual([['a', 'b', 'c']]);
  });

  it('keeps non-adjacent tools in separate groups (text between them)', () => {
    const smooth = 'one\n\ntwo\n\nthree';
    // Two distinct boundaries: \n\n at 3-4 (safe=5) and 8-9 (safe=10).
    const segs = weaveToolCalls(
      smooth,
      smooth.length,
      [tool('a', 0), tool('b', 6)],
      identity,
      { forceFinal: false },
    );
    expect(toolIdsByGroup(segs)).toEqual([['a'], ['b']]);
  });

  it('forceFinal: undefined-offset tools coalesce with a trailing group', () => {
    const smooth = 'tail';
    const segs = weaveToolCalls(
      smooth,
      smooth.length,
      [tool('a', 4), tool('b', undefined)],
      identity,
      { forceFinal: true },
    );
    // a snaps to text.length (no boundary, forceFinal); b appends.
    expect(toolIdsByGroup(segs)).toEqual([['a', 'b']]);
  });
});

describe('weaveToolCalls — remapOffset', () => {
  it('uses remapOffset to translate raw textOffsets to smooth coordinates', () => {
    const smooth = 'visible\n\nbody';
    // Pretend raw was '[TITLE: x]\nvisible\n\nbody' and offsets in raw past
    // the title get pushed left by 11 (cut length).
    const remap = (raw: number) => Math.max(0, raw - 11);
    const segs = weaveToolCalls(
      smooth,
      smooth.length + 11,
      [tool('a', 11)], // raw offset = 11 (start of 'visible')
      remap,
      { forceFinal: false },
    );
    // Remapped to 0 in smooth → snaps to next \n\n safe boundary at 9.
    expect(texts(segs)).toEqual([smooth.slice(0, 9), smooth.slice(9)]);
    expect(toolIdsByGroup(segs)).toEqual([['a']]);
  });
});

describe('weaveToolCalls — interleaving with text', () => {
  it('produces text/tool/text segments around an inline chip', () => {
    const smooth = 'one\n\ntwo';
    const segs = weaveToolCalls(smooth, smooth.length, [tool('a', 0)], identity, {
      forceFinal: false,
    });
    // Boundary at index 5 (after \n\n).
    expect(segs).toEqual<Segment[]>([
      { kind: 'text', text: 'one\n\n' },
      { kind: 'tool-group', tools: [expect.objectContaining({ id: 'a' })] as ToolCallState[] },
      { kind: 'text', text: 'two' },
    ]);
  });

  it('is a no-op when there are no tools', () => {
    const segs = weaveToolCalls('hello world', 11, [], identity, { forceFinal: false });
    expect(segs).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('returns empty when smoothText is empty and no forceFinal trailing tools', () => {
    const segs = weaveToolCalls('', 0, [], identity, { forceFinal: false });
    expect(segs).toEqual([]);
  });

  it('marks only the rendered text tail for streaming reveal', () => {
    const smooth = 'one\n\ntwo';
    const segs = weaveToolCalls(smooth, smooth.length, [tool('a', 0)], identity, {
      forceFinal: false,
      revealFrom: 6,
    });

    expect(segs).toEqual<Segment[]>([
      { kind: 'text', text: 'one\n\n' },
      { kind: 'tool-group', tools: [expect.objectContaining({ id: 'a' })] as ToolCallState[] },
      { kind: 'text', text: 'two', revealTailChars: 2 },
    ]);
  });
});
