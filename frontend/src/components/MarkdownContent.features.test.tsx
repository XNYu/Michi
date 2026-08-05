import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownContent, { type MarkdownFeatureProfile } from './MarkdownContent';

const { mermaidRenderSpy } = vi.hoisted(() => ({
  mermaidRenderSpy: vi.fn(async () => ({ svg: '<svg><text>diagram</text></svg>' })),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: mermaidRenderSpy,
  },
}));

const features: MarkdownFeatureProfile = {
  autoDirection: true,
  cjk: true,
  codeDownload: true,
  codeLineNumbers: true,
  linkSafety: true,
  normalizeHtmlIndentation: true,
  strikethrough: true,
  tableControls: true,
};

describe('MarkdownContent optional Streamdown-parity features', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders CJK-adjacent emphasis and strikethrough semantically', () => {
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'**该强调包含句号。**这是后文。\n\n~~该删除线包含句号。~~这是后文。'}
      />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('该强调包含句号。');
    expect(container.querySelector('del')?.textContent).toBe('该删除线包含句号。');
  });

  it('adds automatic direction, code line numbers/download, and table controls', () => {
    const markdown = [
      'مرحبا بالعالم',
      '',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
    ].join('\n');
    const { container } = render(<MarkdownContent features={features} text={markdown} />);

    expect(container.querySelector('.prose')?.getAttribute('dir')).toBe('auto');
    expect(container.querySelectorAll('[data-line-number]')).toHaveLength(2);
    expect(container.querySelector('[data-michi-code-download]')).not.toBeNull();
    expect(container.querySelector('[data-michi-table-controls]')).not.toBeNull();
    expect(container.querySelectorAll('[data-michi-table-controls] button')).toHaveLength(3);
  });

  it('asks before opening external links when link safety is enabled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = render(
      <MarkdownContent features={features} text="[external](https://example.com/path)" />,
    );
    const anchor = container.querySelector('a')!;

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(confirm).toHaveBeenCalledWith('Open external link?\nhttps://example.com/path');
    expect(event.defaultPrevented).toBe(true);
  });

  it('normalizes indented raw HTML instead of turning it into a code block', () => {
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'<div>\n    <strong>normalized</strong>\n</div>'}
      />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('normalized');
    expect(container.querySelector('.michi-code-block')).toBeNull();
  });

  it('keeps table control clicks local to the rendered table', () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard },
    });
    const { container } = render(
      <MarkdownContent
        features={features}
        text={'| A | B |\n| --- | --- |\n| one | two |'}
      />,
    );

    fireEvent.click(container.querySelector('[aria-label="Copy table"]')!);
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0][0]).toContain('| A | B |');
  });

  it('renders completed Mermaid fences with diagram controls', async () => {
    const { container } = render(
      <MarkdownContent
        features={{ ...features, mermaid: true }}
        text={'```mermaid\ngraph TD\n  A --> B\n```'}
      />,
    );

    await waitFor(() => expect(container.querySelector('[data-michi-mermaid] svg')).not.toBeNull());
    expect(mermaidRenderSpy).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('.michi-mermaid-controls button')).toHaveLength(5);
    expect(container.querySelector('.michi-code-block')).toBeNull();
  });
});
