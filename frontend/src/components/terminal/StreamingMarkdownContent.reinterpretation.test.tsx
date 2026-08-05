import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import StreamingMarkdownContent from './StreamingMarkdownContent';
import { MARKDOWN_REINTERPRET_HZ_STORAGE_KEY } from './markdownReinterpretationFlag';

describe('StreamingMarkdownContent semantic reinterpretation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '1');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.removeItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY);
  });

  it('shows inline semantics immediately while the 1Hz snapshot catches up', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent text="**bo" />,
    );

    rerender(<StreamingMarkdownContent text="**bold**" />);

    expect(container.textContent).toBe('bold');
    expect([...container.querySelectorAll('strong')].map((node) => node.textContent).join('')).toBe('bold');
    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute(
      'data-markdown-snapshot-chars',
    )).toBe('4');

    act(() => vi.advanceTimersByTime(1_000));

    expect(container.textContent).toBe('bold');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute(
      'data-markdown-snapshot-chars',
    )).toBe('8');
  });

  it('keeps a live plain-text tail inside the same paragraph', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent text="hello" revealTailChars={1} />,
    );

    rerender(<StreamingMarkdownContent text="hello world" revealTailChars={1} />);

    const paragraph = container.querySelector('p');
    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(paragraph?.textContent).toBe('hello world');
    expect(tail?.textContent).toBe(' world');
    expect(tail?.parentElement).toBe(paragraph);
    expect(tail?.querySelector('.stream-token-reveal')?.textContent).toBe('d');
  });

  it('places live tails inside the unfinished heading, list item, and table cell', () => {
    const cases = [
      {
        initial: '## Stream',
        complete: '## Streaming',
        selector: 'h2',
        expected: 'Streaming',
      },
      {
        initial: '- first\n- sec',
        complete: '- first\n- second',
        selector: 'li:last-child',
        expected: 'second',
      },
      {
        initial: '| A | B |\n| --- | --- |\n| one | tw',
        complete: '| A | B |\n| --- | --- |\n| one | two',
        selector: 'td:last-child',
        expected: 'two',
      },
    ];

    for (const testCase of cases) {
      const view = render(<StreamingMarkdownContent text={testCase.initial} />);
      view.rerender(<StreamingMarkdownContent text={testCase.complete} />);

      const semanticContainer = view.container.querySelector(testCase.selector);
      const tail = view.container.querySelector('[data-markdown-pending-tail]');
      expect(semanticContainer?.textContent).toBe(testCase.expected);
      expect(tail?.parentElement).toBe(semanticContainer);
      view.unmount();
    }
  });

  it('keeps a live tail on the last visible line of an unfinished code block', () => {
    const initial = '```ts\nconst value';
    const complete = `${initial} = 1`;
    const { container, rerender } = render(
      <StreamingMarkdownContent text={initial} revealTailChars={1} />,
    );

    rerender(<StreamingMarkdownContent text={complete} revealTailChars={1} />);

    const lastCodeLine = container.querySelector('.michi-code-line:last-child');
    const tail = container.querySelector('[data-markdown-pending-tail]');
    expect(lastCodeLine?.textContent).toBe('const value = 1');
    expect(tail?.parentElement).toBe(lastCodeLine);
  });

  it('keeps the live tail visible when the snapshot has no inline container', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent text={'---\n'} />,
    );

    rerender(<StreamingMarkdownContent text={'---\ntail'} />);

    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('[data-markdown-pending-tail]')?.textContent).toBe('tail');
  });

  it('promotes completed blocks without leaving the live tail duplicated in an older block', () => {
    const prefix = '版本一：黑色幽默';
    const complete = `${prefix}\n\n## 《分手这件小事的经济学分析》\n\n林薇算了一笔账。`;
    const { container, rerender } = render(
      <StreamingMarkdownContent text={prefix} />,
    );

    rerender(<StreamingMarkdownContent text={complete} />);
    expect(container.textContent).toBe(complete.replace('## ', ''));
    expect(container.textContent).not.toContain('##');

    act(() => vi.advanceTimersByTime(1_000));

    expect(container.querySelector('h2')?.textContent).toBe('《分手这件小事的经济学分析》');
    expect(container.textContent?.match(/《分手这件小事的经济学分析》/g)).toHaveLength(1);
    expect(container.textContent?.match(/林薇算了一笔账。/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('##');
  });

  it('reinterprets headings, tables, code, and inline emphasis from the latest snapshot', () => {
    const initial = '## He';
    const complete = [
      '## Heading',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | **two** |',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const { container, rerender } = render(
      <StreamingMarkdownContent text={initial} />,
    );

    rerender(<StreamingMarkdownContent text={complete} />);
    act(() => vi.advanceTimersByTime(1_000));

    expect(container.querySelector('h2')?.textContent).toBe('Heading');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('two');
    expect(container.querySelector('[data-michi-code-block]')?.textContent).toContain('const x = 1;');
  });
});
