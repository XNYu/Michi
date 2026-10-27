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

  it('restores initial delimiters immediately when following whitespace makes them literal', () => {
    const { container, rerender } = render(<StreamingMarkdownContent text="" />);

    rerender(<StreamingMarkdownContent text="**" />);
    expect(container.textContent).toBe('');

    rerender(<StreamingMarkdownContent text="** " />);
    expect(container.textContent).toBe('** ');
    expect(container.querySelector('strong')).toBeNull();
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
});
