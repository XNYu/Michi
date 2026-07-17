import React, { useState } from 'react';
import type { PendingComment } from '../../state/chatTypes';

interface Props {
  comments: PendingComment[];
}

export function CommentChips({ comments }: Props) {
  if (comments.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
      {comments.map((c, i) => (
        <CommentChip key={c.id} comment={c} index={i} />
      ))}
    </div>
  );
}

function CommentChip({ comment, index }: { comment: PendingComment; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const collapsedQuote = comment.quotedText.replace(/\s+/g, ' ').trim();
  const collapsedBody = comment.body.replace(/\s+/g, ' ').trim();

  const lineClampStyle: React.CSSProperties = expanded
    ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }
    : {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 1,
        overflow: 'hidden',
        overflowWrap: 'anywhere',
        margin: 0,
      };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        borderLeft: '2px solid var(--term-mauve)',
        background: 'color-mix(in srgb, var(--term-mauve) 10%, transparent)',
        padding: '6px 8px 6px 10px',
        fontSize: 12,
        color: 'var(--term-mid, #cfc6e5)',
        borderRadius: 2,
      }}
    >
      <span style={{ color: 'var(--term-mauve)', fontWeight: 600, flexShrink: 0 }}>↳</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 9.5,
            color: 'var(--term-muted)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginBottom: 2,
            userSelect: 'none',
          }}
        >
          comment {index + 1}
        </div>
        <p data-testid="comment-quote" style={{ ...lineClampStyle, opacity: 0.75, fontStyle: 'italic' }}>
          {expanded ? `"${comment.quotedText}"` : `"${collapsedQuote}"`}
        </p>
        <p data-testid="comment-body" style={{ ...lineClampStyle, marginTop: 4 }}>
          {expanded ? comment.body : collapsedBody}
        </p>
        <div
          style={{
            fontSize: 10,
            color: 'var(--term-muted)',
            letterSpacing: '0.04em',
            marginTop: 4,
            userSelect: 'none',
          }}
        >
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--term-accent, var(--term-mauve))',
              cursor: 'pointer',
              padding: 0,
              fontSize: 10,
              letterSpacing: '0.04em',
              fontFamily: 'var(--ui-font)',
            }}
          >
            {expanded ? 'Collapse ▴' : 'Expand ▾'}
          </button>
        </div>
      </div>
    </div>
  );
}
