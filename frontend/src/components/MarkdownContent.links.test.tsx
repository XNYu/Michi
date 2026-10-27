import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

function anchors(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a'));
}
function byHref(container: HTMLElement, hrefIncludes: string) {
  return anchors(container).find((a) => (a.getAttribute('href') ?? '').includes(hrefIncludes));
}

describe('MarkdownContent links', () => {
  it('dispatches michi:internal-link custom event on relative link click', () => {
    const { container } = render(
      <MarkdownContent text="[doc](notes/design.md)" />,
    );
    const a = byHref(container, 'notes/design.md')!;
    const received: string[] = [];
    container.addEventListener('michi:internal-link', ((e: CustomEvent) => {
      received.push(e.detail.href);
    }) as EventListener);
    a.click();
    expect(received).toEqual(['notes/design.md']);
  });

  it('calls onLinkClick prop instead of custom event when provided', () => {
    const clicked: string[] = [];
    const { container } = render(
      <MarkdownContent text="[file](output.txt)" onLinkClick={(href) => clicked.push(href)} />,
    );
    const a = byHref(container, 'output.txt')!;
    a.click();
    expect(clicked).toEqual(['output.txt']);
  });

  it('does not prevent default on hash-only links', () => {
    const { container } = render(
      <MarkdownContent text="[section](#heading)" />,
    );
    const a = byHref(container, '#heading')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('autolinks scheme-less domain.tld/path', () => {
    const { container } = render(
      <MarkdownContent text="open console.aws.amazon.com/ec2/home please" />,
    );
    const a = byHref(container, 'console.aws.amazon.com/ec2/home')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://console.aws.amazon.com/ec2/home');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('keeps trailing sentence punctuation out of the link', () => {
    const { container } = render(<MarkdownContent text="visit console.aws.amazon.com/x." />);
    const a = byHref(container, 'console.aws.amazon.com/x')!;
    expect(a.getAttribute('href')).toBe('https://console.aws.amazon.com/x');
    expect(container.textContent).toContain('console.aws.amazon.com/x.');
  });

  it('linkifies full https URLs inside fenced code blocks', () => {
    const { container } = render(
      <MarkdownContent text={'```\nhttps://example.com/path\n```'} />,
    );
    const a = byHref(container, 'example.com/path')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toBe('https://example.com/path');
    expect(a.getAttribute('target')).toBe('_blank');
  });
});
