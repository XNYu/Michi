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
  it('tracks an unterminated bold opener', () => {
    const result = scanInline('before **abc');

    expect(markers(result.state)).toEqual(['**']);
    expect(result.carry).toBe('');
    expect(result.state.stack[0].hasContent).toBe(true);
  });

  it('closes bold on the matching marker', () => {
    expect(markers(scanInline('**abc** tail').state)).toEqual([]);
  });

  it('keeps nesting order: bold then italic', () => {
    expect(markers(scanInline('**a *b').state)).toEqual(['**', '*']);
  });

  it('tracks underscore strong, combined emphasis, and strikethrough delimiters', () => {
    expect(markers(scanInline('__bold').state)).toEqual(['__']);
    expect(markers(scanInline('***both').state)).toEqual(['**', '*']);
    expect(markers(scanInline('___both').state)).toEqual(['__', '_']);
    expect(markers(scanInline('~~gone').state)).toEqual(['~~']);
  });

  it('carries a trailing star run that may still grow', () => {
    const italic = scanInline('abc *');
    const bold = scanInline('abc **');

    expect(italic.carry).toBe('*');
    expect(markers(italic.state)).toEqual([]);
    expect(bold.carry).toBe('**');
  });

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

  it('suspends all inline toggles inside a code fence', () => {
    const result = scanInline('```ts\nconst a = **not bold**;\n');

    expect(result.state.inFence).toBe(true);
    expect(markers(result.state)).toEqual([]);
  });

  it('closes a fence only on the matching marker at line start', () => {
    const result = scanInline('```\ncode\n```\nafter **x');

    expect(result.state.inFence).toBe(false);
    expect(markers(result.state)).toEqual(['**']);
  });

  it('carries a trailing backtick run at line start (potential fence)', () => {
    expect(scanInline('text\n``').carry).toBe('``');
  });

  it('treats escaped markers as literal and carries a trailing backslash', () => {
    expect(markers(scanInline('\\**not bold').state)).toEqual(['*']);
    expect(scanInline('abc\\').carry).toBe('\\');
  });

  it('treats a line-start "* " as a list bullet, not italic', () => {
    expect(markers(scanInline('* item one\n* item **two').state)).toEqual(['**']);
  });

  it('treats intra-word underscore as literal (snake_case)', () => {
    expect(markers(scanInline('use snake_case here').state)).toEqual([]);
  });

  it('still toggles flanking underscores', () => {
    expect(markers(scanInline('a _ital').state)).toEqual(['_']);
    expect(markers(scanInline('a _ital_ b').state)).toEqual([]);
  });

  it('suppresses emphasis inside an open code span', () => {
    expect(markers(scanInline('`code **still code').state)).toEqual(['`']);
  });

  it('drops open emphasis at a paragraph break', () => {
    expect(markers(scanInline('**abc\n\nnew para').state)).toEqual([]);
  });

  it('drops open emphasis split across the frame boundary at a paragraph break', () => {
    const first = scanInline('**abc\n');
    const second = scanInline('\nnew', first.state);

    expect(markers(second.state)).toEqual([]);
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
  it('styles inherited-bold chars and hides the real closer', () => {
    const state = computeTailRemend('**ab').endState;
    const result = buildTailSegments('cd** plain', state);

    expect(result.segments).toEqual([
      { text: 'cd', bold: true, italic: false, codeFont: false },
      { text: ' plain', bold: false, italic: false, codeFont: false },
    ]);
    expect(result.carry).toBe('');
  });

  it('withholds a trailing ambiguous star from display', () => {
    const state = computeTailRemend('plain text').endState;
    const result = buildTailSegments('abc *', state);

    expect(result.segments).toEqual([
      { text: 'abc ', bold: false, italic: false, codeFont: false },
    ]);
    expect(result.carry).toBe('*');
  });

  it('hides backticks and switches the content to code font', () => {
    const state = computeTailRemend('run ').endState;
    const { segments } = buildTailSegments('`npm i', state);

    expect(segments.map((segment) => segment.text).join('')).toBe('npm i');
    expect(segments[segments.length - 1]).toEqual({
      text: 'npm i', bold: false, italic: false, codeFont: true,
    });
  });

  it('supports multi-backtick code spans without exposing their delimiters', () => {
    const { segments } = buildTailSegments('``code ` tick', INITIAL_INLINE_STATE);

    expect(segments).toEqual([
      { text: 'code ` tick', bold: false, italic: false, codeFont: true },
    ]);
  });

  it('renders underscore strong and strikethrough styles without markers', () => {
    expect(buildTailSegments('__bold', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'bold', bold: true, italic: false, codeFont: false },
    ]);
    expect(buildTailSegments('~~gone', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'gone', bold: false, italic: false, codeFont: false, strike: true },
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

  it('shows only link or image labels while destinations are incomplete', () => {
    expect(buildTailSegments('[docs](https://example.com/path', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'docs', bold: false, italic: false, codeFont: false },
    ]);
    expect(buildTailSegments('![diagram](https://example.com/a.png', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'diagram', bold: false, italic: false, codeFont: false },
    ]);
  });

  it('removes Markdown escape backslashes from punctuation', () => {
    expect(buildTailSegments('\\*literal\\*', INITIAL_INLINE_STATE).segments).toEqual([
      { text: '*literal*', bold: false, italic: false, codeFont: false },
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

  it('hides fenced-code syntax and styles only its body as code', () => {
    expect(buildTailSegments('```ts\nconst value = 1', INITIAL_INLINE_STATE).segments).toEqual([
      { text: 'const value = 1', bold: false, italic: false, codeFont: true },
    ]);
  });

  it('hides thematic or setext marker-only lines and leading table pipes', () => {
    const thematic = buildTailSegments('---\nnext', INITIAL_INLINE_STATE);
    const table = buildTailSegments('| A | B |', INITIAL_INLINE_STATE);

    expect(thematic.segments.map((segment) => segment.text).join('')).toBe('\nnext');
    expect(table.segments.map((segment) => segment.text).join('')).not.toContain('|');
    expect(table.segments.map((segment) => segment.text).join('')).toContain('A');
    expect(table.segments.map((segment) => segment.text).join('')).toContain('B');
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

  it('renders plain code-font text when the snapshot ended inside a fence', () => {
    const state = computeTailRemend('```ts\nconst a').endState;

    expect(buildTailSegments(' = 1;', state).segments).toEqual([
      { text: ' = 1;', bold: false, italic: false, codeFont: true },
    ]);
  });

  it('consumes the snapshot carry prepended by the caller', () => {
    const remend = computeTailRemend('**abc *');

    expect(buildTailSegments(remend.carry + 'ital', remend.endState).segments).toEqual([
      { text: 'ital', bold: true, italic: true, codeFont: false },
    ]);
  });

  it('drops inherited emphasis immediately after a pending paragraph break', () => {
    const state = computeTailRemend('**snapshot').endState;

    expect(buildTailSegments(' tail\n\nplain', state).segments).toEqual([
      { text: ' tail\n', bold: true, italic: false, codeFont: false },
      { text: '\nplain', bold: false, italic: false, codeFont: false },
    ]);
  });

  it('keeps pending link-destination content hidden', () => {
    const state = computeTailRemend('[docs](https://example.com/').endState;

    expect(buildTailSegments('*raw', state).segments).toEqual([]);
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

  it('falls back to a full scan when pending text is replaced', () => {
    const initial = computeTailRemend('plain ').endState;
    const previous = updateTailSegments(null, 'old *', initial);
    const replaced = updateTailSegments(previous, 'new **bold', initial);

    expect(replaced.segments).toEqual(buildTailSegments('new **bold', initial).segments);
    expect(replaced.text).toBe('new **bold');
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
  it('appends a fake bold closer', () => {
    const result = computeTailRemend('before **abc');

    expect(result.displayText).toBe('before **abc**');
    expect(result.closers).toBe('**');
    expect(result.carry).toBe('');
  });

  it('closes nested delimiters innermost-first', () => {
    expect(computeTailRemend('**a *b').displayText).toBe('**a *b***');
  });

  it('closes an open inline code span', () => {
    expect(computeTailRemend('run `npm i').displayText).toBe('run `npm i`');
  });

  it('closes underscore strong, strikethrough, and math spans', () => {
    expect(computeTailRemend('__bold').displayText).toBe('__bold__');
    expect(computeTailRemend('~~gone').displayText).toBe('~~gone~~');
    expect(computeTailRemend('$x + 1').displayText).toBe('$x + 1$');
  });

  it('withholds a trailing ambiguous delimiter instead of closing it', () => {
    const result = computeTailRemend('**abc *');

    expect(result.carry).toBe('*');
    expect(result.displayText).toBe('**abc **');
    expect(markers(result.endState)).toEqual(['**']);
  });

  it('never fake-closes a code fence', () => {
    const source = '```ts\nconst a = 1;\n';
    const result = computeTailRemend(source);

    expect(result.displayText).toBe(source);
    expect(result.closers).toBe('');
    expect(result.endState.inFence).toBe(true);
  });

  it('keeps a fenced-code suffix literal across a blank line', () => {
    const source = '```ts\nconst a = 1;\n\n**still code';
    const result = computeTailRemend(source);

    expect(result.displayText).toBe(source);
    expect(result.closers).toBe('');
    expect(result.endState.inFence).toBe(true);
  });

  it('remends only the final paragraph semantics after a long balanced prefix', () => {
    const prefix = 'old **balanced** paragraph\n\n'.repeat(100);
    const result = computeTailRemend(`${prefix}tail **bold`);

    expect(result.displayText).toBe(`${prefix}tail **bold**`);
    expect(markers(result.endState)).toEqual(['**']);
  });

  it('trims contentless openers from the display', () => {
    const result = computeTailRemend('x **`');

    expect(result.displayText).toBe('x ');
    expect(result.carry).toBe('**`');
    expect(result.endState.stack).toEqual([]);
  });

  it('is a no-op on plain text', () => {
    const result = computeTailRemend('hello world');

    expect(result.displayText).toBe('hello world');
    expect(result.carry).toBe('');
  });

  it('renders only the label of an incomplete link or image', () => {
    const source = '[docs](https://example.com/*path';
    const result = computeTailRemend(source);

    expect(result.displayText).toBe('docs');
    expect(result.closers).toBe('');
    expect(computeTailRemend('![diagram](https://example.com/a.png').displayText).toBe('diagram');
  });

  it('strips an incomplete raw HTML tag from the snapshot display', () => {
    expect(computeTailRemend('before <custom attr="x"').displayText).toBe('before ');
  });
});
