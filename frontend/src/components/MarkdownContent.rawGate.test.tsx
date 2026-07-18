import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rawPluginSpy, sanitizePluginSpy } = vi.hoisted(() => ({
  rawPluginSpy: vi.fn(() => () => undefined),
  sanitizePluginSpy: vi.fn(() => () => undefined),
}));

vi.mock('rehype-raw', () => ({ default: rawPluginSpy }));
vi.mock('rehype-sanitize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rehype-sanitize')>();
  return { ...actual, default: sanitizePluginSpy };
});

import MarkdownContent from './MarkdownContent';

describe('MarkdownContent raw HTML plugin gate', () => {
  beforeEach(() => {
    rawPluginSpy.mockClear();
    sanitizePluginSpy.mockClear();
  });

  it('skips raw HTML parsing and sanitizing for ordinary markdown', () => {
    const { container } = render(
      <MarkdownContent text={'**safe** markdown with [a link](https://example.com)'} />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('safe');
    expect(rawPluginSpy).not.toHaveBeenCalled();
    expect(sanitizePluginSpy).not.toHaveBeenCalled();
  });

  it('enables both plugins when the source may contain raw HTML', () => {
    render(<MarkdownContent text={'before<br>after'} />);

    expect(rawPluginSpy).toHaveBeenCalled();
    expect(sanitizePluginSpy).toHaveBeenCalled();
  });
});
