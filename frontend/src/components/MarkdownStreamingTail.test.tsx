import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import {
  MarkdownStreamingTail,
  MarkdownStreamingTailProvider,
} from './MarkdownStreamingTail';
import { computeTailRemend } from '../lib/inlineStreamRemend';

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
});

describe('MarkdownStreamingTail with inline state', () => {
  it('renders strikethrough tail content without exposing tildes', () => {
    const remend = computeTailRemend('plain ');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text="~~removed"
        inlineState={remend.endState}
        snapshotCarry=""
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    expect(container.querySelector('del')?.textContent).toBe('removed');
    expect(container.textContent).not.toContain('~~');
  });
});
