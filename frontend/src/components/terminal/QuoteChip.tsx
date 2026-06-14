import React, { useState } from 'react';

interface Props {
  text: string;
}

export function QuoteChip({ text }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Counts use the original text so multi-line quotes report accurately.
  const lines = text.split('\n').length;
  const chars = text.length;
  // Collapsed preview collapses internal whitespace so a multi-line quote
  // shows as one continuous line, then the line-clamp truncates.
  const collapsedPreview = text.replace(/\s+/g, ' ').trim();

  const previewStyle: React.CSSProperties = expanded
    ? {
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        margin: 0,
      }
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
        background: 'rgba(183,148,246,0.10)',
        padding: '6px 8px 6px 10px',
        marginBottom: 8,
        fontSize: 12,
        color: 'var(--term-mid, #cfc6e5)',
        borderRadius: 2,
      }}
    >
      <span style={{ color: 'var(--term-mauve)', fontWeight: 600, flexShrink: 0 }}>❝</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p data-testid="quote-preview" style={previewStyle}>
          {expanded ? text : collapsedPreview}
        </p>
        <div
          style={{
            fontSize: 10,
            color: 'var(--term-muted)',
            letterSpacing: '0.04em',
            marginTop: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            userSelect: 'none',
          }}
        >
          <span>{lines} {lines === 1 ? 'line' : 'lines'} · {chars} {chars === 1 ? 'char' : 'chars'}</span>
          <span>·</span>
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
