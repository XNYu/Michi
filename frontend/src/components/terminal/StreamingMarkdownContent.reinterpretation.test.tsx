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

  it('keeps the live tail visible when the snapshot has no inline container', () => {
    const { container, rerender } = render(
      <StreamingMarkdownContent text={'---\n'} />,
    );

    rerender(<StreamingMarkdownContent text={'---\ntail'} />);

    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('[data-markdown-pending-tail]')?.textContent).toBe('tail');
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
