import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MichiBlock } from '../MichiBlock';

// The real MarkdownContent: what reaches the DOM is what matters here.
const MEDIA = 'img, picture, source, track, video, audio, iframe, frame, embed, object, image';
const PAGE_MARKDOWN = [
  '`` ![x](http://t.example/a.png) `',
  '![a\nb](http://t.example/b.png)',
  '```x`y\n![c](http://t.example/c.png)',
  '[l](http://plain.example) <http://auto.example> http://bare.example',
  '<a href="http://raw.example">r</a> <img src="https://t.example/raw.png" alt="raw alt">',
  '[r][d] ![p][pic]\n\n[d]: http://ref.example\n[pic]: https://t.example/ref.png',
  '<video src="https://t.example/v.mp4" poster="https://t.example/poster.png">fallback</video><iframe src="https://t.example/f"></iframe>',
  'Kept: [ok](https://ok.example/p) and [top](#top)',
].join('\n\n');

describe('Michi markdown blocks', () => {
  it('load nothing and link only https addresses or in-page anchors', () => {
    const { container } = render(
      <MichiBlock block={{ type: 'markdown', text: PAGE_MARKDOWN }} ctx={{ depth: 0 }} />,
    );
    expect(container.querySelectorAll(MEDIA)).toHaveLength(0);
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.every((href) => href.startsWith('#') || /^https:\/\/[^/]/.test(href))).toBe(true);
    expect(hrefs).toContain('https://ok.example/p');
    expect(container.textContent).toContain('raw alt');
  });
});

describe('Michi callouts', () => {
  const callout = (text: string) => render(
    <MichiBlock block={{ type: 'callout', tone: 'info', title: '本周重点', text }} ctx={{ depth: 0 }} />,
  ).container.querySelector('.michi-doc-callout') as HTMLElement;

  it('draw inline Markdown in their text, one paragraph per line', () => {
    const box = callout('1. **示例版本准备发布**：只剩示例页面检查。\n2. *示例笔记* 整理到 `示例目录`，见 [计划](https://plan.example/p)。');
    const lines = Array.from(box.querySelectorAll('p'));
    expect(lines.map((p) => p.textContent)).toEqual(['1. 示例版本准备发布：只剩示例页面检查。', '2. 示例笔记 整理到 示例目录，见 计划。']);
    expect(lines[0]!.querySelector('strong')?.textContent).toBe('示例版本准备发布');
    expect(lines[1]!.querySelector('em')?.textContent).toBe('示例笔记');
    expect(lines[1]!.querySelector('code')?.textContent).toBe('示例目录');
    expect(lines[1]!.querySelector('a')?.getAttribute('href')).toBe('https://plan.example/p');
    expect(box.textContent).not.toContain('*');
  });

  it('keep line starts as text instead of turning them into lists, headings, quotes or rules', () => {
    const box = callout('- 一项\n# 不是标题\n> 不是引用\n---\n3) 第三');
    expect(box.querySelectorAll('ul, ol, h1, blockquote, hr')).toHaveLength(0);
    expect(Array.from(box.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['- 一项', '# 不是标题', '> 不是引用', '---', '3) 第三']);
  });
});
