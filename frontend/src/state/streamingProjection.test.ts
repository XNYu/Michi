import { describe, it, expect } from 'vitest';
import { isAnswerTextStreaming, weaveToolCalls, type Segment } from './streamingProjection';
import type { ChatMessage, ToolCallState } from './chatTypes';

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
});

describe('answer streaming state', () => {
  it('treats a tool boundary as the end of the current answer segment', () => {
    const message: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [{ id: 't1', title: 'tool', status: 'running', textOffset: 4 }],
      blocks: [
        { id: 'a1-b-0', kind: 'answer', rawText: 'text', streaming: false },
        { id: 'a1-b-1', kind: 'tool', toolCallId: 't1', section: 'answer', rawOffset: 4 },
      ],
    };

    expect(isAnswerTextStreaming(message)).toBe(false);
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
