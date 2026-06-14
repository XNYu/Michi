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
const node = (label: string, start: number, refId: string): MentionRecord => ({
  start,
  end: start + 1 + label.length,
  kind: 'node',
  refId,
  label,
});

describe('mentionDoc round-trip (draft -> doc -> draft)', () => {
  const cases: { name: string; value: string; mentions: MentionRecord[] }[] = [
    { name: 'plain text', value: 'hello world', mentions: [] },
    { name: 'empty', value: '', mentions: [] },
    { name: 'newlines (Shift+Enter)', value: 'a\nb\nc', mentions: [] },
    {
      name: 'single context mention',
      value: 'review @michi please',
      mentions: [ctx('michi', 7)],
    },
    {
      name: 'two mentions, mixed kinds',
      value: 'ping @michi and @thread',
      mentions: [ctx('michi', 5), node('thread', 16, 'node-abc')],
    },
    {
      name: 'mention then newline then mention',
      value: '@a\nmid @b',
      mentions: [ctx('a', 0), ctx('b', 7)],
    },
    {
      name: 'mention at very end',
      value: 'cc @opus',
      mentions: [ctx('opus', 3)],
    },
    {
      name: 'CJK around a mention',
      value: '请 review @michi 的改动\n第二行',
      mentions: [ctx('michi', 9)],
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

describe('mentionDoc serialization details', () => {
  it('mention offsets cover exactly the @label span', () => {
    const doc = draftToDoc('x @michi y', [ctx('michi', 2)]);
    const { value, mentions } = docToDraft(doc);
    expect(value).toBe('x @michi y');
    expect(value.slice(mentions[0].start, mentions[0].end)).toBe('@michi');
  });

  it('preserves node refId distinct from label', () => {
    const { mentions } = docToDraft(draftToDoc('see @My Thread', [node('My Thread', 4, 'node-xyz')]));
    expect(mentions[0]).toMatchObject({ kind: 'node', refId: 'node-xyz', label: 'My Thread' });
  });

  it('joins multiple paragraphs with newlines (paste tolerance)', () => {
    const multiPara: PMNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line1' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'line2' }] },
      ],
    };
    expect(docToDraft(multiPara).value).toBe('line1\nline2');
  });

  it('draftToDoc drops the literal @label text in favour of an atomic node', () => {
    const doc = draftToDoc('hi @michi', [ctx('michi', 3)]);
    const inlines = doc.content![0].content!;
    // text "hi ", then a mention node — never a literal "@michi" text node.
    expect(inlines.find((n) => n.type === 'text' && n.text === '@michi')).toBeUndefined();
    expect(inlines.some((n) => n.type === 'mention')).toBe(true);
  });
});

// ---- inline markdown marks (bold/italic/strike/code) ----
// The composer renders marks WYSIWYG; the wire format `{ value, mentions }` is
// a markdown string. docToDraft re-emits the markers the input rules consumed;
// draftToDoc parses them back so a restored draft renders marks again.

const t = (text: string, ...marks: string[]): PMNode =>
  marks.length ? { type: 'text', text, marks: marks.map((m) => ({ type: m })) as never } : { type: 'text', text };
const para = (...content: PMNode[]): PMNode => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const mention = (label: string, ...marks: string[]): PMNode => ({
  type: 'mention',
  attrs: { refId: label, label, kind: 'context' },
  ...(marks.length ? { marks: marks.map((m) => ({ type: m })) as never } : {}),
});

describe('docToDraft serializes marks back to markdown syntax', () => {
  it('bold', () => {
    expect(docToDraft(para(t('hello '), t('bold', 'bold'), t(' world'))).value).toBe('hello **bold** world');
  });
  it('italic', () => {
    expect(docToDraft(para(t('a '), t('it', 'italic'), t(' b'))).value).toBe('a *it* b');
  });
  it('strike', () => {
    expect(docToDraft(para(t('gone', 'strike'))).value).toBe('~~gone~~');
  });
  it('code', () => {
    expect(docToDraft(para(t('x '), t('rm -rf /tmp', 'code'))).value).toBe('x `rm -rf /tmp`');
  });
  it('nested bold+italic emits minimal transitions', () => {
    const doc = para(t('bold ', 'bold'), t('italic', 'bold', 'italic'), t(' bold', 'bold'));
    expect(docToDraft(doc).value).toBe('**bold *italic* bold**');
  });
  it('expels trailing whitespace out of the closing marker', () => {
    expect(docToDraft(para(t('bold ', 'bold'), t('x'))).value).toBe('**bold** x');
  });
  it('expels leading whitespace out of the opening marker', () => {
    expect(docToDraft(para(t('x '), t(' bold', 'bold'))).value).toBe('x  **bold**');
  });
  it('closes marks across hardBreak and reopens after', () => {
    const doc = para(t('a', 'bold'), { type: 'hardBreak' }, t('b', 'bold'));
    expect(docToDraft(doc).value).toBe('**a**\n**b**');
  });
  it('whitespace-only marked text emits no empty marker pair', () => {
    expect(docToDraft(para(t('a'), t(' ', 'bold'), t('b'))).value).toBe('a b');
  });
  it('code content containing a backtick gets a longer fence', () => {
    expect(docToDraft(para(t('a`b', 'code'))).value).toBe('``a`b``');
  });
  it('unknown marks (link/underline) pass through as plain text', () => {
    expect(docToDraft(para(t('u', 'underline'), t('l', 'link'))).value).toBe('ul');
  });
  it('mention inside a bold run keeps offsets on the @label span', () => {
    const doc = para(t('see ', 'bold'), mention('michi', 'bold'), t(' now', 'bold'));
    const { value, mentions } = docToDraft(doc);
    expect(value).toBe('**see @michi now**');
    expect(value.slice(mentions[0].start, mentions[0].end)).toBe('@michi');
  });
});

describe('draftToDoc parses inline markdown into marks', () => {
  const inlines = (value: string, mentions: MentionRecord[] = []) =>
    draftToDoc(value, mentions).content![0].content!;

  it('bold', () => {
    expect(inlines('**bold**')).toEqual([t('bold', 'bold')]);
  });
  it('italic mid-sentence', () => {
    expect(inlines('hello *it* x')).toEqual([t('hello '), t('it', 'italic'), t(' x')]);
  });
  it('strike', () => {
    expect(inlines('~~x~~')).toEqual([t('x', 'strike')]);
  });
  it('nested bold+italic', () => {
    expect(inlines('**bold *it* bold**')).toEqual([
      t('bold ', 'bold'),
      t('it', 'bold', 'italic'),
      t(' bold', 'bold'),
    ]);
  });
  it('code span keeps inner content literal', () => {
    expect(inlines('`code **x**`')).toEqual([t('code **x**', 'code')]);
  });
  it('unbalanced markers stay literal', () => {
    expect(inlines('**oops')).toEqual([t('**oops')]);
  });
  it('space-flanked asterisks stay literal', () => {
    expect(inlines('a * b * c')).toEqual([t('a * b * c')]);
  });
  it('empty marker pair stays literal', () => {
    expect(inlines('****')).toEqual([t('****')]);
  });
  it('marks alongside mentions', () => {
    const got = inlines('**bold** @michi *it*', [ctx('michi', 9)]);
    expect(got).toEqual([
      t('bold', 'bold'),
      t(' '),
      { type: 'mention', attrs: { refId: 'michi', label: 'michi', kind: 'context' } },
      t(' '),
      t('it', 'italic'),
    ]);
  });
  it('markers spanning a mention stay literal (atomic boundary)', () => {
    const got = inlines('**bold @michi bold**', [ctx('michi', 7)]);
    expect(got).toEqual([
      t('**bold '),
      { type: 'mention', attrs: { refId: 'michi', label: 'michi', kind: 'context' } },
      t(' bold**'),
    ]);
  });
  it('marks across hardBreak lines', () => {
    expect(inlines('**a**\n**b**')).toEqual([t('a', 'bold'), { type: 'hardBreak' }, t('b', 'bold')]);
  });
});

// Block-node helpers for the serializer tests below.
const blockDoc = (...blocks: PMNode[]): PMNode => ({ type: 'doc', content: blocks });
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const heading = (level: number, ...content: PMNode[]): PMNode => ({
  type: 'heading',
  attrs: { level },
  content,
});
const codeBlock = (text: string, language: string | null = null): PMNode => ({
  type: 'codeBlock',
  attrs: { language },
  content: text ? [{ type: 'text', text }] : [],
});
const blockquote = (...content: PMNode[]): PMNode => ({ type: 'blockquote', content });
const bulletList = (...items: PMNode[]): PMNode => ({ type: 'bulletList', content: items });
const orderedList = (start: number, ...items: PMNode[]): PMNode => ({
  type: 'orderedList',
  attrs: { start },
  content: items,
});
const li = (...content: PMNode[]): PMNode => ({ type: 'listItem', content });
const br: PMNode = { type: 'hardBreak' };

describe('docToDraft serializes block nodes to markdown', () => {
  it('heading levels', () => {
    expect(docToDraft(blockDoc(heading(1, t('Title')), p(t('body')))).value).toBe('# Title\nbody');
    expect(docToDraft(blockDoc(heading(3, t('deep')))).value).toBe('### deep');
  });
  it('inline marks inside a heading', () => {
    expect(docToDraft(blockDoc(heading(2, t('a '), t('b', 'bold')))).value).toBe('## a **b**');
  });
  it('bullet list', () => {
    expect(docToDraft(blockDoc(bulletList(li(p(t('a'))), li(p(t('b')))))).value).toBe('- a\n- b');
  });
  it('ordered list honours start attr', () => {
    expect(docToDraft(blockDoc(orderedList(3, li(p(t('a'))), li(p(t('b')))))).value).toBe('3. a\n4. b');
  });
  it('nested bullet list indents by two spaces', () => {
    const doc = blockDoc(bulletList(li(p(t('a')), bulletList(li(p(t('b')))))));
    expect(docToDraft(doc).value).toBe('- a\n  - b');
  });
  it('hardBreak inside a list item becomes an indented continuation line', () => {
    expect(docToDraft(blockDoc(bulletList(li(p(t('a'), br, t('b')))))).value).toBe('- a\n  b');
  });
  it('blockquote prefixes every line', () => {
    expect(docToDraft(blockDoc(blockquote(p(t('q1')), p(t('q2'))))).value).toBe('> q1\n> q2');
    expect(docToDraft(blockDoc(blockquote(p(t('a'), br, t('b'))))).value).toBe('> a\n> b');
  });
  it('code block with language', () => {
    expect(docToDraft(blockDoc(codeBlock('const x = 1;\nx++', 'js'))).value).toBe(
      '```js\nconst x = 1;\nx++\n```',
    );
  });
  it('code block without language', () => {
    expect(docToDraft(blockDoc(codeBlock('plain'))).value).toBe('```\nplain\n```');
  });
  it('code block containing a fence line gets a longer fence', () => {
    expect(docToDraft(blockDoc(codeBlock('a\n```\nb'))).value).toBe('````\na\n```\nb\n````');
  });
  it('code block inline marks are not parsed (literal text)', () => {
    expect(docToDraft(blockDoc(codeBlock('**not bold**'))).value).toBe('```\n**not bold**\n```');
  });
  it('mention inside a list item keeps offsets', () => {
    const doc = blockDoc(bulletList(li(p(t('see '), mention('michi')))));
    const { value, mentions } = docToDraft(doc);
    expect(value).toBe('- see @michi');
    expect(value.slice(mentions[0].start, mentions[0].end)).toBe('@michi');
  });
  it('mention inside a heading keeps offsets', () => {
    const { value, mentions } = docToDraft(blockDoc(heading(1, mention('michi'))));
    expect(value).toBe('# @michi');
    expect(value.slice(mentions[0].start, mentions[0].end)).toBe('@michi');
  });
  it('mixed document', () => {
    const doc = blockDoc(
      p(t('intro')),
      bulletList(li(p(t('one'))), li(p(t('two')))),
      codeBlock('x', 'sh'),
      p(t('outro')),
    );
    expect(docToDraft(doc).value).toBe('intro\n- one\n- two\n```sh\nx\n```\noutro');
  });
});

describe('draftToDoc parses block markdown into block nodes', () => {
  const blocks = (value: string, mentions: MentionRecord[] = []) => draftToDoc(value, mentions).content!;

  it('heading + body paragraph', () => {
    expect(blocks('# Title\nbody')).toEqual([
      heading(1, t('Title')),
      p(t('body')),
    ]);
  });
  it('heading with inline marks', () => {
    expect(blocks('## a **b**')).toEqual([heading(2, t('a '), t('b', 'bold'))]);
  });
  it('hash without space stays literal', () => {
    expect(blocks('#nospace')).toEqual([p(t('#nospace'))]);
  });
  it('seven hashes stay literal', () => {
    expect(blocks('####### x')).toEqual([p(t('####### x'))]);
  });
  it('bullet list', () => {
    expect(blocks('- a\n- b')).toEqual([bulletList(li(p(t('a'))), li(p(t('b'))))]);
  });
  it('star bullets stay literal (serializer only emits "- ")', () => {
    expect(blocks('* a')).toEqual([p(t('* a'))]);
  });
  it('ordered list with start', () => {
    expect(blocks('3. a\n4. b')).toEqual([orderedList(3, li(p(t('a'))), li(p(t('b'))))]);
  });
  it('nested bullet list', () => {
    expect(blocks('- a\n  - b')).toEqual([
      bulletList(li(p(t('a')), bulletList(li(p(t('b')))))),
    ]);
  });
  it('indented continuation joins the item paragraph', () => {
    expect(blocks('- a\n  b')).toEqual([bulletList(li(p(t('a'), br, t('b'))))]);
  });
  it('orphan indented bullet stays literal', () => {
    expect(blocks('  - b')).toEqual([p(t('  - b'))]);
  });
  it('blockquote lines group into one quote', () => {
    expect(blocks('> q1\n> q2')).toEqual([blockquote(p(t('q1'), br, t('q2')))]);
  });
  it('blockquote can contain a list', () => {
    expect(blocks('> - a')).toEqual([blockquote(bulletList(li(p(t('a')))))]);
  });
  it('code fence with language', () => {
    expect(blocks('```js\nconst x = 1;\n```')).toEqual([codeBlock('const x = 1;', 'js')]);
  });
  it('longer fence may contain a shorter one', () => {
    expect(blocks('````\na\n```\nb\n````')).toEqual([codeBlock('a\n```\nb')]);
  });
  it('unclosed fence stays literal', () => {
    expect(blocks('```\nunclosed')).toEqual([p(t('```'), br, t('unclosed'))]);
  });
  it('fence containing a mention is not a code block', () => {
    expect(blocks('```\n@michi\n```', [ctx('michi', 4)])).toEqual([
      p(
        t('```'),
        br,
        { type: 'mention', attrs: { refId: 'michi', label: 'michi', kind: 'context' } },
        br,
        t('```'),
      ),
    ]);
  });
  it('mention inside a list item', () => {
    expect(blocks('- see @michi', [ctx('michi', 6)])).toEqual([
      bulletList(
        li(p(t('see '), { type: 'mention', attrs: { refId: 'michi', label: 'michi', kind: 'context' } })),
      ),
    ]);
  });
  it('inline code inside a list item', () => {
    expect(blocks('- `x`')).toEqual([bulletList(li(p(t('x', 'code'))))]);
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
