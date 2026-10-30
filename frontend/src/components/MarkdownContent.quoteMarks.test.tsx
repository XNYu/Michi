import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';
import { MarkdownQuoteMarksContext, type MarkdownQuoteMarks } from './markdownQuoteMarks';
import type { MarkdownQuote } from './rehypeQuoteMarks';

function renderMarked(text: string, quotes: MarkdownQuote[]) {
  const marks: MarkdownQuoteMarks = {
    quotes,
    render: (keys, children) => <span className="test-mark" data-keys={keys.join(',')}>{children}</span>,
  };
  const { container } = render(
    <MarkdownQuoteMarksContext.Provider value={marks}>
      <MarkdownContent text={text} />
    </MarkdownQuoteMarksContext.Provider>,
  );
  const found = Array.from(container.querySelectorAll<HTMLElement>('.test-mark'));
  return { container, marks: found, texts: found.map((mark) => mark.textContent) };
}

describe('MarkdownContent quote marks', () => {
  it('marks a selection across emphasis as one span, ignoring how it reports whitespace', () => {
    const { container, marks, texts } = renderMarked(
      'Alpha **beta gamma** delta and\na soft break.',
      [{ key: 'b1', text: 'gamma delta and a soft' }],
    );
    expect(texts).toEqual(['gamma delta and\na soft']);
    // Emphasis is cut at the mark's edge; the visible text is unchanged.
    expect(Array.from(container.querySelectorAll('strong')).map((s) => s.textContent)).toEqual(['beta ', 'gamma']);
    expect(container.textContent).toBe('Alpha beta gamma delta and\na soft break.');
    expect(marks[0].dataset.keys).toBe('b1');
  });

  it('gives a passage across blocks one mark per block, and none to the space between', () => {
    const { container, texts } = renderMarked(
      'First paragraph ends here.\n\n- item one\n- item two\n\nLast.',
      [{ key: 'b1', text: 'ends here.\n\nitem one\nitem' }],
    );
    expect(texts).toEqual(['ends here.', 'item one', 'item']);
    expect(container.querySelectorAll('p > .test-mark, li > .test-mark')).toHaveLength(3);
  });

  it('covers links whole, leaves code blocks alone, and marks only the first occurrence', () => {
    const { container, texts } = renderMarked(
      'See [the guide](https://example.com/guide) now. See again.\n\n```\nSee code\n```',
      [{ key: 'b1', text: 'See the' }, { key: 'b2', text: 'code' }],
    );
    // The mark grows to the whole link instead of splitting it.
    expect(texts).toEqual(['See the guide']);
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('pre .test-mark, [data-michi-code-block] .test-mark')).toBeNull();
  });

  it('merges overlapping quotes into one mark naming both, and ignores quotes not in the text', () => {
    const { marks, texts } = renderMarked(
      'one two three four',
      [{ key: 'b1', text: 'two three' }, { key: 'b2', text: 'three four' }, { key: 'b3', text: 'five' }],
    );
    expect(texts).toEqual(['two three four']);
    expect(marks[0].dataset.keys).toBe('b1,b2');
  });
});
