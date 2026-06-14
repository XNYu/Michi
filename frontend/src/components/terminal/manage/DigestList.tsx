import React from 'react';
import type { DigestSummary } from './derive';

interface Props {
  digests: DigestSummary[];
  filter: string;
  onOpen: (nodeId: string) => void;
  onRebuild: (nodeId: string) => void;
  onExport: (nodeId: string) => void;
}

function relative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
  padding: 0,
};

export default function DigestList({ digests, filter, onOpen, onRebuild, onExport }: Props) {
  const norm = filter.trim().toLowerCase();
  const filtered = norm ? digests.filter((d) => d.title.toLowerCase().includes(norm)) : digests;

  if (filtered.length === 0) {
    return (
      <div
        style={{
          padding: '20px 0',
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-muted)',
        }}
      >
        no digests yet
      </div>
    );
  }

  return (
    <div>
      {filtered.map((d) => (
        <article
          key={d.nodeId}
          style={{
            background: 'var(--term-surface, #fff)',
            border: '1px solid var(--term-line)',
            padding: '20px 22px',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontSize: 10,
                color: 'var(--term-digest, #2f6b4e)',
                background: 'var(--term-digest-f, #d7e7df)',
                padding: '2px 7px',
                letterSpacing: '0.08em',
                fontWeight: 600,
                fontFamily: 'var(--ui-font)',
              }}
            >
              DIGEST
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontSize: 12,
                color: 'var(--term-muted)',
                fontFamily: 'var(--ui-font)',
              }}
            >
              {d.sourceCount} sources · {relative(d.updatedAt)}
            </span>
          </div>
          <div
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 18,
              lineHeight: 1.3,
              fontWeight: 500,
              marginTop: 8,
              color: 'var(--term-fg)',
            }}
          >
            {d.title}
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: 'var(--ui-font)',
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--term-mid, var(--term-fg))',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {d.excerpt || '(empty)'}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 14,
              marginTop: 14,
              fontSize: 12,
              color: 'var(--term-muted)',
              fontFamily: 'var(--ui-font)',
            }}
          >
            <button type="button" onClick={() => onOpen(d.nodeId)} style={linkBtn}>→ open</button>
            <button type="button" onClick={() => onRebuild(d.nodeId)} style={linkBtn}>↻ rebuild</button>
            <button type="button" onClick={() => onExport(d.nodeId)} style={linkBtn}>⤓ export</button>
          </div>
        </article>
      ))}
    </div>
  );
}
