import React from 'react';

interface Props {
  name: string;
  cwd?: string;
  chatsCount: number;
  contextsCount: number;
  branchesCount: number;
  lastActiveAt: number;
}

function relative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

function titleCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(' ');
}

const dot = (
  <span aria-hidden="true" style={{ color: 'var(--term-faint, var(--term-muted))' }}>·</span>
);

export default function ManageHeader({
  name,
  cwd,
  chatsCount,
  contextsCount,
  branchesCount: _branchesCount,
  lastActiveAt,
}: Props) {
  return (
    <header
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginBottom: 24,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <h1
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 38,
          lineHeight: 1.15,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          margin: 0,
          color: 'var(--term-fg)',
        }}
      >
        {titleCase(name)}
      </h1>
      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-muted)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'baseline',
        }}
      >
        {cwd && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FolderGlyph />
            {cwd}
          </span>
        )}
        {cwd && dot}
        <span>
          {chatsCount} chats · {contextsCount} artifacts
        </span>
        {dot}
        <span>active {relative(lastActiveAt)}</span>
      </div>
    </header>
  );
}

function FolderGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4.5C2 3.7 2.7 3 3.5 3h2.7L7.5 4.5h5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V4.5z" />
    </svg>
  );
}
