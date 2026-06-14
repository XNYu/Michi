import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageBlockView } from './ImageBlockView';
import { API_BASE_URL } from '../../config/env';
import type { AssistantBlock } from '../../state/chatTypes';

function imageBlock(over: Partial<Extract<AssistantBlock, { kind: 'image' }>> = {}): AssistantBlock {
  return {
    id: 'img-1',
    kind: 'image',
    workspaceId: 'ws/1',
    path: 'sub dir/shot.png',
    mimeType: 'image/png',
    size: 53248,
    ...over,
  };
}

describe('ImageBlockView', () => {
  it('renders an <img> with an API_BASE_URL/files src that encodes the workspaceId and each path segment', () => {
    render(<ImageBlockView blocks={[imageBlock()]} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    const src = img.getAttribute('src') ?? '';
    // Must be built off API_BASE_URL (points at the backend), NOT a hardcoded
    // relative '/api/...' (which in dev hits the vite origin, not the backend).
    // workspaceId 'ws/1' -> ws%2F1 ; path segments encoded, '/' kept as separator
    expect(src).toBe(`${API_BASE_URL}/files/ws%2F1/sub%20dir/shot.png`);
  });

  it('opens the lightbox (role="dialog") on click', () => {
    render(<ImageBlockView blocks={[imageBlock({ caption: 'a caption' })]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'a caption' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('shows the lightbox info bar: filename (basename), file size, and caption', () => {
    render(<ImageBlockView blocks={[imageBlock({ caption: 'a caption', size: 53248 })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'a caption' }));
    // filename is the path basename, not the full 'sub dir/shot.png'
    expect(screen.getByText('shot.png')).toBeTruthy();
    // 53248 bytes -> 52 KB
    expect(screen.getByText(/52 KB/)).toBeTruthy();
    // caption appears in the info bar too
    const captions = screen.getAllByText('a caption');
    expect(captions.length).toBeGreaterThan(0);
  });

  it('exposes a keyboard-focusable button (aria-label) instead of a bare clickable img', () => {
    render(<ImageBlockView blocks={[imageBlock()]} />);
    // no caption -> fallback label
    const btn = screen.getByRole('button', { name: 'Open image' });
    expect(btn.tagName).toBe('BUTTON');
  });

  it('closes the lightbox on Escape', () => {
    render(<ImageBlockView blocks={[imageBlock({ caption: 'a caption' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'a caption' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a figcaption with the caption text and uses it as the img alt', () => {
    render(<ImageBlockView blocks={[imageBlock({ caption: 'a wild caption' })]} />);
    expect(screen.getByText('a wild caption').tagName).toBe('FIGCAPTION');
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('a wild caption');
  });

  it('renders two <img>s for two image blocks keyed by block.id', () => {
    render(
      <ImageBlockView
        blocks={[
          imageBlock({ id: 'a', path: 'one.png' }),
          imageBlock({ id: 'b', path: 'two.png' }),
        ]}
      />,
    );
    const imgs = screen.getAllByRole('img');
    expect(imgs).toHaveLength(2);
    const srcs = imgs.map((i) => i.getAttribute('src'));
    expect(srcs).toEqual([
      `${API_BASE_URL}/files/ws%2F1/one.png`,
      `${API_BASE_URL}/files/ws%2F1/two.png`,
    ]);
  });
});
