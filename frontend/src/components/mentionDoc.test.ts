import { describe, it, expect } from 'vitest';
import { docToDraft, draftToDoc, type PMNode } from './mentionDoc';
import type { MentionRecord } from './mentions';

const ctx = (label: string, start: number, refId = label): MentionRecord => ({
  start,
  end: start + 1 + label.length,
  kind: 'context',
  refId,
  label,
});

// ---- inline markdown marks (bold/italic/strike/code) ----
// The composer renders marks WYSIWYG; the wire format `{ value, mentions }` is
// a markdown string. docToDraft re-emits the markers the input rules consumed;
// draftToDoc parses them back so a restored draft renders marks again.

const t = (text: string, ...marks: string[]): PMNode =>
  marks.length ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) as never } : { type: 'text', text };
const para = (...content: PMNode[]): PMNode => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

describe('docToDraft serializes marks back to markdown syntax', () => {
  it('expels trailing whitespace out of the closing marker', () => {
    expect(docToDraft(para(t('bold ', 'bold'), t('x'))).value).toBe('**bold** x');
  });
  it('whitespace-only marked text emits no empty marker pair', () => {
    expect(docToDraft(para(t('a'), t(' ', 'bold'), t('b'))).value).toBe('a b');
  });
  it('code content containing a backtick gets a longer fence', () => {
    expect(docToDraft(para(t('a`b', 'code'))).value).toBe('``a`b``');
  });
});
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const bulletList = (...items: PMNode[]): PMNode => ({ type: 'bulletList', content: items });
const li = (...content: PMNode[]): PMNode => ({ type: 'listItem', content });
const br: PMNode = { type: 'hardBreak' };

describe('draftToDoc parses block markdown into block nodes', () => {
  const blocks = (value: string, mentions: MentionRecord[] = []) => draftToDoc(value, mentions).content!;
  it('indented continuation joins the item paragraph', () => {
    expect(blocks('- a\n  b')).toEqual([bulletList(li(p(t('a'), br, t('b'))))]);
  });
});

describe('markdown values are wire-stable through draft -> doc -> draft', () => {
  const cases: { name: string; value: string; mentions: MentionRecord[] }[] = [
    { name: 'bold', value: 'hello **bold** world', mentions: [] },
    { name: 'nested', value: '**bold *italic* bold**', mentions: [] },
    { name: 'code + bold', value: 'run `rm -rf /tmp` then **confirm**', mentions: [] },
    { name: 'unbalanced stays put', value: '**oops and *also', mentions: [] },
    { name: 'literal asterisk math', value: '2*3*4 and a * b', mentions: [] },
    { name: 'padded code span', value: 'a ` x ` b', mentions: [] },
    {
      name: 'marks around mention',
      value: '~~old~~ @michi *new*',
      mentions: [ctx('michi', 8)],
    },
    {
      name: 'markers spanning a mention',
      value: '**bold @michi bold**',
      mentions: [ctx('michi', 7)],
    },
    { name: 'markdown across newline', value: '**a**\n`b`', mentions: [] },
    { name: 'heading + body', value: '# Title\nbody', mentions: [] },
    { name: 'nested bullets', value: '- a\n  - b\n- c', mentions: [] },
    { name: 'ordered from 3', value: '3. a\n4. b', mentions: [] },
    { name: 'non-sequential numbers', value: '1. a\n5. b', mentions: [] },
    { name: 'quote lines', value: '> q1\n> q2', mentions: [] },
    { name: 'list inside quote', value: '> - a', mentions: [] },
    { name: 'code fence', value: '```js\nconst x = 1;\nx++\n```', mentions: [] },
    { name: 'unclosed fence', value: '```\nunclosed', mentions: [] },
    { name: 'star bullet stays literal', value: '* not a list', mentions: [] },
    { name: 'hash without space', value: '#nospace', mentions: [] },
    { name: 'orphan indent', value: '  - b', mentions: [] },
    { name: 'blank line between lists', value: '- a\n\n- b', mentions: [] },
    {
      name: 'mixed blocks',
      value: 'intro\n- one\n- two\n```sh\nx\n```\noutro',
      mentions: [],
    },
    {
      name: 'mention in a list item',
      value: '- ping @michi now',
      mentions: [ctx('michi', 7)],
    },
    {
      name: 'mention inside a fence stays literal lines',
      value: '```\n@michi\n```',
      mentions: [ctx('michi', 4)],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const round = docToDraft(draftToDoc(c.value, c.mentions));
      expect(round.value).toBe(c.value);
      expect(round.mentions).toEqual([...c.mentions].sort((a, b) => a.start - b.start));
    });
  }
});
