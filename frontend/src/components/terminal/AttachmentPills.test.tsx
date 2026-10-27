import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../state/chatStore', () => ({
  useChatProjects: vi.fn(() => ({ activeProject: { id: 'ws-1' } })),
  useOptionalChatProjects: vi.fn(() => ({ activeProject: { id: 'ws-1' } })),
}));

import { AttachmentPills } from './AttachmentPills';

describe('AttachmentPills', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<AttachmentPills items={[]} />);
    expect(container.firstChild).toBeNull();
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
