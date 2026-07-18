import React, { useState } from 'react';
import type { PendingComment } from '../../state/chatTypes';

interface Props {
  comments: PendingComment[];
}

export function CommentChips({ comments }: Props) {
  if (comments.length === 0) return null;
  return (
    <>
      {comments.map((c, i) => (
        <CommentChip key={c.id} comment={c} index={i} />
      ))}
    </>
  );
}

/**
 * Static in-message variant of the composer's comment pre-block: same
 * .t-pre-block recipe (tone-select, caption + quoted snippet + reply), but
 * with an expand toggle where the composer puts its dismiss × — the comment
 * is already sent, so it can't be removed or edited, only unfolded.
 */
function CommentChip({ comment, index }: { comment: PendingComment; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const collapsedQuote = comment.quotedText.replace(/\s+/g, ' ').trim();
  const collapsedBody = comment.body.replace(/\s+/g, ' ').trim();

  return (
    <div className="t-pre-block tone-select is-msg">
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          comment <b>{index + 1}</b>
        </div>
        <div
          data-testid="comment-quote"
          className={expanded ? 't-pre-block-quoted is-expanded' : 't-pre-block-quoted'}
        >
          "{expanded ? comment.quotedText : collapsedQuote}"
        </div>
        <div
          data-testid="comment-body"
          className={expanded ? 't-pre-block-reply is-expanded' : 't-pre-block-reply'}
        >
          {expanded ? comment.body : collapsedBody}
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
