import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

describe('MarkdownContent raw HTML safety', () => {
  it('preserves allowed raw HTML and mention-chip metadata', () => {
    const { container } = render(
      <MarkdownContent
        text={'before<br>after <span class="mention-chip" data-mention="docs">@docs</span>'}
      />,
    );

    expect(container.querySelector('br')).not.toBeNull();
    const mention = container.querySelector('.mention-chip');
    expect(mention?.textContent).toBe('@docs');
    expect(mention?.getAttribute('data-mention')).toBe('docs');
  });

  it('still removes executable raw HTML', () => {
    const { container } = render(
      <MarkdownContent
        text={'<img src="x" onerror="window.__markdownPwned = true"><script>window.__markdownPwned = true</script>'}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect((window as typeof window & { __markdownPwned?: boolean }).__markdownPwned).toBeUndefined();
  });
});
