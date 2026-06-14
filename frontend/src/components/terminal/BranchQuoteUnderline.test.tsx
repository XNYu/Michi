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

  it('calls onOpen when card title clicked', async () => {
    const onOpen = vi.fn();
    const anchors = [{ ...oneAnchor[0], onOpen }];
    const { container } = render(<BranchQuoteUnderline anchors={anchors}>x</BranchQuoteUnderline>);
    fireEvent.pointerEnter(container.querySelector('.t-branch-anchor-underline')!);
    fireEvent.click(await screen.findByRole('button', { name: /follow-up branch/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('lists multiple anchors in the card', async () => {
    const anchors = [
      { ...oneAnchor[0], childNodeId: 'c1', title: 'A' },
      { ...oneAnchor[0], childNodeId: 'c2', title: 'B' },
    ];
    const { container } = render(<BranchQuoteUnderline anchors={anchors}>x</BranchQuoteUnderline>);
    fireEvent.pointerEnter(container.querySelector('.t-branch-anchor-underline')!);
    expect(await screen.findByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('shows pulse in card when any anchor is streaming', async () => {
    const anchors = [{ ...oneAnchor[0], streaming: true }];
    const { container } = render(<BranchQuoteUnderline anchors={anchors}>x</BranchQuoteUnderline>);
    fireEvent.pointerEnter(container.querySelector('.t-branch-anchor-underline')!);
    await screen.findByText('follow-up branch');
    expect(document.querySelector('.t-branch-anchor-pulse')).toBeTruthy();
  });
});
