import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AttachmentPills } from './AttachmentPills';

describe('AttachmentPills', () => {
  it('renders one element per item with the file name', () => {
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
});
