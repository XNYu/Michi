import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QuoteChip } from './QuoteChip';

describe('QuoteChip', () => {
  it('renders the quote text', () => {
    const { container } = render(<QuoteChip text={'line1\nline2\nline3'} />);
    expect(container.textContent).toContain('line1');
  });

  it('starts collapsed: meta button reads "expand ▾"', () => {
    const { getByRole } = render(<QuoteChip text="hello" />);
    expect(getByRole('button').textContent).toMatch(/expand/i);
  });

  it('toggles to expanded on click and the button flips to "collapse ▴"', () => {
    const { getByRole } = render(<QuoteChip text="hello" />);
    fireEvent.click(getByRole('button'));
    expect(getByRole('button').textContent).toMatch(/collapse/i);
  });
});
