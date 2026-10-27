import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import MarkdownContent, { type MarkdownFeatureProfile } from './MarkdownContent';

const PICTURES: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true, httpsImages: true };
const draw = (text: string) => render(<MarkdownContent text={text} features={PICTURES} />).container;

describe('MarkdownContent https pictures', () => {
  it('loads an https picture by itself, lazily with no referrer, and nothing else it names', () => {
    const container = draw('<picture><source srcset="https://t.example/s.webp"><img src="https://t.example/p.png" srcset="https://t.example/big.png 2x" alt="pic alt" title="Lobby"></picture>');
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('https://t.example/p.png');
    expect(images[0].getAttribute('alt')).toBe('pic alt');
    expect(images[0].getAttribute('title')).toBe('Lobby');
    expect(images[0].getAttribute('srcset')).toBeNull();
    expect(images[0].getAttribute('loading')).toBe('lazy');
    expect(images[0].getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(container.querySelectorAll('picture, source, video, audio, iframe')).toHaveLength(0);
  });

  it('keeps every other picture as its alt text and other media as their fallback', () => {
    const container = draw('![lobby](http://t.example/a.png) ![camera](https://192.168.1.4/c.png) ![home](https://localhost/h.png)\n\n<video src="https://t.example/v.mp4">video fallback</video>');
    expect(container.querySelectorAll('img, video, button')).toHaveLength(0);
    expect(container.textContent).toContain('lobby camera home');
    expect(container.textContent).toContain('video fallback');
  });

  it('turns a picture that fails into a link to its address', () => {
    const container = draw('![Floor plan](https://t.example/plan.png)');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Floor plan' }).getAttribute('href')).toBe('https://t.example/plan.png');
  });

  it('leaves a linked picture that fails as the words of its link', () => {
    const container = draw('[![Floor plan](https://t.example/plan.png)](https://t.example/rooms)');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Floor plan' }).getAttribute('href')).toBe('https://t.example/rooms');
  });

  it('changes nothing without remote media off', () => {
    const { container } = render(<MarkdownContent text="![x](http://t.example/a.png)" features={{ httpsImages: true }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://t.example/a.png');
  });
});
