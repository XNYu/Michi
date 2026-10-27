import { describe, expect, it } from 'vitest';
import {
  buildTailSegments,
  computeTailRemend,
  INITIAL_INLINE_STATE,
  scanInline,
  updateTailSegments,
  type InlineStreamState,
} from './inlineStreamRemend';

function markers(state: InlineStreamState): string[] {
  return state.stack.map((delimiter) => delimiter.marker);
}

describe('scanInline', () => {
  it('char-by-char stepping equals one-shot scan', () => {
    const text = 'a **b *c* d** __e__ ~~f~~ `g` _h_ $i$ plain';
    const oneShot = scanInline(text);
    let state = INITIAL_INLINE_STATE;
    let carry = '';
    for (const character of text) {
      const step = scanInline(carry + character, state);
      state = step.state;
      carry = step.carry;
    }

    expect(markers(state)).toEqual(markers(oneShot.state));
    expect(carry).toBe(oneShot.carry);
    expect(state.inFence).toBe(oneShot.state.inFence);
  });

  it('closes a fence only on the matching marker at line start', () => {
    const result = scanInline('```\ncode\n```\nafter **x');

    expect(result.state.inFence).toBe(false);
    expect(markers(result.state)).toEqual(['**']);
  });

  it('treats escaped markers as literal and carries a trailing backslash', () => {
    expect(markers(scanInline('\\**not bold').state)).toEqual(['*']);
    expect(scanInline('abc\\').carry).toBe('\\');
  });

  it('treats intra-word underscore as literal (snake_case)', () => {
    expect(markers(scanInline('use snake_case here').state)).toEqual([]);
  });

  it('suppresses an unfinished link destination across frames', () => {
    const first = scanInline('[docs]');
    const second = scanInline('(https://example.com/*raw', first.state);

    expect(markers(second.state)).toEqual([]);
    expect(second.state.inLinkDestination).toBe(true);
    expect(second.events.map((event) => event.type === 'text' ? event.text : '').join('')).toBe('');
  });

  it('holds incomplete HTML tags while preserving comparisons and autolink labels', () => {
    expect(scanInline('before <cus').carry).toBe('<cus');
    expect(buildTailSegments('2 < 3', INITIAL_INLINE_STATE).segments[0].text).toBe('2 < 3');
    expect(buildTailSegments('<https://example.com>', INITIAL_INLINE_STATE).segments[0].text).toBe(
      'https://example.com',
    );
  });
});

describe('buildTailSegments', () => {
  it('supports multi-backtick code spans without exposing their delimiters', () => {
    const { segments } = buildTailSegments('``code ` tick', INITIAL_INLINE_STATE);

    expect(segments).toEqual([
      { text: 'code ` tick', bold: false, italic: false, codeFont: true },
    ]);
  });

  it('hides math delimiters but leaves currency dollars literal', () => {
    expect(buildTailSegments('$x + 1', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'x + 1', bold: false, italic: false, codeFont: false },
    ]);
    expect(buildTailSegments('cost $5 to $10', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'cost $5 to $10', bold: false, italic: false, codeFont: false },
    ]);
  });

  it('previews block prefixes without exposing their source markers', () => {
    const cases = [
      ['# Heading', 'Heading'],
      ['> quote', '│ quote'],
      ['- item', '• item'],
      ['1) item', '1. item'],
      ['- [ ] todo', '☐ todo'],
      ['- [x] done', '☑ done'],
    ] as const;

    for (const [source, display] of cases) {
      expect(buildTailSegments(source, INITIAL_INLINE_STATE).segments
        .map((segment) => segment.text).join('')).toBe(display);
    }
  });

  it('hides raw HTML tags while leaving their text content visible', () => {
    expect(buildTailSegments('<strong>bold</strong>', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'bold', bold: false, italic: false, codeFont: false },
    ]);
  });

  it('suppresses bold toggles inside an open code span', () => {
    const state = computeTailRemend('start `code').endState;
    const { segments } = buildTailSegments(' **notbold', state);

    expect(segments.every((segment) => !segment.bold)).toBe(true);
  });
});

describe('updateTailSegments', () => {
  it('matches a full rescan across append-only updates and re-feeds carry', () => {
    const initial = computeTailRemend('**snapshot ').endState;
    let incremental = updateTailSegments(null, 'tail *', initial);
    incremental = updateTailSegments(incremental, 'tail **bold', initial);
    incremental = updateTailSegments(incremental, 'tail **bold** plain', initial);

    expect(incremental.segments).toEqual(
      buildTailSegments('tail **bold** plain', initial).segments,
    );
    expect(incremental.carry).toBe('');
  });

  it('resolves task-list syntax correctly when every character is a separate update', () => {
    let state = updateTailSegments(null, '-', INITIAL_INLINE_STATE);
    for (const text of ['- ', '- [', '- [ ', '- [ ]', '- [ ] ', '- [ ] todo']) {
      state = updateTailSegments(state, text, INITIAL_INLINE_STATE);
    }

    expect(state.segments.map((segment) => segment.text).join('')).toBe('☐ todo');
  });

  it('resolves an image opener split after the exclamation mark', () => {
    let state = updateTailSegments(null, '!', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '![', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '![alt](https://example.com/image.png', INITIAL_INLINE_STATE);

    expect(state.segments.map((segment) => segment.text).join('')).toBe('alt');
  });

  it('streams a confirmed autolink label while withholding angle brackets', () => {
    let state = updateTailSegments(null, '<h', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '<https:', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '<https://example.com', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '<https://example.com>', INITIAL_INLINE_STATE);

    expect(state.segments.map((segment) => segment.text).join('')).toBe('https://example.com');
    expect(state.carry).toBe('');
  });

  it('keeps bracket-math delimiters hidden across split closing updates', () => {
    let state = updateTailSegments(null, '\\[', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '\\[x + 1\\', INITIAL_INLINE_STATE);
    state = updateTailSegments(state, '\\[x + 1\\]', INITIAL_INLINE_STATE);

    expect(state.segments.map((segment) => segment.text).join('')).toBe('x + 1');
  });
});

describe('computeTailRemend', () => {
  it('keeps a fenced-code suffix literal across a blank line', () => {
    const source = '```ts\nconst a = 1;\n\n**still code';
    const result = computeTailRemend(source);

    expect(result.displayText).toBe(source);
    expect(result.closers).toBe('');
    expect(result.endState.inFence).toBe(true);
  });

  it('renders only the label of an incomplete link or image', () => {
    const source = '[docs](https://example.com/*path';
    const result = computeTailRemend(source);

    expect(result.displayText).toBe('docs');
    expect(result.closers).toBe('');
    expect(computeTailRemend('![diagram](https://example.com/a.png').displayText).toBe('diagram');
  });
});
