import React from 'react';

type Tab = 'chats' | 'artifacts' | 'digests';

interface Props {
  activeTab: Tab;
  onChange: (t: Tab) => void;
  counts: { chats: number; artifacts: number; digests: number };
  filter: string;
  onFilterChange: (s: string) => void;
  /** A phone's narrower column: the search takes its own full-width row above
   *  the tabs instead of squeezing in beside them. */
  compact?: boolean;
}

const TAB_LABELS: Record<Tab, string> = {
  chats: 'Chats',
  artifacts: 'Artifacts',
  digests: 'Digests',
};

const TABS: Tab[] = ['chats', 'artifacts', 'digests'];

export default function ManageTabs({ activeTab, onChange, counts, filter, onFilterChange, compact = false }: Props) {
  return (
    <div
      style={{
        marginTop: 12,
        borderBottom: '1px solid var(--term-line)',
        display: 'flex',
        flexWrap: compact ? 'wrap' : undefined,
        alignItems: 'flex-end',
        marginBottom: 22,
      }}
    >
      {TABS.map((t) => {
        const isActive = t === activeTab;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            style={{
              padding: compact ? '10px 12px 12px' : '10px 18px 12px',
              minHeight: compact ? 44 : undefined,
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-xl)',
              lineHeight: 1.2,
              fontWeight: isActive ? 500 : 400,
              color: isActive ? 'var(--term-fg)' : 'var(--term-muted)',
              background: 'transparent',
              border: 'none',
              borderBottom: isActive
                ? '2px solid var(--term-accent)'
                : '2px solid transparent',
              marginBottom: -1,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            {TAB_LABELS[t]}
            <span
              style={{
                fontSize: 'var(--fs-md)',
                color: 'var(--term-muted)',
                fontFamily: 'var(--ui-font)',
                fontWeight: 400,
              }}
            >
              {counts[t]}
            </span>
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      <label
        style={compact ? {
          order: -1,
          flexBasis: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          marginBottom: 8,
          padding: '0 12px',
          boxSizing: 'border-box',
          border: '1px solid var(--term-line)',
          borderRadius: 'var(--ui-radius)',
          background: 'var(--term-surface)',
          color: 'var(--term-muted)',
        } : {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-lg)',
        }}
      >
        <SearchGlyph />
        <input
          type="text"
          aria-label="Search this workspace"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search…"
          style={{
            border: 'none',
            background: 'transparent',
            fontFamily: 'var(--ui-font)',
            fontSize: compact ? 'var(--fs-xl)' : 'var(--fs-lg)',
            color: 'var(--term-fg)',
            padding: 0,
            outline: 'none',
            width: compact ? '100%' : 160,
            minWidth: 0,
            flex: compact ? 1 : undefined,
          }}
        />
      </label>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
