import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent, { type MarkdownFeatureProfile } from './MarkdownContent';
import { isLocalOnlyHref } from './rehypeLocalOnly';

const LOCAL_ONLY: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true };
const MEDIA = 'img, picture, source, track, video, audio, iframe, frame, embed, object, image';

// Ways Markdown and raw HTML can make a page load something or link off https.
const PROBES = [
  '`` ![x](http://t.example/a.png) `',
  '![a\nb](http://t.example/b.png)',
  '```x`y\n![c](http://t.example/c.png)',
  '[l](http://plain.example) <http://auto.example> http://bare.example www.www-autolink.example',
  '<a href="http://raw.example">r</a>',
  '[r][d]\n\n[d]: http://ref.example',
  '![ref image][pic]\n\n[pic]: https://t.example/ref.png',
  '<img src="https://t.example/raw.png" alt="raw alt">',
  '<p>before <img\nsrc="https://t.example/multiline.png"\nalt="multi"> after</p>',
  '<picture><source srcset="https://t.example/s.webp"><img src="https://t.example/p.png" alt="pic alt"></picture>',
  '<video src="https://t.example/v.mp4" poster="https://t.example/poster.png">video fallback</video>',
  '<audio src="https://t.example/a.mp3"></audio><iframe src="https://t.example/frame"></iframe>',
  '[js](javascript:alert(1)) [mail](mailto:a@b.example) [rel](./notes.md) [proto](//t.example/x)',
  '![https image](https://t.example/ok.png)',
];

function renderLocalOnly(text: string) {
  return render(<MarkdownContent text={text} features={LOCAL_ONLY} />).container;
}

describe('MarkdownContent local-only features', () => {
  it.each(PROBES)('loads nothing and links only https: %s', (text) => {
    const container = renderLocalOnly(text);
    expect(container.querySelectorAll(MEDIA)).toHaveLength(0);
    for (const a of Array.from(container.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? '';
      expect(href.startsWith('#') || /^https:\/\/[^/]/.test(href)).toBe(true);
    }
  });

  it('keeps alt text, link words and https links', () => {
    const container = renderLocalOnly('See ![lobby photo](http://t.example/a.png), [plain](http://plain.example) and [ok](https://ok.example/p).');
    expect(container.textContent).toContain('See lobby photo, plain and ok.');
    const links = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://ok.example/p']);
  });

  it('keeps fallback words of embedded media', () => {
    const container = renderLocalOnly(PROBES[10]);
    expect(container.textContent).toContain('video fallback');
  });

  it('uses probes that do load media and link off https without the opt-in', () => {
    let media = 0;
    let offHttps = 0;
    for (const text of PROBES) {
      const { container, unmount } = render(<MarkdownContent text={text} />);
      media += container.querySelectorAll(MEDIA).length;
      offHttps += Array.from(container.querySelectorAll('a')).filter((a) => !isLocalOnlyHref(a.getAttribute('href'))).length;
      unmount();
    }
    expect(media).toBeGreaterThanOrEqual(6);
    expect(offHttps).toBeGreaterThanOrEqual(5);
  });

  it('changes nothing for callers that do not opt in', () => {
    const { container } = render(<MarkdownContent text="![x](https://t.example/a.png) [l](http://plain.example)" />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('http://plain.example');
  });

  it('judges hrefs strictly', () => {
    expect(isLocalOnlyHref('https://a.example/x')).toBe(true);
    expect(isLocalOnlyHref(' #section ')).toBe(true);
    expect(isLocalOnlyHref('https://')).toBe(false);
    expect(isLocalOnlyHref('http://a.example')).toBe(false);
    expect(isLocalOnlyHref('//a.example')).toBe(false);
    expect(isLocalOnlyHref('mailto:a@b.example')).toBe(false);
    expect(isLocalOnlyHref(undefined)).toBe(false);
  });
});
