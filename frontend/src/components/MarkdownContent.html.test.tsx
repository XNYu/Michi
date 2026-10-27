import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

describe('MarkdownContent raw HTML safety', () => {
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
