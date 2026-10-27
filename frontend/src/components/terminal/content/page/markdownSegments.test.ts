import { describe, expect, it } from 'vitest';
import { joinMarkdown, parseSegmentId, segmentId, splitMarkdown } from './markdownSegments';

// Segment numbering must remain stable for native Page edits.
const texts = (t: string) => splitMarkdown(t).map((s) => s.text);
const kinds = (t: string) => splitMarkdown(t).map((s) => s.kind);
const noBlank = (t: string) => t.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim()).join('\n');

describe('splitMarkdown', () => {
  it('keeps fenced code one segment, even with blank lines inside', () => {
    const t = 'intro\n\n```ts\nconst a=1;\n\n\nconst b=2;\n```\n\nafter';
    expect(texts(t)).toEqual(['intro', '```ts\nconst a=1;\n\n\nconst b=2;\n```', 'after']);
    expect(kinds(t)).toEqual(['paragraph', 'code', 'paragraph']);
    expect(texts('~~~\na\n\n```\nb\n~~~~\nc')).toEqual(['~~~\na\n\n```\nb\n~~~~', 'c']);
    expect(kinds('```\na\n\nb')).toEqual(['code']);
    expect(kinds('```a`b\n\nc')).toEqual(['paragraph', 'paragraph']);
    expect(texts('```\n# not a heading\n- not a list\n> not a quote\n```'))
      .toEqual(['```\n# not a heading\n- not a list\n> not a quote\n```']);
  });

  it('makes each heading a segment, even without blank lines around it', () => {
    const t = '# Title\nbody line\n## Next\n\n###### Six\n####### seven';
    expect(texts(t)).toEqual(['# Title', 'body line', '## Next', '###### Six', '####### seven']);
    expect(kinds(t)).toEqual(['heading', 'paragraph', 'heading', 'heading', 'paragraph']);
    expect(kinds('#hashtag not a heading')).toEqual(['paragraph']);
  });

  it('splits lists per item and keeps an indented continuation with its item', () => {
    const t = '- one\n- two\n  more of two\n\n  still two after a blank line\n  - nested\n- three\n\n1. a\n2) b\n+ c\n* d';
    expect(texts(t)).toEqual(['- one', '- two\n  more of two\n\n  still two after a blank line\n  - nested', '- three', '1. a', '2) b', '+ c', '* d']);
    expect(kinds(t).every((k) => k === 'list-item')).toBe(true);
    expect(texts('- a\n\nplain\n-b\n-')).toEqual(['- a', 'plain\n-b\n-']);
    expect(kinds('- a\n\nplain')).toEqual(['list-item', 'paragraph']);
    expect(texts('  - a\n  - b')).toEqual(['  - a', '  - b']);
    expect(texts('- run\n  ```\n  x\n\ny\n  ```\n- next')).toEqual(['- run\n  ```\n  x\n\ny\n  ```', '- next']);
  });

  it('groups table rows and quote lines', () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> more\n\ntext\n| after |\n> q2';
    expect(texts(t)).toEqual(['| a | b |\n|---|---|\n| 1 | 2 |', '> quoted\n> more', 'text', '| after |', '> q2']);
    expect(kinds(t)).toEqual(['table', 'quote', 'paragraph', 'table', 'quote']);
    expect(texts('> a\n\n> b\n\n| x |\n\n| y |')).toEqual(['> a', '> b', '| x |', '| y |']);
  });

  it('numbers from zero and finds nothing in blank text', () => {
    expect(splitMarkdown('# a\n\nb\n\n- c').map((s) => s.index)).toEqual([0, 1, 2]);
    for (const t of ['', '  ', '\n\n\n']) expect(splitMarkdown(t)).toEqual([]);
    expect(texts('a\r\nb\r\n\r\n\r\nc')).toEqual(['a\nb', 'c']);
  });

  it('round-trips through joinMarkdown, blank lines aside', () => {
    const t = ['# Plan', 'intro line one', 'intro line two', '', '- a', '- b', '  detail', '', '  detail 2', '1. x', '2. y', '',
      '```js', 'let a;', '', 'let b;', '```', '| h |', '|---|', '| c |', '', '> q1', '> q2', '', 'end'].join('\n');
    expect(noBlank(joinMarkdown(texts(t)))).toBe(noBlank(t));
    expect(joinMarkdown(['a', 'b'])).toBe('a\n\nb');
    expect(joinMarkdown([])).toBe('');
    expect(texts(joinMarkdown(texts(t)))).toEqual(texts(t));
  });
});

describe('segment ids', () => {
  it('round-trips, and plain ids parse to null', () => {
    expect(segmentId('intro', 3)).toBe('intro~3');
    expect(parseSegmentId(segmentId('intro', 3))).toEqual({ blockId: 'intro', index: 3 });
    expect(parseSegmentId(segmentId('b-1.x_y', 0))).toEqual({ blockId: 'b-1.x_y', index: 0 });
    expect(parseSegmentId('a~b~12')).toEqual({ blockId: 'a~b', index: 12 });
    for (const id of ['intro', 'b0', 'a-2', '', '~3', 'a~', 'a~x', 'a~-1', 'a~1.5', 'a~01', 'a~1 ', 'a~99999999999999999999']) {
      expect(parseSegmentId(id), id).toBeNull();
    }
  });
});
