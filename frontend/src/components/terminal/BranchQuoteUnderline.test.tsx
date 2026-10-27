import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BranchQuoteUnderline, type BranchQuoteAnchor } from './BranchQuoteUnderline';

const oneAnchor: BranchQuoteAnchor[] = [{
  childNodeId: 'c1',
  title: 'follow-up branch',
  createdAt: Date.now(),
  streaming: false,
  onOpen: vi.fn(),
}];

describe('BranchQuoteUnderline', () => {
  it('shows hover card on pointerEnter; hides on pointerLeave', async () => {
    const { container } = render(<BranchQuoteUnderline anchors={oneAnchor}>x</BranchQuoteUnderline>);
    const span = container.querySelector('.t-branch-anchor-underline')!;
    fireEvent.pointerEnter(span);
    expect(await screen.findByText('follow-up branch')).toBeTruthy();
    fireEvent.pointerLeave(span);
    await waitFor(() => expect(screen.queryByText('follow-up branch')).toBeFalsy());
  });
});
