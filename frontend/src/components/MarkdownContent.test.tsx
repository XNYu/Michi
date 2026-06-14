import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';
import { MARKDOWN_RENDERER_STORAGE_KEY, setMarkdownRendererFlag } from './markdownRendererFlag';

describe('MarkdownContent streaming reveal', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_RENDERER_STORAGE_KEY);
  });

  function newTokenText(container: HTMLElement): string {
    return Array.from(container.querySelectorAll('[data-stream-token-new]'))
      .map((node) => node.textContent)
      .join('');
  }

  it('wraps only newly rendered visible text in reveal spans', () => {
    const { container, rerender } = render(
      <MarkdownContent text="hello" revealTailChars={1} />,
    );

    rerender(<MarkdownContent text="hello **世界**" revealTailChars={1} />);

    expect(newTokenText(container)).toBe('世界');
    expect(container.querySelectorAll('.stream-token-reveal').length).toBeGreaterThan(2);
    expect(container.textContent).toBe('hello 世界');
  });

  it('still reveals newly rendered text under StrictMode double render', () => {
    const { container, rerender } = render(
      <React.StrictMode>
        <MarkdownContent text="hello" revealTailChars={1} />
      </React.StrictMode>,
    );

    rerender(
      <React.StrictMode>
        <MarkdownContent text="hello world" revealTailChars={1} />
      </React.StrictMode>,
    );

    expect(newTokenText(container)).toBe('world');
  });

  it('does not animate text inside code nodes', () => {
    const { container } = render(
      <MarkdownContent text="hello `const x = 1` 世界" revealTailChars={1} />,
    );

    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('const x = 1');
    expect(code?.querySelector('.stream-token-reveal')).toBeNull();
  });

  it('skips block code while revealing prose around it', () => {
    const { container } = render(
      <MarkdownContent text={'before\n\n```ts\nconst x = 1\n```\nafter'} revealTailChars={1} />,
    );

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('.stream-token-reveal')).toBeNull();
    expect(newTokenText(container)).toContain('before');
    expect(newTokenText(container)).toContain('after');
    expect(newTokenText(container)).not.toContain('const');
  });

  it('renders legacy fenced code through the Shiki code block shell', () => {
    const { container } = render(
      <MarkdownContent text={'```ts\nconst x = 1\n```'} />,
    );

    const block = container.querySelector('[data-michi-code-block]');
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-language')).toBe('ts');
    expect(block?.textContent).toContain('const x = 1');
    expect(container.querySelector('.michi-code-copy')).not.toBeNull();
    expect(block?.closest('.prose pre')).toBeNull();
  });

  it('suppresses empty streaming code block shells', () => {
    const { container } = render(
      <MarkdownContent text={'```ts\n'} revealTailChars={1} />,
    );

    expect(container.querySelector('pre')).toBeNull();
  });

  it('keeps an unchanged prefix stable when markdown parsing reshapes the suffix', () => {
    const { container, rerender } = render(
      <MarkdownContent text="hello *w" revealTailChars={1} />,
    );

    rerender(<MarkdownContent text="hello **world**" revealTailChars={1} />);

    expect(newTokenText(container)).toBe('world');
    expect(newTokenText(container)).not.toContain('hello');
  });

  it('can switch to Streamdown through the runtime feature flag', async () => {
    window.localStorage.setItem(MARKDOWN_RENDERER_STORAGE_KEY, 'streamdown');

    const { container } = render(
      <MarkdownContent text="hello **streamdown**" />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-streamdown]')).not.toBeNull();
    });
    expect(container.textContent).toContain('hello streamdown');
  });

  it('responds to renderer flag changes without remounting', async () => {
    const { container } = render(
      <MarkdownContent text="live **switch**" />,
    );

    expect(container.querySelector('[data-streamdown]')).toBeNull();

    setMarkdownRendererFlag('streamdown');

    await waitFor(() => {
      expect(container.querySelector('[data-streamdown]')).not.toBeNull();
    });
    expect(container.textContent).toContain('live switch');
  });
});
