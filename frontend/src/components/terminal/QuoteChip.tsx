import React, { useState } from 'react';

interface Props {
  text: string;
}

/**
 * Static in-message variant of the composer's quote pre-block: same
 * .t-pre-block recipe (tone-accent, caption + single-line body), but with an
 * expand toggle where the composer puts its dismiss × — the message is
 * already sent, so the quote can't be removed, only unfolded.
 */
export function QuoteChip({ text }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Collapsed preview collapses internal whitespace so a multi-line quote
  // shows as one continuous line, then the single-line ellipsis truncates.
  const collapsedPreview = text.replace(/\s+/g, ' ').trim();

  return (
    <div className="t-pre-block tone-accent is-msg">
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          replying to <b>selection</b>
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
