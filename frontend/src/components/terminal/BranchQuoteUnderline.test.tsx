import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BranchQuoteUnderline, type BranchQuoteAnchor } from './BranchQuoteUnderline';

const oneAnchor: BranchQuoteAnchor[] = [{
  childNodeId: 'c1',
  title: 'follow-up branch',
  createdAt: Date.now(),
  status: 'idle',
  question: 'Which ones?',
  reply: 'Mode changes and usage.',
  onOpen: vi.fn(),
}];

describe('BranchQuoteUnderline', () => {
  it('shows hover card on pointerEnter; hides on pointerLeave', async () => {
    const { container } = render(<BranchQuoteUnderline anchors={oneAnchor}>x</BranchQuoteUnderline>);
    const span = container.querySelector('.t-branch-anchor-underline')!;
    fireEvent.pointerEnter(span);
    const item = await screen.findByRole('button', { name: 'Open branch: follow-up branch' });
    // The branch reads as a footnote: what was asked in it and what it said.
    expect(item.querySelector('.t-branch-card-exchange')?.textContent).toBe('youWhich ones?michiMode changes and usage.');
    // A quiet branch shows its age, not "Idle".
    expect(item.querySelector('.t-branch-card-state')?.textContent).toBe('now');
    fireEvent.pointerLeave(span);
    await waitFor(() => expect(screen.queryByText('follow-up branch')).toBeFalsy());
  });

  it('shows two branches with their exchange, a running one as typing, and any more on one line', () => {
    const anchors: BranchQuoteAnchor[] = [
      oneAnchor[0],
      { ...oneAnchor[0], childNodeId: 'c2', title: 'running branch', status: 'streaming', reply: undefined },
      { ...oneAnchor[0], childNodeId: 'c3', title: 'third branch', status: 'error' },
    ];
    render(<BranchQuoteUnderline anchors={anchors}>x</BranchQuoteUnderline>);
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'x' }));
    const card = screen.getByRole('group', { name: '3 branches from this passage' });
    const items = Array.from(card.querySelectorAll('.t-branch-card-item'));
    expect(items.map((item) => item.classList.contains('is-compact'))).toEqual([false, false, true]);
    expect(items[1].textContent).toContain('Running');
    expect(items[1].querySelector('.t-branch-card-exchange')?.textContent).toBe('youWhich ones?michiWriting a reply');
    expect(items[2].querySelector('.t-branch-card-exchange')).toBeNull();
    expect(items[2].textContent).toContain('Needs attention');
  });

  it('lets the keyboard reach the card: focus opens it, Enter enters it, Esc returns', () => {
    render(<BranchQuoteUnderline anchors={oneAnchor}>x</BranchQuoteUnderline>);
    const underline = screen.getByRole('button', { name: 'x' });
    act(() => underline.focus());
    expect(underline.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(underline, { key: 'Enter' });
    const row = screen.getByRole('button', { name: 'Open branch: follow-up branch' });
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(underline);
  });

  it('shows one card at a time when the pointer moves between passages', async () => {
    const other: BranchQuoteAnchor[] = [{ ...oneAnchor[0], childNodeId: 'c2', title: 'second branch' }];
    render(<>
      <BranchQuoteUnderline anchors={oneAnchor}>first</BranchQuoteUnderline>
      <BranchQuoteUnderline anchors={other}>second</BranchQuoteUnderline>
    </>);
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'first' }));
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'second' }));
    expect(screen.queryByText('follow-up branch')).toBeNull();
    expect(screen.getByText('second branch')).toBeTruthy();
  });
});
