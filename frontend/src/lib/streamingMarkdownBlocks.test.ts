import { describe, expect, it } from 'vitest';
import { splitStreamingMarkdownBlocks, updateStreamingMarkdownBlocks, type IncrementalStreamingMarkdownBlockState } from './streamingMarkdownBlocks';

function texts(markdown: string): string[] {
  return splitStreamingMarkdownBlocks(markdown).map((block) => block.text);
}

describe('splitStreamingMarkdownBlocks', () => {
  it('keeps semantic kinds for prose spacing, including setext headings', () => {
    const blocks = splitStreamingMarkdownBlocks('Title\n---\n\n- one\n- two\n\n| a |\n| - |\n| b |\n\nbody');
    expect(blocks.filter(block => block.kind !== 'space').map(block => block.kind))
      .toEqual(['heading', 'list', 'table', 'other']);
  });

  it('merges blocks while an HTML tag remains unclosed', () => {
    const md = '<div>\nhello\n\nworld';
    expect(texts(md)).toEqual([md]);
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
  it('reparses tail constructs whose token type changes as text arrives', () => {
    incrementalSequence(['Title\n', '---\n\n', 'body']);
    incrementalSequence(['| a | b |\n', '| - | - |\n', '| 1 | 2 |\n\nnext']);
    incrementalSequence(['before\n\n```ts\n', 'const x = 1\n', '```\n\nafter']);
    incrementalSequence(['$$\na+b\n', '\nstill math', '\n$$\n\nnext']);
    incrementalSequence(['<div>\nhello\n', '\nworld', '\n</div>\n\nafter']);
  });

  it('falls back to a full document block when footnotes appear', () => {
    const first = updateStreamingMarkdownBlocks(null, 'hello');
    const markdown = 'hello[^a]\n\n[^a]: note';
    const next = updateStreamingMarkdownBlocks(first, markdown);

    expect(next.parsedFrom).toBe(0);
    expect(next.blocks).toEqual([{ index: 0, text: markdown, start: 0, end: markdown.length, kind: 'other' }]);
  });

  it('returns the same state for an unchanged source', () => {
    const state = updateStreamingMarkdownBlocks(null, 'unchanged');
    expect(updateStreamingMarkdownBlocks(state, 'unchanged')).toBe(state);
  });
});
