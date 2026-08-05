import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import StreamingMarkdownContent from './StreamingMarkdownContent';
import { MARKDOWN_REMEND_STORAGE_KEY } from './markdownRemendFlag';
import { MARKDOWN_REINTERPRET_HZ_STORAGE_KEY } from './markdownReinterpretationFlag';

describe('StreamingMarkdownContent remend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '3');
    window.localStorage.removeItem(MARKDOWN_REMEND_STORAGE_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.removeItem(MARKDOWN_REMEND_STORAGE_KEY);
    window.localStorage.removeItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY);
  });

  it('withholds opening bold delimiters before the first semantic snapshot', () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="*" />);
    expect(container.textContent).toBe('');

    rerender(<StreamingMarkdownContent text="**" />);
    expect(container.textContent).toBe('');

    rerender(<StreamingMarkdownContent text="**a" />);
    expect(container.textContent).toBe('a');
    expect(container.querySelector('strong')?.textContent).toBe('a');
    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute(
      'data-markdown-snapshot-chars',
    )).toBe('0');
  });

  it('restores initial delimiters immediately when following whitespace makes them literal', () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="**" />);
    expect(container.textContent).toBe('');

    rerender(<StreamingMarkdownContent text="** " />);
    expect(container.textContent).toBe('** ');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('replaces an initial list marker with a semantic bullet once its space arrives', () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="*" />);
    expect(container.textContent).toBe('');

    rerender(<StreamingMarkdownContent text="* item" />);
    expect(container.textContent).toBe('• item');
    expect(container.querySelector('em')).toBeNull();
  });

  it('does not delay ordinary text before the first semantic snapshot', () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="a" />);
    expect(container.textContent).toBe('a');

    rerender(<StreamingMarkdownContent text="abcd" />);
    expect(container.textContent).toBe('abcd');
  });

  it.each([
    { source: '__bold', text: 'bold', selector: 'strong' },
    { source: '~~removed', text: 'removed', selector: 'del' },
    { source: '`code', text: 'code', selector: '[style*="--message-code-font"]' },
    { source: '# Heading', text: 'Heading', selector: null },
    { source: '> quote', text: '│ quote', selector: null },
    { source: '- item', text: '• item', selector: null },
    { source: '- [ ] todo', text: '☐ todo', selector: null },
    { source: '[docs](https://example.com/path', text: 'docs', selector: null },
    { source: '$x + 1', text: 'x + 1', selector: null },
  ])('previews $source without leaking its Markdown markers', ({ source, text, selector }) => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text={source} />);

    expect(container.textContent).toBe(text);
    if (selector) expect(container.querySelector(selector)?.textContent).toBe(text);
  });

  it('styles an unterminated bold tail immediately and after the next snapshot', async () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="hello " />);

    rerender(<StreamingMarkdownContent text="hello **bold words" />);

    expect(container.querySelector('strong')?.textContent).toContain('bold words');
    expect(container.textContent).not.toContain('**');

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(container.querySelector('strong')?.textContent).toContain('bold words');
    expect(container.textContent).not.toContain('**');
  });

  it('kill switch restores literal markers', async () => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, '0');
    const { container, rerender } = render(<StreamingMarkdownContent text="hello " />);

    rerender(<StreamingMarkdownContent text="hello **bold words" />);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(container.textContent).toContain('**bold words');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('kill switch also preserves initial delimiters before the first snapshot', () => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, '0');
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="**a" />);

    expect(container.textContent).toBe('**a');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('keeps the zero-Hz legacy path unchanged', () => {
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '0');

    const { container } = render(<StreamingMarkdownContent text="hello **bold words" />);

    expect(container.textContent).toContain('**bold words');
    expect(container.querySelector('strong')).toBeNull();
  });
});
