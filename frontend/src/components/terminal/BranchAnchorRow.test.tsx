import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BranchAnchorRow } from './BranchAnchorRow';

describe('BranchAnchorRow', () => {
  const baseProps = {
    title: 'Why TypeScript?',
    messageCount: 3,
    createdAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    streaming: false,
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

  it('renders pulse when streaming=true', () => {
    const { container } = render(<BranchAnchorRow {...baseProps} streaming={true} />);
    expect(container.querySelector('.t-branch-anchor-pulse')).toBeTruthy();
  });

  it('no pulse when streaming=false', () => {
    const { container } = render(<BranchAnchorRow {...baseProps} streaming={false} />);
    expect(container.querySelector('.t-branch-anchor-pulse')).toBeFalsy();
  });

  it('singularises "1 message"', () => {
    render(<BranchAnchorRow {...baseProps} messageCount={1} />);
    expect(screen.getByText(/1 message[^s]/)).toBeTruthy();
  });
});
