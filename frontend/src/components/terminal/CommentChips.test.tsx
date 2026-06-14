import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CommentChips } from './CommentChips';

const mk = (id: string, q: string, b: string) => ({ id, quotedText: q, body: b, createdAt: 0 });

describe('CommentChips', () => {
  it('renders nothing when comments is empty', () => {
    const { container } = render(<CommentChips comments={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per comment with index label', () => {
    const { container } = render(
      <CommentChips comments={[mk('a', 'q1', 'b1'), mk('b', 'q2', 'b2')]} />,
    );
    expect(container.querySelectorAll('[data-testid="comment-quote"]').length).toBe(2);
    expect(container.textContent).toContain('comment 1');
    expect(container.textContent).toContain('comment 2');
  });

  it('shows the quoted passage and body in collapsed form', () => {
    const { container } = render(
      <CommentChips comments={[mk('a', 'the quoted passage', 'my reply body')]} />,
    );
    expect(container.textContent).toContain('the quoted passage');
    expect(container.textContent).toContain('my reply body');
  });

  it('toggles expanded on button click', () => {
    const { getByRole } = render(
      <CommentChips comments={[mk('a', 'short', 'short body')]} />,
    );
    const btn = getByRole('button');
    expect(btn.textContent).toMatch(/Expand/);
    fireEvent.click(btn);
    expect(btn.textContent).toMatch(/Collapse/);
  });
});
