import { render, screen } from '@testing-library/react';
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
});
