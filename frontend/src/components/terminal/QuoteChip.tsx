import React, { useState } from 'react';

interface Props {
  text: string;
}

export function QuoteChip({ text }: Props) {
  const [expanded, setExpanded] = useState(false);

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
        background: 'color-mix(in srgb, var(--term-mauve) 10%, transparent)',
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
