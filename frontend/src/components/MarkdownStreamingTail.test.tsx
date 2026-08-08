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

describe('MarkdownStreamingTail with inline state', () => {
  it('wraps inherited-bold pending chars in strong and hides the closer', () => {
    const remend = computeTailRemend('**ab');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text={'cd** plain'}
        inlineState={remend.endState}
        snapshotCarry={remend.carry}
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(tail?.querySelector('strong')?.textContent).toBe('cd');
    expect(tail?.textContent).toBe('cd plain');
  });

  it('withholds the trailing ambiguous delimiter', () => {
    const remend = computeTailRemend('plain');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text={'abc *'}
        inlineState={remend.endState}
        snapshotCarry=""
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    expect(container.textContent).toBe('abc ');
  });

  it('falls back to the legacy plain span without inline state', () => {
    const { container } = render(
      <MarkdownStreamingTailProvider text={'**raw'}>
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    expect(container.textContent).toBe('**raw');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('still animates revealed suffix chars inside inherited styling', () => {
    const remend = computeTailRemend('**ab');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text="cdef"
        revealTailChars={2}
        inlineState={remend.endState}
        snapshotCarry=""
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    expect(container.querySelectorAll('[data-stream-token-new]')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('cdef');
  });

  it('keeps the stable styled prefix in one text node', () => {
    const remend = computeTailRemend('plain ');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text="abcdefgh"
        revealTailChars={1}
        inlineState={remend.endState}
        snapshotCarry=""
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(tail?.childNodes).toHaveLength(2);
    expect(tail?.firstChild?.textContent).toBe('abcdefg');
  });

  it('uses code font while hiding backtick delimiters', () => {
    const remend = computeTailRemend('run ');
    const { container } = render(
      <MarkdownStreamingTailProvider
        text={'`npm i'}
        inlineState={remend.endState}
        snapshotCarry=""
      >
        <MarkdownStreamingTail />
      </MarkdownStreamingTailProvider>,
    );

    const codeFont = container.querySelector('[style*="--message-code-font"]');
    expect(codeFont?.textContent).toBe('npm i');
    expect(container.textContent).not.toContain('`');
  });

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
