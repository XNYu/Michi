import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';
import { MichiMantine } from './mantine/MichiMantine';
import { SAMPLE_BLOCKS } from './vendor-blocks/src/desk/component-samples';
import { escapeIsForPage } from '../../escapeLayers';

vi.mock('../../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="md">{text}</div> }));

const TYPES = ['image', 'gallery', 'before-after', 'carousel', 'video', 'audio', 'embed', 'file', 'person', 'place'] as const;
// What each type draws, as Desk's sheet names it.
const MARK: Record<(typeof TYPES)[number], string> = {
  image: '.desk-media-img', gallery: '.desk-gallery', 'before-after': '.desk-compare-pics', carousel: '.desk-carousel', video: '.desk-video',
  audio: '.desk-audio', embed: '.desk-embed-placeholder', file: '.desk-file-card', person: '.desk-person-card', place: '.desk-place-card',
};
const ctx: MichiBlockCtx = { depth: 0, loadImages: true };

function draw(block: MichiPageBlock) {
  return render(<MichiMantine dark={false}><MichiBlock block={block} ctx={ctx} /></MichiMantine>);
}
const sample = (type: (typeof TYPES)[number]) => SAMPLE_BLOCKS.get(type) as unknown as MichiPageBlock;
const GOOD = 'https://images.example.com/a.jpg';

// jsdom has no layout observers; embla (the carousel) reads them.
class NoObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('ResizeObserver', NoObserver);

afterEach(cleanup);

describe('Desk-drawn media blocks', () => {
  it.each(TYPES)('draws %s from its Desk sample', async (type) => {
    const { container } = draw(sample(type));
    await waitFor(() => expect(container.querySelector(MARK[type])).not.toBeNull());
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
  });

  it.each([
    ['image', { type: 'image' }],
    ['gallery', { type: 'gallery', items: [] }],
    ['before-after', { type: 'before-after', before: GOOD }],
    ['carousel', { type: 'carousel', items: 'x' }],
    ['video', { type: 'video', url: 'javascript:alert(1)' }],
    ['audio', { type: 'audio' }],
    ['embed', { type: 'embed', url: 'http://example.com' }],
    ['file', { type: 'file' }],
    ['person', { type: 'person' }],
    ['place', { type: 'place' }],
  ] as Array<[string, MichiPageBlock]>)('falls back to the one-line label for an invalid %s', (_type, block) => {
    const { container } = draw(block);
    expect(container.querySelector('[data-michi-block="unknown"]')).not.toBeNull();
  });
});

describe('images are https only', () => {
  it.each(['http://images.example.com/a.jpg', '/local/a.jpg', 'file:///tmp/a.jpg', 'a.jpg'])('does not load %s', (url) => {
    const { container } = draw({ type: 'image', url, alt: 'Words instead' });
    // Desk's catalog drops the block, or the picture shows its words; either way no <img> loads.
    expect(container.querySelector('img')).toBeNull();
  });

  it('loads an https image with no referrer', () => {
    const { container } = draw({ type: 'image', url: GOOD, alt: 'A lake' });
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(GOOD);
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('shows the words of a picture that fails to load, linking to it', () => {
    const { container } = draw({ type: 'image', url: GOOD, alt: 'A lake' });
    fireEvent.error(container.querySelector('img')!);
    const link = screen.getByText('A lake').closest('a');
    expect(link?.getAttribute('href')).toBe(GOOD);
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('does not load a non-https gallery thumbnail', () => {
    const { container } = draw({ type: 'gallery', items: [{ url: 'http://x.example/a.jpg', alt: 'Plain http' }, { url: GOOD, alt: 'Fine' }] });
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([GOOD]);
  });
});

describe('gallery lightbox', () => {
  const gallery: MichiPageBlock = { type: 'gallery', items: [{ url: GOOD, alt: 'One' }, { url: 'https://images.example.com/b.jpg', alt: 'Two' }, { url: 'https://images.example.com/c.jpg', alt: 'Three' }] };

  it('opens on click, arrows move, wraps around', async () => {
    draw(gallery);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge: One' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 / 3');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog.textContent).toContain('2 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(dialog.textContent).toContain('3 / 3');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(dialog.textContent).toContain('1 / 3');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(dialog.textContent).toContain('3 / 3');
  });

  it('keeps its arrow keys from the block shell above it', async () => {
    const seen = vi.fn();
    render(<div onKeyDown={seen}><MichiMantine dark={false}><MichiBlock block={gallery} ctx={ctx} /></MichiMantine></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge: One' }));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'ArrowRight' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('closes on Esc while the page does not act on that Esc, and focus returns to the thumbnail', async () => {
    draw(gallery);
    const thumb = screen.getByRole('button', { name: 'Enlarge: Two' });
    thumb.focus();
    fireEvent.click(thumb);
    const dialog = await screen.findByRole('dialog');
    // The page's own Esc listener, run for the same key press, sees the modal still up.
    const pageActed = vi.fn();
    const onPageKey = (event: KeyboardEvent) => { if (escapeIsForPage(event)) pageActed(); };
    window.addEventListener('keydown', onPageKey);
    try {
      expect(dialog.closest('[aria-modal="true"]') ?? dialog.querySelector('[aria-modal="true"]') ?? dialog.getAttribute('aria-modal')).toBeTruthy();
      await act(async () => { fireEvent.keyDown(dialog, { key: 'Escape' }); });
      expect(pageActed).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onPageKey);
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(thumb));
  });
});

describe('before-after slider', () => {
  // jsdom does not step a range input on arrow keys; a drag and a key press both reach React as a change event on the native range, so that is what is driven.
  it('moves the divider and its spoken value on each change, within 0 to 100', () => {
    const { container } = draw({ type: 'before-after', before: GOOD, after: 'https://images.example.com/b.jpg' });
    const range = screen.getByRole('slider', { name: 'Compare before and after' }) as HTMLInputElement;
    const at = () => (container.querySelector('.desk-compare-pics') as HTMLElement).style.getPropertyValue('--at');
    expect([range.type, range.min, range.max, range.value, at()]).toEqual(['range', '0', '100', '50', '50%']);
    fireEvent.change(range, { target: { value: '20' } });
    expect([range.value, at(), range.getAttribute('aria-valuetext')]).toEqual(['20', '20%', 'Before 20%, after 80%']);
    fireEvent.change(range, { target: { value: '100' } });
    expect([range.value, at(), range.getAttribute('aria-valuetext')]).toEqual(['100', '100%', 'Before 100%, after 0%']);
  });
});

describe('carousel', () => {
  it('draws its first picture, then the slides with controls and a counter', async () => {
    const { container } = draw(sample('carousel'));
    await waitFor(() => expect(container.querySelector('.desk-carousel')).not.toBeNull());
    expect(screen.getAllByRole('group', { hidden: true }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Next image' })).toBeTruthy();
    // Mantine's own counter is hidden from the accessibility tree; the block's replaces it.
    expect(screen.getByText('Image 1 of 2', { selector: '[role="status"]:not([hidden])' })).toBeTruthy();
  });
});

describe('person and place', () => {
  it('shows the initials when the person has no avatar, and loads none that is not https', () => {
    const { container } = draw({ type: 'person', name: 'Emma Clark' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.mantine-Avatar-root')?.textContent).toBe('EC');
    cleanup();
    // Desk's catalog does not read a person whose avatar address is not https; the one-line label stands in.
    const bad = draw({ type: 'person', name: 'Emma Clark', avatar: 'http://x.example/e.png' });
    expect(bad.container.querySelector('[data-michi-block="unknown"]')).not.toBeNull();
    expect(bad.container.innerHTML).not.toContain('x.example');
  });

  it('shows the initials when the avatar fails to load', () => {
    const { container } = draw({ type: 'person', name: 'Emma Clark', avatar: 'https://x.example/e.png' });
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('.mantine-Avatar-root')?.textContent).toBe('EC');
  });

  it('opens the maps link in a new tab that learns nothing of the page', () => {
    draw({ type: 'place', name: 'Kyoto Station', address: 'Shimogyo Ward, Kyoto' });
    const a = screen.getByRole('link', { name: /Open in maps/ });
    expect(a.getAttribute('href')).toBe('https://maps.apple.com/?q=Shimogyo%20Ward%2C%20Kyoto');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('frames', () => {
  it('loads an embed only after a click, sandboxed without popups, no referrer', () => {
    const { container } = draw({ type: 'embed', url: 'https://example.com/page', title: 'Example account sign-in' });
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load page' }));
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('names the real domain first even when the model gives a title', () => {
    const { container } = draw({ type: 'embed', url: 'https://www.example.com/page', title: 'Example account sign-in' });
    expect(container.querySelector('.desk-embed-domain')?.textContent).toBe('example.com');
    expect(container.querySelector('.desk-embed-title')?.textContent).toBe('Example account sign-in');
  });

  it('frames a YouTube link through its no-cookie host and a plain mp4 in a video element', () => {
    const yt = draw({ type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(yt.container.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(yt.container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    cleanup();
    const mp4 = draw({ type: 'video', url: 'https://cdn.example.com/a.mp4' });
    expect(mp4.container.querySelector('video')).not.toBeNull();
    expect(mp4.container.querySelector('iframe')).toBeNull();
  });
});
