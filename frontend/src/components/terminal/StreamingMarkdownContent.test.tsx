import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import StreamingMarkdownContent from './StreamingMarkdownContent';

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock('../MarkdownContent', () => ({
  default: ({ text, revealTailChars }: { text: string; revealTailChars?: number }) => {
    markdownRenderSpy({ text, revealTailChars });
    return <span>{text}</span>;
  },
}));

describe('StreamingMarkdownContent', () => {
  beforeEach(() => {
    markdownRenderSpy.mockClear();
  });

  it('does not re-render stable markdown blocks when only the tail block changes', () => {
    const { rerender } = render(
      <StreamingMarkdownContent text={'alpha\n\nbr'} size="sm" />,
    );

    rerender(<StreamingMarkdownContent text={'alpha\n\nbranch'} size="sm" />);

    const renderedTexts = markdownRenderSpy.mock.calls.map((call) => call[0].text);
    expect(renderedTexts.filter((text) => text === 'alpha')).toHaveLength(1);
    expect(renderedTexts.filter((text) => text === '\n\n')).toHaveLength(1);
    expect(renderedTexts).toContain('br');
    expect(renderedTexts).toContain('branch');
  });

  it('keeps earlier blocks memoized when the tail grows into new blocks', () => {
    const { rerender } = render(
      <StreamingMarkdownContent text={'alpha\n\nbeta'} size="sm" />,
    );

    rerender(<StreamingMarkdownContent text={'alpha\n\nbeta\n\ngamma'} size="sm" />);

    const renderedTexts = markdownRenderSpy.mock.calls.map((call) => call[0].text);
    expect(renderedTexts.filter((text) => text === 'alpha')).toHaveLength(1);
    expect(renderedTexts.filter((text) => text === '\n\n')).toHaveLength(2);
    // The old tail correctly re-renders once because it stops being the last
    // block; blocks before it remain untouched.
    expect(renderedTexts.filter((text) => text === 'beta')).toHaveLength(2);
    expect(renderedTexts.filter((text) => text === 'gamma')).toHaveLength(1);
  });

  it('maps revealTailChars onto only the block that owns the tail', () => {
    const { rerender } = render(
      <StreamingMarkdownContent text={'alpha\n\nbr'} revealTailChars={1} />,
    );

    rerender(<StreamingMarkdownContent text={'alpha\n\nbranch'} revealTailChars={1} />);

    const calls = markdownRenderSpy.mock.calls.map((call) => call[0]);
    expect(calls.filter((call) => call.text === 'alpha' && call.revealTailChars)).toHaveLength(0);
    expect(calls.filter((call) => call.text === '\n\n' && call.revealTailChars)).toHaveLength(0);
    const tailCalls = calls.filter((call) => call.text === 'branch');
    expect(tailCalls).toHaveLength(1);
    expect(tailCalls[0].revealTailChars).toBe(1);
  });
});
