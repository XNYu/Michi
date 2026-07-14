import React, { useMemo } from 'react';
import { useChatStore, useChatNode, useChatNodesSnapshot } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { parseDigestStructure, staleSources } from '../../state/digest';
import MarkdownContent from '../MarkdownContent';
import { Tag } from './primitives';

const DIGEST_PROSE =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg) [&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) [&_a]:text-(--term-accent)';

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DigestPane({
  nodeId,
  contentMaxWidth,
}: {
  nodeId: string;
  contentMaxWidth?: number | null;
}) {
  const { focusedPane, focusPane, setFocusedNodeId, refreshDigest, createChildChat } = useChatStore();
  const n = useChatNode(nodeId);
  const nodesSnapshot = useChatNodesSnapshot();
  const paneShellStyle = usePaneShellStyle(nodeId);

  const parsed = useMemo(
    () => (n?.digest ? parseDigestStructure(n.digest.content) : null),
    [n?.digest],
  );
  const stale = useMemo(
    () => (n?.digest ? staleSources(n.digest, nodesSnapshot) : []),
    [n?.digest, nodesSnapshot],
  );

  if (!n || n.kind !== 'digest' || !n.digest) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 11,
        }}
      >
        — empty digest pane —
      </div>
    );
  }

  const d = n.digest;
  const title = n.title || 'Workspace digest';
  const innerWrap: React.CSSProperties =
    contentMaxWidth != null
      ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto', width: '100%' }
      : { width: '100%' };

  const openFullDetail = () => {
    window.dispatchEvent(
      new CustomEvent('michi:focus-digest', { detail: { nodeId } }),
    );
    window.dispatchEvent(
      new CustomEvent('michi:nav-page', { detail: { page: 'digest' } }),
    );
  };

  return (
    <div
      data-node-id={nodeId}
      data-pane-kind="digest"
      className="terminal-pane"
      onMouseDown={() => {
        focusPane(nodeId);
        setFocusedNodeId(nodeId);
      }}
      style={{
        ...paneShellStyle,
        borderLeft: '3px solid var(--term-digest)',
      }}
    >
      <div
        style={{
          padding: '8px 14px',
          background: 'var(--term-digest-f)',
          borderBottom: '1px solid var(--term-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--term-digest)', fontSize: 14, fontWeight: 700, lineHeight: 1 }}>§</span>
        <span
          style={{
            color: 'var(--term-digest)',
            fontWeight: 700,
            letterSpacing: '.14em',
            fontSize: 10,
          }}
        >
          DIGEST
        </span>
        <span style={{ color: 'var(--term-faint)' }}>·</span>
        <span
          style={{
            color: 'var(--term-fg)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
          title={title}
        >
          {title}
        </span>
        {stale.length > 0 && <Tag color="var(--term-select)">{stale.length} stale</Tag>}
        <span style={{ color: 'var(--term-muted)', fontSize: 10 }}>
          {d.status === 'streaming' ? 'streaming…' : formatRelative(d.generatedAt)}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void refreshDigest(nodeId);
          }}
          disabled={d.status === 'streaming'}
          style={{
            padding: '3px 8px',
            border: '1px solid var(--term-digest)',
            background: d.status === 'streaming' ? 'var(--term-alt)' : 'transparent',
            color: 'var(--term-digest)',
            fontWeight: 700,
            fontSize: 10,
            cursor: d.status === 'streaming' ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--ui-font)',
            opacity: d.status === 'streaming' ? 0.6 : 1,
          }}
          title="Rebuild digest"
        >
          {d.status === 'streaming' ? '⟳' : '↻'}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openFullDetail();
          }}
          style={{
            padding: '3px 8px',
            border: '1px solid var(--term-line)',
            background: 'transparent',
            color: 'var(--term-mid)',
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
          }}
          title="Open full digest view"
        >
          ↗ detail
        </button>
      </div>

      <div
        className="term-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 22px 24px',
          color: 'var(--term-fg)',
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        <div style={innerWrap}>
          {parsed?.tldr && (
            <div
              style={{
                padding: '12px 14px',
                border: '1px solid var(--term-line)',
                background: 'var(--term-surface)',
                borderLeft: '3px solid var(--term-fg)',
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--term-muted)',
                  letterSpacing: '.14em',
                  marginBottom: 6,
                }}
              >
                ▸ TL;DR
              </div>
              <div style={{ fontSize: 13, color: 'var(--term-fg)', lineHeight: 1.6 }}>
                <MarkdownContent text={parsed.tldr} className={DIGEST_PROSE} />
              </div>
            </div>
          )}

          {parsed && parsed.sections.length > 0 ? (
            <>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--term-muted)',
                  letterSpacing: '.14em',
                  marginBottom: 8,
                }}
              >
                ▸ SECTIONS · {parsed.sections.length}
              </div>
              {parsed.sections.map((s, i) => {
                const isStale = s.sourceId ? stale.includes(s.sourceId) : false;
                return (
                  <div
                    key={i}
                    style={{
                      marginBottom: 12,
                      padding: '10px 14px',
                      background: 'var(--term-surface)',
                      border: '1px solid var(--term-line)',
                      borderLeft: isStale
                        ? '3px solid var(--term-select)'
                        : '3px solid var(--term-digest)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ color: 'var(--term-muted)', fontSize: 10 }}>
                        §{String(i + 1).padStart(2, '0')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--ui-font)',
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--term-fg)',
                        }}
                      >
                        {s.title}
                      </span>
                      {isStale && <Tag color="var(--term-select)">stale</Tag>}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--term-mid)', lineHeight: 1.6 }}>
                      <MarkdownContent text={s.body} className={DIGEST_PROSE} />
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <div style={{ color: 'var(--term-mid)' }}>
              {d.content ? (
                <MarkdownContent text={d.content} className={DIGEST_PROSE} />
              ) : d.status === 'streaming' ? (
                <span style={{ color: 'var(--term-muted)' }}>
                  <span style={{ color: 'var(--term-digest)' }}>⟳</span> generating digest…
                </span>
              ) : (
                <span style={{ color: 'var(--term-muted)' }}>— digest is empty —</span>
              )}
            </div>
          )}

          {parsed && parsed.openThreads.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--term-muted)',
                  letterSpacing: '.14em',
                  marginBottom: 8,
                }}
              >
                ▸ OPEN THREADS
              </div>
              <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)' }}>
                {parsed.openThreads.map((q, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '8px 12px',
                      borderBottom:
                        i < parsed.openThreads.length - 1 ? '1px solid var(--term-line)' : 'none',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: 'var(--term-accent)' }}>?</span>
                    <span style={{ color: 'var(--term-fg)', flex: 1 }}>{q}</span>
                    <span
                      onClick={() => void createChildChat(nodeId, q)}
                      style={{
                        fontSize: 10,
                        color: 'var(--term-mauve)',
                        cursor: 'pointer',
                      }}
                    >
                      ⧉ explore
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
