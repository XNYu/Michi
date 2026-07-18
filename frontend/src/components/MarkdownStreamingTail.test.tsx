import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import {
  MarkdownStreamingTail,
  MarkdownStreamingTailProvider,
} from './MarkdownStreamingTail';

describe('MarkdownStreamingTail', () => {
  it('animates only the newest tail characters', () => {
    const { container, rerender } = render(
      <MarkdownStreamingTailProvider text="hello" revealTailChars={1}>
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(tail?.textContent).toBe('hello');
    expect(tail?.querySelectorAll('.stream-token-reveal')).toHaveLength(1);
    expect(tail?.querySelector('.stream-token-reveal')?.textContent).toBe('o');

    rerender(
      <MarkdownStreamingTailProvider text="hello!" revealTailChars={1}>
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    expect(tail?.textContent).toBe('hello!');
    expect(tail?.querySelectorAll('.stream-token-reveal')).toHaveLength(1);
    expect(tail?.querySelector('.stream-token-reveal')?.textContent).toBe('!');
  });

  it('does not split a Unicode code point while revealing the suffix', () => {
    const { container } = render(
      <MarkdownStreamingTailProvider text="ok😀" revealTailChars={1}>
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(tail?.textContent).toBe('ok😀');
    expect(tail?.querySelector('.stream-token-reveal')?.textContent).toBe('😀');
  });
});
