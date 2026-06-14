import { describe, expect, it } from 'vitest';
import {
  revealTailCharsForBlock,
  splitStreamingMarkdownBlocks,
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
