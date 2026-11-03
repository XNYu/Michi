import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BranchAnchorRow, type BranchAnchorRowProps } from './BranchAnchorRow';

describe('BranchAnchorRow', () => {
  const baseProps: BranchAnchorRowProps = {
    title: 'Why TypeScript?',
    messageCount: 3,
    createdAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    status: 'idle',
    onOpen: () => {},
  };

  it('singularises "1 message"', () => {
    render(<BranchAnchorRow {...baseProps} messageCount={1} />);
    expect(screen.getByText('1 message')).toBeTruthy();
  });

  it('renders settled unless it was made just now', () => {
    const { container } = render(<BranchAnchorRow {...baseProps} />);
    expect(container.firstElementChild?.tagName).toBe('BUTTON');
  });

  it('a branch made just now grows into the list and keeps its separator', () => {
    const { container } = render(<BranchAnchorRow {...baseProps} createdAt={Date.now()} enter last={false} />);
    const grow = container.firstElementChild as HTMLElement;
    expect(grow.tagName).toBe('DIV');
    expect(grow.style.display).toBe('flow-root');
    const row = screen.getByRole('button', { name: 'Open branch: Why TypeScript?' });
    expect(row.parentElement).toBe(grow);
    // Wrapped, the row is its wrapper's last child; it draws its own separator.
    expect(row.style.borderBottom).toContain('1px solid');
  });

  it('cross-fades the status word; the outgoing one is aria-hidden', async () => {
    const { rerender } = render(<BranchAnchorRow {...baseProps} status="streaming" />);
    expect(screen.getByText('Running').closest('[aria-hidden]')).toBeNull();
    rerender(<BranchAnchorRow {...baseProps} status="idle" />);
    expect(screen.getByText('Idle').closest('[aria-hidden]')).toBeNull();
    const leaving = screen.queryByText('Running');
    if (leaving) expect(leaving.closest('[aria-hidden="true"]')).not.toBeNull();
    await waitFor(() => expect(screen.queryByText('Running')).toBeNull());
  });
});
