import React, { useState } from 'react';
import { useChatStore } from '../../../state/chatStore';
import MarkdownContent from '../../MarkdownContent';

export default function ContextsScreen() {
  const { activeProject, pinContext } = useChatStore();
  const [viewing, setViewing] = useState<string | null>(null);

  const contexts = activeProject?.contexts ?? [];

  if (!activeProject) {
    return (
      <div className="m-screen">
        <div className="m-screen-header">
          <span className="m-screen-title">Artifacts</span>
        </div>
        <div className="m-empty">
          <div className="m-empty-headline">No workspace selected</div>
        </div>
      </div>
    );
  }

  const open = contexts.find((c) => c.id === viewing);

  return (
    <div className="m-screen">
      <div className="m-screen-header">
        <span className="m-screen-title">Artifacts</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--term-muted)' }}>
          {contexts.length}
        </span>
      </div>
      {contexts.length === 0 ? (
        <div className="m-empty">
          <div className="m-empty-headline">No artifacts</div>
          <div className="m-empty-sub">Add artifacts on desktop. Mobile is read-only.</div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {contexts.map((c) => (
            <div key={c.id} className="m-thread-row" style={{ alignItems: 'flex-start' }}>
              <span style={{ marginTop: 2, color: 'var(--term-faint)' }}>📄</span>
              <div
                style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                onClick={() => setViewing(c.id)}
              >
                <div className="m-thread-name">{c.name}</div>
                <div className="m-thread-meta">
                  {c.size != null ? `${formatSize(c.size)}` : '—'}
                  {c.kind === 'reference' ? ' · reference' : ''}
                </div>
              </div>
              <button
                aria-label="Toggle pin"
                onClick={(e) => {
                  e.stopPropagation();
                  pinContext(c.id);
                }}
                style={{
                  background: c.pinnedAt ? 'var(--term-accent)' : 'transparent',
                  color: c.pinnedAt ? 'var(--term-bg)' : 'var(--term-muted)',
                  border: '1px solid var(--term-line)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 10.5,
                  cursor: 'pointer',
                  fontFamily: 'var(--ui-font)',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                pin
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <ContextViewer
          name={open.name}
          filePath={open.filePath}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function ContextViewer({
  name,
  filePath,
  onClose,
}: {
  name: string;
  filePath: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/contexts/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`http ${r.status}`))))
      .then((t) => {
        if (!cancelled) setContent(t);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div
      className="m-sheet-scrim"
      onClick={onClose}
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <div
        className="m-shell"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          inset: '40px 16px',
          borderRadius: 8,
          border: '1px solid var(--term-line)',
        }}
      >
        <div className="m-screen-header">
          <span className="m-screen-title" style={{ flex: 1 }}>{name}</span>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--term-muted)',
              cursor: 'pointer',
              fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {error ? (
            <div style={{ color: '#dc2626' }}>Failed: {error}</div>
          ) : content == null ? (
            <div style={{ color: 'var(--term-muted)' }}>loading…</div>
          ) : (
            <MarkdownContent text={content} />
          )}
        </div>
      </div>
    </div>
  );
}
