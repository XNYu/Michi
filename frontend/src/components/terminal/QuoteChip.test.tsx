import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QuoteChip } from './QuoteChip';
import { AssistantScopeContext } from './assistant/assistantScope';
import { ATTACHED_QUOTE_SOURCE } from '../../lib/quoteFormat';

describe('QuoteChip', () => {
  it('toggles to expanded on click and the button flips to "collapse ▴"', () => {
    const { getByRole } = render(<QuoteChip text="hello" />);
    fireEvent.click(getByRole('button'));
    expect(getByRole('button').textContent).toMatch(/collapse/i);
  });

  it('says it replies to a selection only when a selection is in the quote', () => {
    const caption = (container: HTMLElement) => container.querySelector('.t-pre-block-cap')!.textContent;
    // A reply to a selection.
    expect(caption(render(<QuoteChip text="the passage" />).container)).toBe('replying to selection');
    // The ⌘J assistant's page line and chips alone: attached context.
    const page = 'On screen: Home\n- thread: Fix CI (michi://node/t1) — Stalled';
    expect(caption(render(<QuoteChip text={page} source={ATTACHED_QUOTE_SOURCE} />).container)).toBe('attached context');
    // The context and a selection together: the selection is what it replies to.
    expect(caption(render(<QuoteChip text={`${page}\n\nthe passage`} source={ATTACHED_QUOTE_SOURCE} />).container))
      .toBe('replying to selection');
  });

  it('reads an assistant message’s context from the quote itself after a reload', () => {
    const { container } = render(
      <AssistantScopeContext.Provider value>
        <QuoteChip text="On screen: Home" />
      </AssistantScopeContext.Provider>,
    );
    expect(container.querySelector('.t-pre-block-cap')!.textContent).toBe('attached context');
    // Outside the assistant, a quote is a selection, whatever it says.
    const other = render(<QuoteChip text="On screen: Home" />);
    expect(other.container.querySelector('.t-pre-block-cap')!.textContent).toBe('replying to selection');
  });
});
