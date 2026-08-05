import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import StreamingMarkdownContent from './StreamingMarkdownContent';
import { MARKDOWN_REINTERPRET_HZ_STORAGE_KEY } from './markdownReinterpretationFlag';

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock('../MarkdownContent', async () => {
  const { MarkdownStreamingTail } = await vi.importActual<
    typeof import('../MarkdownStreamingTail')
  >('../MarkdownStreamingTail');
  return {
    default: ({
      text,
      revealTailChars,
      appendStreamingTail,
    }: {
      text: string;
      revealTailChars?: number;
      appendStreamingTail?: boolean;
    }) => {
      markdownRenderSpy({ text, revealTailChars });
      return (
        <span>
          {text}
          {appendStreamingTail ? <MarkdownStreamingTail /> : null}
        </span>
      );
    },
  };
});

describe('StreamingMarkdownContent', () => {
  beforeEach(() => {
    markdownRenderSpy.mockClear();
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '0');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.removeItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY);
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

  it('keeps visible text moving while Markdown reinterpretation is limited to 1Hz', () => {
    vi.useFakeTimers();
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '1');
    const { container, rerender } = render(
      <StreamingMarkdownContent text="hello" revealTailChars={1} />,
    );

    rerender(<StreamingMarkdownContent text="hello world" revealTailChars={1} />);

    expect(container.textContent).toBe('hello world');
    expect(container.querySelector('[data-markdown-pending-tail]')?.textContent).toBe(' world');
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello']);

    act(() => vi.advanceTimersByTime(999));
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello']);

    act(() => vi.advanceTimersByTime(1));
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello', 'hello world']);
    expect(container.querySelector('[data-markdown-pending-tail]')).toBeNull();
    expect(container.textContent).toBe('hello world');
  });

  it('immediately reinterprets non-append replacements', () => {
    vi.useFakeTimers();
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '1');
    const { rerender } = render(<StreamingMarkdownContent text="hello" />);

    rerender(<StreamingMarkdownContent text="replacement" />);

    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello', 'replacement']);
  });

  it('reinterprets adaptive snapshots at Markdown structure boundaries', () => {
    vi.useFakeTimers();
    const strategy = { mode: 'adaptive', maxIntervalMs: 1_000 } as const;
    const { rerender } = render(
      <StreamingMarkdownContent text="hello" reinterpretStrategy={strategy} />,
    );

    rerender(<StreamingMarkdownContent text="hello world" reinterpretStrategy={strategy} />);
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello']);

    rerender(<StreamingMarkdownContent text={'hello world\n\n'} reinterpretStrategy={strategy} />);
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual([
      'hello',
      'hello world',
      '\n\n',
    ]);
  });

  it('caps adaptive semantic lag at its maximum interval', () => {
    vi.useFakeTimers();
    const strategy = { mode: 'adaptive', maxIntervalMs: 1_000 } as const;
    const { rerender } = render(
      <StreamingMarkdownContent text="hello" reinterpretStrategy={strategy} />,
    );

    rerender(<StreamingMarkdownContent text="hello world" reinterpretStrategy={strategy} />);
    act(() => vi.advanceTimersByTime(999));
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello']);

    act(() => vi.advanceTimersByTime(1));
    expect(markdownRenderSpy.mock.calls.map((call) => call[0].text)).toEqual(['hello', 'hello world']);
  });
});
