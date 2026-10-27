import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CommentChips } from './CommentChips';

const mk = (id: string, q: string, b: string) => ({ id, quotedText: q, body: b, createdAt: 0 });

describe('CommentChips', () => {
  it('renders nothing when comments is empty', () => {
    const { container } = render(<CommentChips comments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('toggles expanded on button click', () => {
    const { getByRole } = render(
      <CommentChips comments={[mk('a', 'short', 'short body')]} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toMatch(/expand/i);
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/collapse/i);
  });
});
