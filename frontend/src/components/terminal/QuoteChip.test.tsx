import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QuoteChip } from './QuoteChip';

describe('QuoteChip', () => {
  it('renders the quote text and a meta line with line/char counts', () => {
    const { container } = render(<QuoteChip text={'line1\nline2\nline3'} />);
    expect(container.textContent).toContain('line1');
    expect(container.textContent).toMatch(/3 lines/);
    expect(container.textContent).toMatch(/17 chars/);
  });

  it('starts collapsed: meta button reads "Expand ▾"', () => {
    const { getByRole } = render(<QuoteChip text="hello" />);
    expect(getByRole('button').textContent).toMatch(/Expand/);
  });

  it('toggles to expanded on click and the button flips to "Collapse ▴"', () => {
    const { getByRole } = render(<QuoteChip text="hello" />);
    fireEvent.click(getByRole('button'));
    expect(getByRole('button').textContent).toMatch(/Collapse/);
  });

  it('uses singular "line" / "char" when counts are 1', () => {
    const { container } = render(<QuoteChip text="x" />);
    // text="x" -> 1 line, 1 char
    expect(container.textContent).toMatch(/1 line\b/);
    expect(container.textContent).toMatch(/1 char\b/);
  });
});
