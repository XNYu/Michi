import React from 'react';

type Tab = 'chats' | 'contexts' | 'digests';

interface Props {
  activeTab: Tab;
  onChange: (t: Tab) => void;
  counts: { chats: number; contexts: number; digests: number };
  filter: string;
  onFilterChange: (s: string) => void;
}

const TAB_LABELS: Record<Tab, string> = {
  chats: 'Chats',
  contexts: 'Sources',
  digests: 'Digests',
};

const TABS: Tab[] = ['chats', 'contexts', 'digests'];

export default function ManageTabs({ activeTab, onChange, counts, filter, onFilterChange }: Props) {
  return (
    <div
      style={{
        marginTop: 12,
        borderBottom: '1px solid var(--term-line)',
        display: 'flex',
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
              padding: '10px 18px 12px',
              fontFamily: 'var(--ui-font)',
              fontSize: 14,
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
                fontSize: 11.5,
                color: 'var(--term-faint, var(--term-muted))',
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          color: 'var(--term-muted)',
          fontSize: 13,
        }}
      >
        <SearchGlyph />
        <input
          type="text"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Search…"
          style={{
            border: 'none',
            background: 'transparent',
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            color: 'var(--term-fg)',
            padding: 0,
            outline: 'none',
            width: 160,
          }}
        />
      </div>
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
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}
