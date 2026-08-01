import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, useChatNodesSnapshot, useChatNode, chatLabel } from '../../../state/chatStore';
import { parseDigestStructure, staleSources } from '../../../state/digest';
import { findTreeIdForNode, descendants } from '../../../state/tree';
import MarkdownContent from '../../MarkdownContent';
import { Dot, Tag } from '../primitives';
import type { PageId } from '../../../state/commands';

const DIGEST_PROSE = 'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg) [&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) [&_a]:text-(--term-accent)';

function DigestInput({
  nodeId,
  createChildChat,
  onNav,
}: {
  nodeId: string;
  createChildChat: (parentNodeId: string, firstMessage: string) => Promise<string>;
  onNav: (p: PageId) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    void createChildChat(nodeId, t).then(() => onNav('dashboard')).catch(() => {});
  };
  return (
    <div
      style={{
        flexShrink: 0,
        background: 'var(--term-surface)',
        border: `1px solid ${focused ? 'rgba(26,25,22,.18)' : 'var(--term-line)'}`,
        boxShadow: focused
          ? '0 4px 16px rgba(26,25,22,.08), 0 1px 3px rgba(26,25,22,.05)'
          : '0 4px 12px rgba(26,25,22,.05), 0 1px 2px rgba(26,25,22,.03)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'box-shadow 120ms ease-out, border-color 120ms ease-out',
      }}
    >
      <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          aria-hidden
          style={{
            color: 'var(--term-accent)',
            fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: 14,
            lineHeight: '1.5',
            flexShrink: 0,
            userSelect: 'none',
          }}
        >
          ›_
        </span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder="Ask a follow-up about this digest…"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontFamily: "'Source Serif 4', Georgia, 'PingFang SC', serif",
            fontSize: 14,
            lineHeight: '1.5',
            color: 'var(--term-fg)',
            padding: 0,
          }}
        />
      </div>
      <div style={{ padding: '4px 10px 8px', display: 'flex', alignItems: 'center', gap: 6, minHeight: 34 }}>
        <ChipButton label="+" />
        <ChipButton label="@" />
        <ChipButton label="⎇ code" color="var(--term-mauve)" />
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          aria-label="Send"
          style={{
            width: 30,
            height: 30,
            borderRadius: 2,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: text.trim() ? 'var(--term-accent)' : 'color-mix(in srgb, var(--term-accent) 40%, transparent)',
            color: '#fff',
            border: 'none',
            cursor: text.trim() ? 'pointer' : 'not-allowed',
            flexShrink: 0,
            transition: 'background 100ms',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 13V3" /><path d="M3.5 7.5L8 3l4.5 4.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ChipButton({ label, color }: { label: string; color?: string }) {
  return (
    <span
      style={{
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 8px',
        fontSize: 11,
        letterSpacing: '.04em',
        color: color || 'var(--term-mid)',
        border: '1px solid transparent',
        borderRadius: 2,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'border-color 100ms, background 100ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--term-line)';
        e.currentTarget.style.background = 'var(--term-alt)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'transparent';
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </span>
  );
}

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

export default function TerminalDigest({
  onNav,
}: {
  onNav: (p: PageId) => void;
}) {
  const {
    activeProject,
    createDigest,
    refreshDigest,
    setDigestPrompt,
    markDigestViewed,
    openPane,
    createChildChat,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();

  const [requestedDigestId, setRequestedDigestId] = useState<string | null>(null);
  const [createPrompt, setCreatePrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const activeTree = activeProject?.trees.find((tree) => tree.id === activeProject.activeTreeId) ?? null;
  const threadState = useMemo(() => {
    if (!activeProject || !activeTree) return null;
    const isAliveChat = (id: string) => {
      const node = nodesSnapshot[id];
      return !!node && node.kind === 'chat' && !node.deletedAt;
    };
    if (!isAliveChat(activeTree.rootNodeId)) return null;

    const chatIds = [
      activeTree.rootNodeId,
      ...descendants(activeTree.rootNodeId, activeProject.edges, (id) => {
        const node = nodesSnapshot[id];
        return !!node && !node.deletedAt;
      }),
    ].filter(isAliveChat);

    let digestId: string | null = null;
    let digestScore = -1;
    for (const id of activeProject.chatIds) {
      const node = nodesSnapshot[id];
      if (!node || node.kind !== 'digest' || node.deletedAt || !node.digest) continue;
      const belongsToActiveThread = node.digest.sources.some(
        (sourceId) => findTreeIdForNode(sourceId, activeProject) === activeTree.id,
      );
      if (!belongsToActiveThread) continue;
      const score = node.digest.generatedAt || 0;
      if (score >= digestScore) {
        digestId = id;
        digestScore = score;
      }
    }

    return {
      chatIds,
      digestId,
      messageCount: chatIds.reduce((sum, id) => {
        const node = nodesSnapshot[id];
        return sum + (node?.messageCount ?? node?.messages.length ?? 0);
      }, 0),
    };
  }, [activeProject, activeTree, nodesSnapshot]);

  const focusedDigestId = requestedDigestId ?? threadState?.digestId ?? null;
  const focusedDigestNode = useChatNode(focusedDigestId ?? '');

  // A thread switch must immediately move the page to that thread's digest,
  // even if the user was watching a freshly-created digest in the prior one.
  useEffect(() => {
    setRequestedDigestId(null);
    setCreatePrompt('');
    setCreating(false);
  }, [activeProject?.id, activeProject?.activeTreeId]);

  // Clear unread state once the user has the detail view open and the digest
  // has finished generating. We wait for `idle` so a streaming digest the user
  // happens to be staring at still surfaces as unread until it finalizes.
  useEffect(() => {
    if (!focusedDigestId) return;
    const node = focusedDigestNode;
    if (!node || node.kind !== 'digest' || !node.digest) return;
    if (node.digest.status !== 'idle') return;
    if (node.digest.generatedAt <= node.digest.viewedAt) return;
    markDigestViewed(focusedDigestId);
  }, [focusedDigestId, focusedDigestNode, markDigestViewed]);

  // Detail view's digest source-of-truth. Prefer the reactive useChatNode
  // subscription so streaming updates land without re-navigation.
  const digestNode =
    focusedDigestNode?.kind === 'digest' && focusedDigestNode.digest
      ? focusedDigestNode
      : null;

  const parsed = useMemo(
    () => (digestNode ? parseDigestStructure(digestNode.digest!.content) : null),
    [digestNode],
  );
  const stale = useMemo(
    () => (digestNode ? staleSources(digestNode.digest!, nodesSnapshot) : []),
    [digestNode, nodesSnapshot],
  );

  // --- Scroll-tracking for OUTLINE ---
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeOutlineIdx, setActiveOutlineIdx] = useState<number>(-1); // -1 = tldr, 0+ = section index

  const handleContentScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const sectionEls = container.querySelectorAll<HTMLElement>('[data-digest-section]');
    const tldrEl = container.querySelector<HTMLElement>('[data-digest-tldr]');
    const scrollTop = container.scrollTop;
    const offset = 80; // threshold from top

    let active = -1; // default to TL;DR
    sectionEls.forEach((el, i) => {
      if (el.offsetTop - container.offsetTop <= scrollTop + offset) {
        active = i;
      }
    });
    // If TL;DR is still mostly visible
    if (tldrEl && tldrEl.offsetTop + tldrEl.offsetHeight - container.offsetTop > scrollTop + offset) {
      active = -1;
    }
    setActiveOutlineIdx(active);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleContentScroll, { passive: true });
    handleContentScroll(); // initial
    return () => container.removeEventListener('scroll', handleContentScroll);
  }, [handleContentScroll, parsed]);

  const scrollToSection = useCallback((idx: number) => {
    const container = scrollRef.current;
    if (!container) return;
    if (idx === -1) {
      const el = container.querySelector<HTMLElement>('[data-digest-tldr]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const els = container.querySelectorAll<HTMLElement>('[data-digest-section]');
      if (els[idx]) els[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // Live source list = every chat in the digest's originating tree, recomputed
  // from the project's current edges so chats branched after the digest was
  // generated show up in the SOURCES rail immediately. Falls back to the saved
  // snapshot when the tree can't be resolved (e.g. all original sources gone).
  const liveSources = useMemo(() => {
    if (!digestNode || !activeProject) return digestNode?.digest?.sources ?? [];
    const d = digestNode.digest!;
    const isAlive = (id: string) => {
      const n = nodesSnapshot[id];
      return !!n && !n.deletedAt;
    };
    const anchor = d.sources.find(isAlive);
    const treeId = anchor ? findTreeIdForNode(anchor, activeProject) : null;
    const tree = treeId ? activeProject.trees.find((t) => t.id === treeId) : null;
    if (!tree || !isAlive(tree.rootNodeId)) return d.sources;
    const descIds = descendants(tree.rootNodeId, activeProject.edges, isAlive);
    const ids = [tree.rootNodeId, ...descIds].filter((id) => {
      const n = nodesSnapshot[id];
      return !!n && n.kind === 'chat' && !n.deletedAt;
    });
    return ids.length > 0 ? ids : d.sources;
  }, [digestNode, activeProject, nodesSnapshot]);

  const createCurrentDigest = async () => {
    if (!activeProject || !threadState || creating || threadState.chatIds.length === 0) return;
    setCreating(true);
    try {
      const nodeId = await createDigest(
        activeProject.id,
        threadState.chatIds,
        createPrompt.trim() || undefined,
      );
      setRequestedDigestId(nodeId);
    } finally {
      setCreating(false);
    }
  };

  if (!activeProject) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 13,
        }}
      >
        — no workspace —
      </div>
    );
  }

  if (!activeTree || !threadState) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 13,
        }}
      >
        — no active thread —
      </div>
    );
  }

  if (!digestNode) {
    const threadTitle = activeTree.name?.trim()
      || nodesSnapshot[activeTree.rootNodeId]?.title
      || 'Untitled thread';
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 28,
          background: 'var(--term-page-bg, var(--term-bg))',
          backgroundImage: `
            radial-gradient(ellipse 70% 50% at 10% 0%, color-mix(in srgb, var(--term-digest) 3%, transparent), transparent),
            radial-gradient(ellipse 50% 60% at 95% 90%, color-mix(in srgb, var(--term-mauve) 2%, transparent), transparent)
          `,
        }}
      >
        <div
          style={{
            width: 'min(640px, 100%)',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface)',
            boxShadow: '0 1px 2px rgba(26,25,22,.04), 0 16px 44px rgba(26,25,22,.07)',
          }}
        >
          <div
          style={{
            padding: '24px 26px 18px',
            borderBottom: '1px solid var(--term-line)',
          }}
        >
            <div style={{ marginBottom: 10 }}>
              <span style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10.5,
                letterSpacing: '.12em',
                color: 'var(--term-digest)',
                textTransform: 'uppercase',
              }}>
                THREAD DIGEST
              </span>
            </div>
            <div style={{ color: 'var(--term-fg)', fontSize: 21, fontWeight: 650, marginBottom: 8 }}>
              Create this thread&rsquo;s digest
            </div>
            <div style={{ color: 'var(--term-mid)', fontSize: 13, lineHeight: 1.6 }}>
              Summarize <strong style={{ color: 'var(--term-fg)' }}>{threadTitle}</strong> into one living digest.
              It will cover {threadState.chatIds.length} chat{threadState.chatIds.length === 1 ? '' : 's'} and update from this thread only.
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 10, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--term-muted)', fontSize: 10.5 }}>
              <span style={{ padding: '2px 8px', background: 'var(--term-alt)', border: '1px solid var(--term-line)' }}>{threadState.messageCount} messages</span>
              <span style={{ padding: '2px 8px', background: 'var(--term-alt)', border: '1px solid var(--term-line)' }}>{threadState.chatIds.length} source{threadState.chatIds.length === 1 ? '' : 's'}</span>
            </div>
          </div>

          <div style={{ padding: '18px 20px 20px' }}>
            <label
              htmlFor="thread-digest-guidance"
              style={{
                display: 'block',
                marginBottom: 8,
                color: 'var(--term-muted)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10,
                letterSpacing: '.12em',
              }}
            >
              OPTIONAL GUIDANCE
            </label>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                border: '1px solid var(--term-line)',
                background: 'rgba(253,253,251,.72)',
                boxShadow: 'inset 0 1px 3px rgba(26,25,22,.06)',
                padding: '12px 14px',
                minHeight: 88,
              }}
            >
              <span aria-hidden style={{ color: 'var(--term-digest)', fontSize: 13, paddingTop: 2 }}>›_</span>
              <textarea
                id="thread-digest-guidance"
                aria-label="Digest guidance (optional)"
                value={createPrompt}
                onChange={(event) => setCreatePrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void createCurrentDigest();
                  }
                }}
                placeholder="e.g. Focus on decisions, unresolved questions, and next steps…"
                rows={4}
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  resize: 'vertical',
                  background: 'transparent',
                  color: 'var(--term-fg)',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 14,
                  lineHeight: 1.55,
                  padding: 0,
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span style={{ color: 'var(--term-muted)', fontSize: 10.5, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>⌘↵ to create</span>
              <button
                type="button"
                onClick={() => void createCurrentDigest()}
                disabled={creating}
                style={{
                  padding: '7px 14px',
                  border: '1px solid var(--term-digest)',
                  background: creating ? 'var(--term-alt)' : 'var(--term-digest)',
                  color: creating ? 'var(--term-muted)' : 'var(--term-bg)',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: creating ? 'wait' : 'pointer',
                }}
              >
                {creating ? 'creating…' : 'Create digest'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const d = digestNode.digest!;
  const title = digestNode.title || 'Thread digest';

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      minHeight: 0,
      background: 'var(--term-page-bg, var(--term-bg))',
      backgroundImage: `
        radial-gradient(ellipse 70% 50% at 10% 0%, rgba(47,107,78,.04), transparent),
        radial-gradient(ellipse 50% 60% at 95% 90%, rgba(184,69,31,.03), transparent)
      `,
    }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, gap: 16, padding: '18px 20px' }}>
      {/* Content card — raised independently */}
      <div ref={scrollRef} className="term-scrollbar" style={{ flex: 1, overflowY: 'auto', minWidth: 0, background: 'var(--term-surface)', boxShadow: '0 8px 32px rgba(26,25,22,.07), 0 1px 3px rgba(26,25,22,.04)', border: '1px solid var(--term-line)' }}>
        <div
          style={{
            padding: '20px 28px 16px',
            borderBottom: '1px solid var(--term-line)',
            WebkitAppRegion: 'drag',
          } as React.CSSProperties}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10.5,
                letterSpacing: '.12em',
                color: 'var(--term-digest)',
                textTransform: 'uppercase',
              }}
            >
              THREAD DIGEST · {activeTree?.name?.trim() || 'thread'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 23,
                fontWeight: 650,
                color: 'var(--term-fg)',
                letterSpacing: '-.01em',
              }}
            >
              {title}
            </span>
            {stale.length > 0 && <Tag color="var(--term-select)">{stale.length} stale</Tag>}
          </div>
          <div style={{ display: 'flex', gap: 18, fontSize: 11, color: 'var(--term-muted)' }}>
            <span><span style={{ color: 'var(--term-mid)' }}>scope</span> thread</span>
            <span>
              <span style={{ color: 'var(--term-mid)' }}>sources</span> {liveSources.length} chat
              {liveSources.length === 1 ? '' : 's'}
            </span>
            <span>
              <span style={{ color: 'var(--term-mid)' }}>updated</span>{' '}
              {d.status === 'streaming'
                ? 'streaming…'
                : formatRelative(d.generatedAt)}
            </span>
            <span><span style={{ color: 'var(--term-mid)' }}>tokens</span> —</span>
          </div>

          {/* Custom prompt editor — inside header area */}
          <div style={{ marginTop: 10 }}>
            <div
              onClick={() => setPromptOpen((v) => !v)}
              style={{
                padding: '6px 0',
                fontSize: 10,
                color: 'var(--term-muted)',
                cursor: 'pointer',
                letterSpacing: '.14em',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {promptOpen ? '▾' : '▸'} CUSTOM PROMPT
              {d.customPrompt && !promptOpen && (
                <span style={{ color: 'var(--term-accent)', fontSize: 8 }}>●</span>
              )}
            </div>
            {promptOpen && (
              <div style={{ paddingBottom: 6 }}>
                <textarea
                  value={d.customPrompt || ''}
                  onChange={(e) => setDigestPrompt(digestNode.nodeId, e.target.value)}
                  placeholder="e.g. Focus on architecture decisions, summarize in Chinese…"
                  rows={3}
                  style={{
                    width: '100%',
                    background: 'var(--term-bg)',
                    color: 'var(--term-fg)',
                    border: '1px solid var(--term-line)',
                    borderRadius: 3,
                    padding: '6px 8px',
                    fontSize: 11.5,
                    fontFamily: 'var(--ui-font)',
                    outline: 'none',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ fontSize: 9.5, color: 'var(--term-muted)', marginTop: 4 }}>
                  Applied on next rebuild
                </div>
              </div>
            )}
          </div>
        </div>

        {parsed?.tldr && (
          <div
            data-digest-tldr
            style={{
              padding: '18px 28px',
              borderBottom: '1px solid var(--term-line)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10,
                color: 'var(--term-muted)',
                letterSpacing: '.14em',
                marginBottom: 6,
                textTransform: 'uppercase',
              }}
            >
              TL;DR
            </div>
            <div
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 13.5,
                color: 'var(--term-fg)',
                lineHeight: 1.6,
              }}
            >
              <MarkdownContent text={parsed.tldr} className={DIGEST_PROSE} />
            </div>
          </div>
        )}

        {parsed && parsed.sections.length > 0 ? (
          <div style={{ padding: '18px 28px 24px' }}>
            {parsed.sections.map((s, i) => {
              const isStale = s.sourceId ? stale.includes(s.sourceId) : false;
              return (
                <div
                  key={i}
                  data-digest-section
                  style={{
                    padding: '14px 0',
                    ...(i > 0 ? { borderTop: '1px solid var(--term-line)' } : {}),
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{
                      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                      fontSize: 22,
                      fontWeight: 500,
                      color: '#dcd6c8',
                      lineHeight: 1,
                      minWidth: 28,
                    }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--ui-font)',
                        fontSize: 18,
                        fontWeight: 600,
                        color: 'var(--term-fg)',
                      }}
                    >
                      {s.title}
                    </span>
                    {isStale && <Tag color="var(--term-select)">stale — source changed</Tag>}
                    <div style={{ flex: 1 }} />
                    {s.sourceId && (
                      <span
                        onClick={() => openPane(s.sourceId!)}
                        style={{
                          fontSize: 10.5,
                          color: 'var(--term-muted)',
                          fontFamily: 'var(--ui-font)',
                          cursor: 'pointer',
                          transition: 'color 100ms',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--term-accent)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--term-muted)'; }}
                      >
                        source ↗
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--ui-font)',
                      fontSize: 13,
                      color: 'var(--term-mid)',
                      lineHeight: 1.75,
                      marginTop: 8,
                    }}
                  >
                    <MarkdownContent text={s.body} className={DIGEST_PROSE} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              padding: '18px 28px 24px',
              fontFamily: 'var(--ui-font)',
              fontSize: 13,
              color: 'var(--term-mid)',
              lineHeight: 1.65,
            }}
          >
            {d.content ? (
              <MarkdownContent text={d.content} className={DIGEST_PROSE} />
            ) : d.status === 'streaming' ? (
              <span style={{ color: 'var(--term-muted)' }}>
                <span style={{ color: 'var(--term-digest)' }}>⟳</span> generating digest…
              </span>
            ) : (
              <span>— digest is empty —</span>
            )}
          </div>
        )}

        {parsed && parsed.openThreads.length > 0 && (
          <div style={{ padding: '0 28px 28px' }}>
            <div
              style={{
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 10,
                color: 'var(--term-muted)',
                letterSpacing: '.14em',
                marginBottom: 8,
                textTransform: 'uppercase',
              }}
            >
              OPEN THREADS
            </div>
            <div
              style={{
                border: '1px solid var(--term-line)',
                background: 'var(--term-surface)',
                boxShadow: '0 1px 2px rgba(26,25,22,.03)',
              }}
            >
              {parsed.openThreads.map((q, i) => (
                <div
                  key={i}
                  style={{
                    padding: '10px 14px',
                    borderBottom:
                      i < parsed.openThreads.length - 1
                        ? '1px solid var(--term-line)'
                        : 'none',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                  }}
                >
                  <span
                    style={{
                      color: 'var(--term-accent)',
                      fontFamily: 'var(--ui-font)',
                      fontSize: 11,
                    }}
                  >
                    ?
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--ui-font)',
                      fontSize: 13,
                      color: 'var(--term-fg)',
                      flex: 1,
                    }}
                  >
                    {q}
                  </span>
                  <span
                    onClick={() => void createChildChat(digestNode.nodeId, q).then(() => onNav('dashboard')).catch(() => {})}
                    style={{
                      fontSize: 10,
                      color: 'var(--term-mauve)',
                      cursor: 'pointer',
                      fontFamily: 'var(--ui-font)',
                    }}
                  >
                    ⧉ explore
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>{/* end content card */}

      {/* Pane Composer — separate raised card */}
      <DigestInput nodeId={digestNode.nodeId} createChildChat={createChildChat} onNav={onNav} />
      </div>

      <aside
        style={{
          width: 280,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: '18px 14px',
          alignSelf: 'flex-start',
          position: 'sticky',
          top: 0,
          maxHeight: '100vh',
          overflowY: 'auto',
        }}
      >
        {/* OUTLINE card */}
        <div
          style={{
            background: 'var(--term-surface)',
            border: '1px solid var(--term-line)',
            boxShadow: '0 4px 12px rgba(26,25,22,.05), 0 1px 2px rgba(26,25,22,.03)',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--term-line)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 10,
              color: 'var(--term-muted)',
              letterSpacing: '.14em',
              textTransform: 'uppercase',
            }}
          >
            OUTLINE
          </div>
          <div style={{ padding: '6px 0' }}>
            {/* TL;DR item */}
            {parsed?.tldr && (
              <div
                onClick={() => scrollToSection(-1)}
                style={{
                  padding: '7px 14px',
                  fontSize: 11.5,
                  color: 'var(--term-fg)',
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  background: activeOutlineIdx === -1 ? 'rgba(47,107,78,.08)' : 'transparent',
                  borderLeft: activeOutlineIdx === -1 ? '2px solid var(--term-digest)' : '2px solid transparent',
                  transition: 'background 150ms, border-color 150ms',
                }}
              >
                <span style={{ fontSize: 10, color: 'var(--term-muted)' }}>tl;dr</span>
                <span style={{ fontFamily: 'var(--ui-font)', fontWeight: 500 }}>Summary</span>
              </div>
            )}
            {/* Section items */}
            {parsed?.sections.map((s, i) => (
              <div
                key={i}
                onClick={() => scrollToSection(i)}
                style={{
                  padding: '7px 14px 7px 18px',
                  fontSize: 11.5,
                  color: activeOutlineIdx === i ? 'var(--term-fg)' : 'var(--term-mid)',
                  fontFamily: 'var(--ui-font)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  background: activeOutlineIdx === i ? 'rgba(47,107,78,.08)' : 'transparent',
                  borderLeft: activeOutlineIdx === i ? '2px solid var(--term-digest)' : '2px solid transparent',
                  transition: 'background 150ms, border-color 150ms, color 150ms',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, color: 'var(--term-muted)', minWidth: 16 }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* SOURCES card */}
        <div
          style={{
            background: 'var(--term-surface)',
            border: '1px solid var(--term-line)',
            boxShadow: '0 4px 12px rgba(26,25,22,.05), 0 1px 2px rgba(26,25,22,.03)',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--term-line)',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 10,
              color: 'var(--term-muted)',
              letterSpacing: '.14em',
              textTransform: 'uppercase',
            }}
          >
            SOURCES · {liveSources.length}
          </div>
          <div className="term-scrollbar" style={{ maxHeight: 200, overflowY: 'auto' }}>
            {liveSources.map((id) => {
              const n = nodesSnapshot[id];
              const isStale = stale.includes(id);
              const isNew = !d.sources.includes(id);
              if (!n) {
                return (
                  <div
                    key={id}
                    style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--term-line)',
                      fontSize: 10.5,
                      color: 'var(--term-muted)',
                    }}
                  >
                    {id} · deleted
                  </div>
                );
              }
              return (
                <div
                  key={id}
                  onClick={() => openPane(id)}
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--term-line)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <Dot
                    color={
                      isNew
                        ? 'var(--term-accent)'
                        : isStale
                          ? 'var(--term-select)'
                          : 'var(--term-digest)'
                    }
                    size={5}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--term-fg)',
                        fontFamily: 'var(--ui-font)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {n.title || chatLabel(n) || id}
                    </div>
                    <div style={{ fontSize: 9.5, color: 'var(--term-muted)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                      {n.messageCount ?? n.messages.length} msgs · in sync
                    </div>
                  </div>
                  {isNew ? (
                    <Tag color="var(--term-accent)">new</Tag>
                  ) : isStale ? (
                    <Tag color="var(--term-select)">stale</Tag>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* DIGEST operations card */}
        <div
          style={{
            background: 'var(--term-surface)',
            border: '1px solid var(--term-line)',
            boxShadow: '0 4px 12px rgba(26,25,22,.05), 0 1px 2px rgba(26,25,22,.03)',
            padding: '14px',
          }}
        >
          <div
            style={{
              padding: '0 0 10px',
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 10,
              color: 'var(--term-muted)',
              letterSpacing: '.14em',
              textTransform: 'uppercase',
            }}
          >
            DIGEST
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginBottom: 12, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
            scope thread · updated {d.status === 'streaming' ? 'streaming…' : formatRelative(d.generatedAt)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => void refreshDigest(digestNode.nodeId)}
              disabled={d.status === 'streaming'}
              style={{
                flex: 1,
                padding: '7px 12px',
                border: 'none',
                background: 'var(--term-digest)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 11,
                cursor: d.status === 'streaming' ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--ui-font)',
                opacity: d.status === 'streaming' ? 0.6 : 1,
              }}
            >
              ↻ Rebuild
            </button>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('michi:toggle-export-panel', {
                    detail: { mode: 'export', digestNodeId: digestNode.nodeId },
                  }),
                )
              }
              style={{
                flex: 1,
                padding: '7px 12px',
                border: '1px solid var(--term-line)',
                background: 'transparent',
                color: 'var(--term-mid)',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'var(--ui-font)',
              }}
            >
              ↓ Export
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
