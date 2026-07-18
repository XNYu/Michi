import { describe, expect, it } from 'vitest';
import {
  revealTailCharsForBlock,
  splitStreamingMarkdownBlocks,
  updateStreamingMarkdownBlocks,
  type IncrementalStreamingMarkdownBlockState,
} from './streamingMarkdownBlocks';

function texts(markdown: string): string[] {
  return splitStreamingMarkdownBlocks(markdown).map((block) => block.text);
}

describe('splitStreamingMarkdownBlocks', () => {
  it('splits plain paragraphs at marked block boundaries', () => {
    expect(texts('one\n\ntwo growing')).toEqual(['one', '\n\n', 'two growing']);
  });

  it('keeps closed fenced code as its own block', () => {
    expect(texts('before\n\n```ts\nconst x = 1\n```\n\nafter')).toEqual([
      'before',
      '\n\n',
      '```ts\nconst x = 1\n```',
      '\n\n',
      'after',
    ]);
  });

  it('keeps an open fenced code block as the tail block', () => {
    expect(texts('before\n\n```ts\nconst x = 1')).toEqual([
      'before',
      '\n\n',
      '```ts\nconst x = 1',
    ]);
  });

  it('keeps GFM tables together with their delimiter row', () => {
    expect(texts('| a | b |\n| - | - |\n| 1 | 2 |\n\nnext')).toEqual([
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n',
      'next',
    ]);
  });

  it('keeps setext headings with their underline', () => {
    expect(texts('Title\n---\n\nbody')).toEqual([
      'Title\n---\n\n',
      'body',
    ]);
  });

  it('falls back to one block when footnotes are present', () => {
    const md = 'hello[^a]\n\n[^a]: note\n\nnext';
    expect(texts(md)).toEqual([md]);
  });

  it('merges blocks while an HTML tag remains unclosed', () => {
    const md = '<div>\nhello\n\nworld';
    expect(texts(md)).toEqual([md]);
  });

  it('merges blocks while a math block remains unclosed', () => {
    expect(texts('$$\na+b\n\nstill math')).toEqual(['$$\na+b\n\nstill math']);
    expect(texts('$$\na+b\n$$\n\nnext')).toEqual(['$$\na+b\n$$', '\n\n', 'next']);
  });

  it('tracks source offsets for reveal-tail mapping', () => {
    const blocks = splitStreamingMarkdownBlocks('one\n\ntwo');
    expect(blocks).toEqual([
      { index: 0, text: 'one', start: 0, end: 3 },
      { index: 1, text: '\n\n', start: 3, end: 5 },
      { index: 2, text: 'two', start: 5, end: 8 },
    ]);
    expect(revealTailCharsForBlock(blocks[0], 8, 2)).toBeUndefined();
    expect(revealTailCharsForBlock(blocks[2], 8, 2)).toBe(2);
  });
});

function incrementalSequence(chunks: string[]): IncrementalStreamingMarkdownBlockState[] {
  let markdown = '';
  let state: IncrementalStreamingMarkdownBlockState | null = null;
  return chunks.map((chunk) => {
    markdown += chunk;
    state = updateStreamingMarkdownBlocks(state, markdown);
    expect(state.blocks).toEqual(splitStreamingMarkdownBlocks(markdown));
    return state;
  });
}

describe('updateStreamingMarkdownBlocks', () => {
  it('reuses stable prefix blocks and only reparses the unstable tail', () => {
    const first = updateStreamingMarkdownBlocks(null, 'one\n\ntwo');
    const second = updateStreamingMarkdownBlocks(first, 'one\n\ntwo growing');

    expect(second.parsedFrom).toBe(5);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1]).toBe(first.blocks[1]);
    expect(second.blocks[2]).not.toBe(first.blocks[2]);
    expect(second.blocks).toEqual(splitStreamingMarkdownBlocks(second.markdown));
  });

  it('keeps prior blocks stable when the tail grows into additional blocks', () => {
    const [first, second, third] = incrementalSequence(['one\n\n', 'two', '\n\nthree']);

    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(third.blocks[0]).toBe(second.blocks[0]);
    expect(third.blocks[1]).toBe(second.blocks[1]);
    expect(third.parsedFrom).toBe(5);
  });

  it('reparses tail constructs whose token type changes as text arrives', () => {
    incrementalSequence(['Title\n', '---\n\n', 'body']);
    incrementalSequence(['| a | b |\n', '| - | - |\n', '| 1 | 2 |\n\nnext']);
    incrementalSequence(['before\n\n```ts\n', 'const x = 1\n', '```\n\nafter']);
    incrementalSequence(['$$\na+b\n', '\nstill math', '\n$$\n\nnext']);
    incrementalSequence(['<div>\nhello\n', '\nworld', '\n</div>\n\nafter']);
  });

  it('falls back to a full parse for non-append updates', () => {
    const first = updateStreamingMarkdownBlocks(null, 'one\n\ntwo');
    const replaced = updateStreamingMarkdownBlocks(first, 'changed');

    expect(replaced.parsedFrom).toBe(0);
    expect(replaced.blocks).toEqual(splitStreamingMarkdownBlocks('changed'));
  });

  it('falls back to a full document block when footnotes appear', () => {
    const first = updateStreamingMarkdownBlocks(null, 'hello');
    const markdown = 'hello[^a]\n\n[^a]: note';
    const next = updateStreamingMarkdownBlocks(first, markdown);

    expect(next.parsedFrom).toBe(0);
    expect(next.blocks).toEqual([{ index: 0, text: markdown, start: 0, end: markdown.length }]);
  });

  it('returns the same state for an unchanged source', () => {
    const state = updateStreamingMarkdownBlocks(null, 'unchanged');
    expect(updateStreamingMarkdownBlocks(state, 'unchanged')).toBe(state);
  });
});
