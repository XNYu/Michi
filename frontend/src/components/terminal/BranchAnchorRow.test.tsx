import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BranchAnchorRow, type BranchAnchorRowProps } from './BranchAnchorRow';

describe('BranchAnchorRow', () => {
  const baseProps: BranchAnchorRowProps = {
    title: 'Why TypeScript?',
    messageCount: 3,
    createdAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    status: 'idle',
    onOpen: () => {},
  };

  it('renders title, message count, relative time', () => {
    render(<BranchAnchorRow {...baseProps} />);
    // getByText throws if element not found — that is the assertion
    expect(screen.getByText('Why TypeScript?')).toBeTruthy();
    expect(screen.getByText(/3 messages/)).toBeTruthy();
    expect(screen.getByText(/5m/)).toBeTruthy();
  });

  it('calls onOpen when title clicked', () => {
    const onOpen = vi.fn();
    render(<BranchAnchorRow {...baseProps} title="X" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /X/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows a readable running state without a glowing pulse', () => {
    const { container } = render(<BranchAnchorRow {...baseProps} status="streaming" />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(container.querySelector('.t-branch-anchor-pulse')).toBeNull();
  });

  it('does not claim that an idle branch completed successfully', () => {
    render(<BranchAnchorRow {...baseProps} />);
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.queryByText('Complete')).toBeNull();
  });

  it('shows errors as needing attention', () => {
    render(<BranchAnchorRow {...baseProps} status="error" />);
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });

  it('opens the branch from metadata and exposes that metadata to screen readers', () => {
    const onOpen = vi.fn();
    const { container } = render(<BranchAnchorRow {...baseProps} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('3 messages'));
    expect(onOpen).toHaveBeenCalledOnce();
    const row = screen.getByRole('button', { name: 'Open branch: Why TypeScript?' });
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toContain('Idle');
    expect(container.querySelector('.t-pre-block, .lucide-panel-right-open')).toBeNull();
  });

  it('singularises "1 message"', () => {
    render(<BranchAnchorRow {...baseProps} messageCount={1} />);
    expect(screen.getByText('1 message')).toBeTruthy();
  });
});
