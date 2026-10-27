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
    // alt="" makes the thumbnail decorative (role "presentation"); the button names it.
    const img = screen.getByRole('button', { name: 'Open image' }).querySelector('img')!;
    const src = img.getAttribute('src') ?? '';
    // Must be built off API_BASE_URL (points at the backend), NOT a hardcoded
    // relative '/api/...' (which in dev hits the vite origin, not the backend).
    // workspaceId 'ws/1' -> ws%2F1 ; path segments encoded, '/' kept as separator
    expect(src).toBe(`${API_BASE_URL}/files/ws%2F1/sub%20dir/shot.png`);
  });

  it('closes the lightbox on Escape', () => {
    render(<ImageBlockView blocks={[imageBlock({ caption: 'a caption' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'a caption' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
