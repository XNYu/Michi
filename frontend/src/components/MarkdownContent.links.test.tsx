import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';
import { MARKDOWN_RENDERER_STORAGE_KEY, setMarkdownRendererFlag } from './markdownRendererFlag';

function anchors(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a'));
}
function byHref(container: HTMLElement, hrefIncludes: string) {
  return anchors(container).find((a) => (a.getAttribute('href') ?? '').includes(hrefIncludes));
}

describe('MarkdownContent links (legacy renderer)', () => {
  beforeEach(() => window.localStorage.removeItem(MARKDOWN_RENDERER_STORAGE_KEY));

  it('opens external markdown links in a new context', () => {
    const { container } = render(<MarkdownContent text="[GitHub](https://github.com/foo)" />);
    const a = byHref(container, 'github.com/foo')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens bare https URLs in a new context', () => {
    const { container } = render(<MarkdownContent text="see https://example.com/x here" />);
    expect(byHref(container, 'example.com/x')!.getAttribute('target')).toBe('_blank');
  });

  it('does not add target to relative / hash / mailto links', () => {
    const { container } = render(
      <MarkdownContent text="[a](#section) and [b](/local/path) and [c](mailto:x@y.com)" />,
    );
    for (const a of anchors(container)) {
      expect(a.getAttribute('target')).toBeNull();
    }
    expect(anchors(container)).toHaveLength(3);
  });

  it('autolinks scheme-less domain.tld/path', () => {
    const { container } = render(
      <MarkdownContent text="open docs.example.com/ec2/home please" />,
    );
    const a = byHref(container, 'docs.example.com/ec2/home')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://docs.example.com/ec2/home');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('autolinks scheme-less URLs inside table cells', () => {
    const md = '| name | url |\n| --- | --- |\n| repo | github.com/foo/bar |';
    const { container } = render(<MarkdownContent text={md} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(byHref(container, 'github.com/foo/bar')).toBeTruthy();
  });

  it('keeps trailing sentence punctuation out of the link', () => {
    const { container } = render(<MarkdownContent text="visit docs.example.com/x." />);
    const a = byHref(container, 'docs.example.com/x')!;
    expect(a.getAttribute('href')).toBe('https://docs.example.com/x');
    expect(container.textContent).toContain('docs.example.com/x.');
  });

  it('does NOT linkify path-less tokens (package.json, bare domain, e.g.)', () => {
    const { container } = render(
      <MarkdownContent text="edit package.json (e.g. github.com without a path)" />,
    );
    expect(anchors(container)).toHaveLength(0);
  });

  it('does NOT linkify inside inline code or code blocks', () => {
    const { container } = render(
      <MarkdownContent text={'`docs.example.com/x`\n\n```\nsee foo.com/bar\n```'} />,
    );
    expect(anchors(container)).toHaveLength(0);
  });

  it('still autolinks while the streaming reveal animation is active', () => {
    const { container } = render(
      <MarkdownContent text="open docs.example.com/ec2/home now" revealTailChars={8} />,
    );
    const a = byHref(container, 'docs.example.com/ec2/home')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://docs.example.com/ec2/home');
  });

  it('does NOT double-link a real https URL', () => {
    const { container } = render(<MarkdownContent text="https://foo.com/a/b/c" />);
    const as = anchors(container);
    expect(as).toHaveLength(1);
    expect(as[0].getAttribute('href')).toBe('https://foo.com/a/b/c');
  });
});

describe('MarkdownContent links (streamdown renderer)', () => {
  beforeEach(() => setMarkdownRendererFlag('streamdown'));
  afterEach(() => setMarkdownRendererFlag('react-markdown'));

  it('applies target and scheme-less autolink under streamdown', async () => {
    const { container } = render(
      <MarkdownContent text="[GitHub](https://github.com/foo) and docs.example.com/ec2/home" />,
    );
    await waitFor(() => expect(byHref(container, 'docs.example.com/ec2/home')).toBeTruthy());
    expect(byHref(container, 'github.com/foo')!.getAttribute('target')).toBe('_blank');
    expect(byHref(container, 'docs.example.com/ec2/home')!.getAttribute('href')).toBe(
      'https://docs.example.com/ec2/home',
    );
  });
});
