import React, { useState } from 'react';
import type { AnyQuoteSource } from '../../lib/quoteFormat';
import { attachedQuoteHasSelection, quoteSourceOf } from '../../state/assistant/assistantContext';
import { useInAssistantScope } from './assistant/assistantScope';

interface Props {
  text: string;
  /** Where the quote came from (ChatMessage.quoteSource). */
  source?: AnyQuoteSource;
}

/**
 * Static in-message variant of the composer's quote pre-block: same
 * .t-pre-block recipe (tone-accent, caption + single-line body), but with an
 * expand toggle where the composer puts its dismiss × — the message is
 * already sent, so the quote can't be removed, only unfolded. A quote of
 * attached context only (the ⌘J assistant's page and chips, no selection) is
 * captioned as that, not as a reply to a selection.
 */
export function QuoteChip({ text, source }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Collapsed preview collapses internal whitespace so a multi-line quote
  // shows as one continuous line, then the single-line ellipsis truncates.
  const collapsedPreview = text.replace(/\s+/g, ' ').trim();
  // The source isn't stored: after a reload the assistant's own messages read it from the quote's opening.
  const inAssistant = useInAssistantScope();
  const attached = (source ?? (inAssistant ? quoteSourceOf(text) : undefined))?.type === 'attached';
  const contextOnly = attached && !attachedQuoteHasSelection(text);

  return (
    <div className="t-pre-block tone-accent is-msg">
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          {contextOnly ? <>attached <b>context</b></> : <>replying to <b>selection</b></>}
        </div>
        <div
          data-testid="quote-preview"
          className={expanded ? 't-pre-block-body is-expanded' : 't-pre-block-body'}
        >
          {expanded ? text : collapsedPreview}
        </div>
      </div>
      <button
        type="button"
        className="t-pre-block-exp"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'collapse ▴' : 'expand ▾'}
      </button>
    </div>
  );
}
