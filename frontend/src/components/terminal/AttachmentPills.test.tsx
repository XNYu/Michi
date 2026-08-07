import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../state/chatStore', () => ({
  useChatProjects: vi.fn(() => ({ activeProject: { id: 'ws-1' } })),
}));

import { AttachmentPills } from './AttachmentPills';

describe('AttachmentPills', () => {
  it('renders pills for non-image files', () => {
    const { getAllByTestId } = render(
      <AttachmentPills
        items={[
          { name: 'a.tsx', absPath: '/a.tsx' },
          { name: 'b.md', absPath: '/x/b.md' },
        ]}
      />,
    );
    const pills = getAllByTestId('attachment-pill');
    expect(pills).toHaveLength(2);
    expect(pills[0].textContent).toContain('a.tsx');
    expect(pills[1].textContent).toContain('b.md');
  });

  it('sets title to the absolute path on each pill', () => {
    const { getAllByTestId } = render(
      <AttachmentPills items={[{ name: 'a.tsx', absPath: '/abs/a.tsx' }]} />,
    );
    expect(getAllByTestId('attachment-pill')[0].getAttribute('title')).toBe('/abs/a.tsx');
  });

  it('renders nothing when items is empty', () => {
    const { container } = render(<AttachmentPills items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders image attachments as thumbnails', () => {
    const { getAllByTestId } = render(
      <AttachmentPills
        items={[
          { name: 'screenshot.png', absPath: '/proj/.attachments/screenshot.png', relPath: '.attachments/screenshot.png' },
        ]}
      />,
    );
    const thumbs = getAllByTestId('attachment-thumb');
    expect(thumbs).toHaveLength(1);
    const img = thumbs[0].querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('alt')).toBe('screenshot.png');
    // Web mode: URL should use API route
    expect(img!.getAttribute('src')).toContain('/api/files/ws-1/.attachments/screenshot.png');
  });

  it('falls back to pill when image has no relPath and no .attachments marker', () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <AttachmentPills
        items={[
          { name: 'photo.jpg', absPath: '/random/photo.jpg' },
        ]}
      />,
    );
    // No thumbnail rendered — falls back to pill
    expect(queryAllByTestId('attachment-thumb')).toHaveLength(0);
    const pills = getAllByTestId('attachment-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('photo.jpg');
  });

  it('renders mix of image thumbnails and file pills', () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <AttachmentPills
        items={[
          { name: 'image.png', absPath: '/p/.attachments/image.png', relPath: '.attachments/image.png' },
          { name: 'code.ts', absPath: '/p/code.ts' },
          { name: 'photo.webp', absPath: '/p/.attachments/photo.webp', relPath: '.attachments/photo.webp' },
        ]}
      />,
    );
    expect(queryAllByTestId('attachment-thumb')).toHaveLength(2);
    expect(getAllByTestId('attachment-pill')).toHaveLength(1);
  });
});
