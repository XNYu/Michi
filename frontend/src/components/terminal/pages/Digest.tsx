import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore, useChatNodesSnapshot, useChatNode, chatLabel } from '../../../state/chatStore';
import { parseDigestStructure, staleSources } from '../../../state/digest';
import { findTreeIdForNode, descendants } from '../../../state/tree';
import MarkdownContent from '../../MarkdownContent';
import { Dot, Tag } from '../primitives';
import type { PageId } from '../../../state/commands';
import { requestDigest } from '../../../lib/digestPrompt';
import type { ChatNodeState, Tree } from '../../../state/chatTypes';
import { visibleMessageText } from '../../../state/assistantBlocks';

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
        borderTop: '1px solid var(--term-line)',
        padding: '8px 28px',
        background: 'var(--term-surface)',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder="Ask a follow-up…"
        style={{
          flex: 1,
          background: 'var(--term-bg)',
          color: 'var(--term-fg)',
          border: '1px solid var(--term-line)',
          borderRadius: 4,
          padding: '6px 10px',
          fontSize: 12,
          fontFamily: 'var(--ui-font)',
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={send}
        disabled={!text.trim()}
        style={{
          padding: '6px 12px',
          border: '1px solid var(--term-digest)',
          background: text.trim() ? 'var(--term-digest-f)' : 'transparent',
          color: 'var(--term-digest)',
          fontWeight: 700,
          fontSize: 11,
          cursor: text.trim() ? 'pointer' : 'not-allowed',
          fontFamily: 'var(--ui-font)',
          opacity: text.trim() ? 1 : 0.4,
        }}
      >
        send
      </button>
    </div>
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

type ThreadStatus = 'generating' | 'fresh' | 'stale' | 'none' | 'empty';

interface ThreadRow {
  tree: Tree;
  rootNode: ChatNodeState;
  digestNode: ChatNodeState | null;
  staleCount: number;
  status: ThreadStatus;
  preview: string;
  /** Live chat-node ids belonging to this tree (root + descendants). Used as
   * sources when the user kicks off "create digest" from this row. */
  chatIds: string[];
  /** Total assistant/user messages across the tree's chat nodes — used to
   * decide if there's anything worth digesting. */
  msgCount: number;
}

function firstSnippet(node: ChatNodeState | null | undefined, max = 140): string {
  if (!node) return '';
  for (const m of node.messages) {
    if (m.role !== 'assistant') continue;
    const t = visibleMessageText(m).replace(/\s+/g, ' ').trim();
    if (t.length > 0) return t.length > max ? t.slice(0, max) + '…' : t;
  }
  for (const m of node.messages) {
    const t = visibleMessageText(m).replace(/\s+/g, ' ').trim();
    if (t.length > 0) return t.length > max ? t.slice(0, max) + '…' : t;
  }
  return '';
}

export default function TerminalDigest({
  onNav,
}: {
  onNav: (p: PageId) => void;
}) {
  const {
    activeProject,
    refreshDigest,
    setDigestPrompt,
    markDigestViewed,
    openPane,
    createChildChat,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();

  // View state. `null` = index page, otherwise = detail of that digest node.
  const [focusedDigestId, setFocusedDigestId] = useState<string | null>(null);
  const focusedDigestNode = useChatNode(focusedDigestId ?? '');
  const [promptOpen, setPromptOpen] = useState(false);

  // Map-page click and other call sites set the focused digest by event.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const ce = e as CustomEvent<{ nodeId?: string }>;
      if (ce.detail?.nodeId) setFocusedDigestId(ce.detail.nodeId);
    };
    window.addEventListener('michi:focus-digest', onFocus as EventListener);
    return () => window.removeEventListener('michi:focus-digest', onFocus as EventListener);
  }, []);

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

  // Per-thread row data for the index view. One row per live tree.
  const rows = useMemo<ThreadRow[]>(() => {
    if (!activeProject) return [];

    // Build tree -> [chat node ids] map by walking descendants from each root.
    const isAlive = (id: string) => {
      const n = nodesSnapshot[id];
      return !!n && !n.deletedAt;
    };
    const treeChatIds = new Map<string, string[]>();
    for (const t of activeProject.trees) {
      if (!isAlive(t.rootNodeId)) continue;
      const desc = descendants(t.rootNodeId, activeProject.edges, isAlive);
      const ids = [t.rootNodeId, ...desc].filter((id) => {
        const n = nodesSnapshot[id];
        return n && n.kind === 'chat' && !n.deletedAt;
      });
      treeChatIds.set(t.id, ids);
    }

    // For each tree, find the most recent digest whose first surviving source
    // resolves back to this tree. Mirrors the lookup used in the detail view.
    const treeDigests = new Map<string, ChatNodeState>();
    for (const id of activeProject.chatIds) {
      const n = nodesSnapshot[id];
      if (!n || n.kind !== 'digest' || n.deletedAt || !n.digest) continue;
      const src = n.digest.sources.find((sid) => nodesSnapshot[sid]);
      const tid = src ? findTreeIdForNode(src, activeProject) : null;
      if (!tid) continue;
      const prev = treeDigests.get(tid);
      if (!prev || (n.digest.generatedAt || 0) > (prev.digest!.generatedAt || 0)) {
        treeDigests.set(tid, n);
      }
    }

    const out: ThreadRow[] = [];
    const sortedTrees = [...activeProject.trees].sort((a, b) => a.createdAt - b.createdAt);
    for (const tree of sortedTrees) {
      const rootNode = nodesSnapshot[tree.rootNodeId];
      if (!rootNode || rootNode.deletedAt) continue;
      const chatIds = treeChatIds.get(tree.id) ?? [];
      const msgCount = chatIds.reduce(
        (acc, id) => {
          const n = nodesSnapshot[id];
          if (!n) return acc;
          return acc + (n.messageCount ?? n.messages.length);
        },
        0,
      );
      const digestNode = treeDigests.get(tree.id) ?? null;
      // A digest is stale when (a) a covered source's fingerprint changed, or
      // (b) the tree gained chats the digest hasn't seen yet (branched after
      // the digest was generated). Both cases mean a rebuild is warranted.
      const fingerprintStale = digestNode
        ? staleSources(digestNode.digest!, nodesSnapshot).length
        : 0;
      const newSinceDigest = digestNode
        ? chatIds.filter((id) => !digestNode.digest!.sources.includes(id)).length
        : 0;
      const staleCount = fingerprintStale + newSinceDigest;
      let status: ThreadStatus;
      if (digestNode && digestNode.digest!.status === 'streaming') {
        status = 'generating';
      } else if (digestNode) {
        status = staleCount > 0 ? 'stale' : 'fresh';
      } else if (msgCount === 0 || chatIds.length === 0) {
        status = 'empty';
      } else {
        status = 'none';
      }
      const preview = digestNode
        ? (parseDigestStructure(digestNode.digest!.content).tldr || digestNode.digest!.content || '').replace(/\s+/g, ' ').trim().slice(0, 180)
        : firstSnippet(rootNode);
      out.push({
        tree,
        rootNode,
        digestNode,
        staleCount,
        status,
        preview: preview.length > 180 ? preview.slice(0, 180) + '…' : preview,
        chatIds,
        msgCount,
      });
    }
    return out;
  }, [activeProject, nodesSnapshot]);

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

  // INDEX VIEW — card grid of all threads in this workspace.
  if (!digestNode) {
    return (
      <DigestIndex
        rows={rows}
        onOpen={(row) => setFocusedDigestId(row.digestNode!.nodeId)}
        onCreate={(row) => requestDigest(activeProject.id, row.chatIds)}
      />
    );
  }

  // DETAIL VIEW — existing single-digest layout.
  const d = digestNode.digest!;
  const title = digestNode.title || 'Workspace digest';

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--term-page-bg, var(--term-bg))' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="term-scrollbar" style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        <div
          style={{
            padding: '20px 28px 16px',
            background: 'var(--term-surface)',
            borderBottom: '1px solid var(--term-line)',
            WebkitAppRegion: 'drag',
          } as React.CSSProperties}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span
              onClick={() => setFocusedDigestId(null)}
              style={{
                fontSize: 11,
                color: 'var(--term-muted)',
                cursor: 'pointer',
                fontFamily: 'var(--ui-font)',
                padding: '2px 6px',
                border: '1px solid var(--term-line)',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
              title="Back to digest index"
            >
              ← all
            </span>
            <span style={{ width: 4, height: 24, background: 'var(--term-digest)' }} />
            <span style={{ color: 'var(--term-digest)', fontSize: 14, fontWeight: 700 }}>§</span>
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 20,
                fontWeight: 600,
                color: 'var(--term-fg)',
                letterSpacing: '-.01em',
              }}
            >
              {title}
            </span>
            {stale.length > 0 && <Tag color="var(--term-select)">{stale.length} stale</Tag>}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => void refreshDigest(digestNode.nodeId)}
              disabled={d.status === 'streaming'}
              style={{
                padding: '5px 10px',
                border: '1px solid var(--term-digest)',
                background: d.status === 'streaming' ? 'var(--term-alt)' : 'var(--term-digest-f)',
                color: 'var(--term-digest)',
                fontWeight: 700,
                fontSize: 11,
                cursor: d.status === 'streaming' ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--ui-font)',
                opacity: d.status === 'streaming' ? 0.6 : 1,
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              {d.status === 'streaming' ? '⟳ rebuilding…' : '↻ rebuild'}
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
                padding: '5px 10px',
                border: '1px solid var(--term-line)',
                color: 'var(--term-mid)',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'var(--ui-font)',
                background: 'transparent',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              ↓ export .md
            </button>
          </div>
          <div style={{ display: 'flex', gap: 18, fontSize: 11, color: 'var(--term-muted)' }}>
            <span><span style={{ color: 'var(--term-mid)' }}>scope</span> workspace</span>
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
        </div>

        {/* Custom prompt editor */}
        <div style={{ margin: '0 28px', borderBottom: '1px solid var(--term-line)' }}>
          <div
            onClick={() => setPromptOpen((v) => !v)}
            style={{
              padding: '8px 0',
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
            <div style={{ paddingBottom: 10 }}>
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

        {parsed?.tldr && (
          <div
            style={{
              margin: '18px 28px 0',
              padding: '14px 16px',
              border: '1px solid var(--term-line)',
              background: 'var(--term-surface)',
              borderLeft: '3px solid var(--term-fg)',
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
                    marginBottom: 14,
                    padding: '12px 16px',
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
                        fontSize: 14,
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
                          fontSize: 10,
                          color: 'var(--term-mauve)',
                          fontFamily: 'var(--ui-font)',
                          cursor: 'pointer',
                        }}
                      >
                        ↗ {s.sourceId.slice(0, 6)}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--ui-font)',
                      fontSize: 12.5,
                      color: 'var(--term-mid)',
                      lineHeight: 1.6,
                      paddingLeft: 4,
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
                fontSize: 10,
                color: 'var(--term-muted)',
                letterSpacing: '.14em',
                marginBottom: 8,
              }}
            >
              ▸ OPEN THREADS
            </div>
            <div
              style={{
                border: '1px solid var(--term-line)',
                background: 'var(--term-surface)',
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
      </div>

      {/* Chat input for continued conversation from digest */}
      <DigestInput nodeId={digestNode.nodeId} createChildChat={createChildChat} onNav={onNav} />
      </div>

      <aside
        style={{
          width: 260,
          flexShrink: 0,
          background: 'var(--term-surface)',
          borderLeft: '1px solid var(--term-line)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--term-line)',
            fontSize: 10,
            color: 'var(--term-muted)',
            letterSpacing: '.14em',
          }}
        >
          ▸ SOURCES · {liveSources.length}
        </div>
        <div className="term-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
          {liveSources.map((id) => {
            const n = nodesSnapshot[id];
            const isStale = stale.includes(id);
            // A node is "new" if it's part of the live tree but wasn't in the
            // digest's source snapshot — i.e. branched after the digest was
            // generated. Surface it so the user knows a rebuild will pick it up.
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
                  <div style={{ fontSize: 9.5, color: 'var(--term-muted)' }}>
                    {n.messageCount ?? n.messages.length} msgs
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
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Index view — card grid, one row per thread.
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  ThreadStatus,
  { label: string; glyph: string; color: string; tagColor: string }
> = {
  generating: { label: 'GENERATING', glyph: '⟳', color: 'var(--term-select)', tagColor: 'var(--term-select)' },
  fresh: { label: 'FRESH', glyph: '●', color: 'var(--term-digest)', tagColor: 'var(--term-digest)' },
  stale: { label: 'STALE', glyph: '◐', color: 'var(--term-select)', tagColor: 'var(--term-select)' },
  none: { label: 'NO DIGEST', glyph: '○', color: 'var(--term-mid)', tagColor: 'var(--term-mid)' },
  empty: { label: 'EMPTY', glyph: '─', color: 'var(--term-faint)', tagColor: 'var(--term-faint)' },
};

/** Status indicator drawn with CSS shapes so all variants share an exact
 *  optical center with the adjacent uppercase label (text glyphs like ●/◐/○
 *  sit at x-height and drift below the cap-line). */
function StatusGlyph({ status, color }: { status: ThreadStatus; color: string }) {
  const base: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
    color,
  };
  if (status === 'fresh') {
    return <span style={{ ...base, background: color }} />;
  }
  if (status === 'none') {
    return <span style={{ ...base, border: `1px solid ${color}` }} />;
  }
  if (status === 'stale') {
    return (
      <span
        style={{
          ...base,
          border: `1px solid ${color}`,
          background: `linear-gradient(90deg, ${color} 50%, transparent 50%)`,
        }}
      />
    );
  }
  if (status === 'empty') {
    return <span style={{ width: 8, height: 1, background: color, flexShrink: 0 }} />;
  }
  // generating — bordered ring with a transparent quadrant, spinning + pulsing
  return (
    <span
      style={{
        ...base,
        border: `1.5px solid ${color}`,
        borderTopColor: 'transparent',
        animation: 'tspin 1.1s linear infinite, tpulse-glyph 1.1s ease-in-out infinite',
      }}
    />
  );
}

function DigestIndex({
  rows,
  onOpen,
  onCreate,
}: {
  rows: ThreadRow[];
  onOpen: (row: ThreadRow) => void;
  onCreate: (row: ThreadRow) => void;
}) {
  const counts = useMemo(() => {
    const c = { total: rows.length, generating: 0, fresh: 0, stale: 0, none: 0, empty: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--term-page-bg, var(--term-bg))' }}>
      {/* toolbar */}
      <div
        style={{
          height: 36,
          borderBottom: '1px solid var(--term-line)',
          background: 'var(--term-surface)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 14px',
          gap: 14,
          fontSize: 11,
          flexShrink: 0,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        <span style={{ color: 'var(--term-fg)', fontWeight: 600 }}>
          {counts.total} thread{counts.total === 1 ? '' : 's'}
        </span>
        {counts.generating > 0 && (
          <>
            <span style={{ color: 'var(--term-muted)' }}>·</span>
            <span style={{ color: 'var(--term-select)' }}>{counts.generating} generating</span>
          </>
        )}
        {counts.fresh > 0 && (
          <>
            <span style={{ color: 'var(--term-muted)' }}>·</span>
            <span style={{ color: 'var(--term-digest)' }}>{counts.fresh} fresh</span>
          </>
        )}
        {counts.stale > 0 && (
          <>
            <span style={{ color: 'var(--term-muted)' }}>·</span>
            <span style={{ color: 'var(--term-select)' }}>{counts.stale} stale</span>
          </>
        )}
        {counts.none > 0 && (
          <>
            <span style={{ color: 'var(--term-muted)' }}>·</span>
            <span style={{ color: 'var(--term-mid)' }}>{counts.none} no digest</span>
          </>
        )}
      </div>

      {rows.length === 0 ? (
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
          — no threads in this workspace —
        </div>
      ) : (
        <div
          className="term-scrollbar"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 18,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 14,
            alignContent: 'start',
          }}
        >
          {rows.map((row) => (
            <DigestIndexCard
              key={row.tree.id}
              row={row}
              onOpen={() => onOpen(row)}
              onCreate={() => onCreate(row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DigestIndexCard({
  row,
  onOpen,
  onCreate,
}: {
  row: ThreadRow;
  onOpen: () => void;
  onCreate: () => void;
}) {
  const meta = STATUS_META[row.status];
  const title = row.tree.name || row.rootNode.title || chatLabel(row.rootNode) || row.rootNode.nodeId;
  const ts = row.digestNode?.digest?.generatedAt;
  const interactive =
    row.status === 'fresh' ||
    row.status === 'stale' ||
    row.status === 'none' ||
    row.status === 'generating';

  const onClick = () => {
    if (row.status === 'fresh' || row.status === 'stale' || row.status === 'generating') onOpen();
    else if (row.status === 'none') onCreate();
  };

  return (
    <div
      onClick={interactive ? onClick : undefined}
      style={{
        position: 'relative',
        border: '1px solid var(--term-line)',
        background: 'var(--term-surface)',
        padding: '12px 14px 14px',
        cursor: interactive ? 'pointer' : 'default',
        opacity: row.status === 'empty' ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 130,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, lineHeight: 1 }}>
        <StatusGlyph status={row.status} color={meta.color} />
        <span style={{ color: meta.color, fontWeight: 700, letterSpacing: '.12em', lineHeight: 1 }}>{meta.label}</span>
        {row.status === 'stale' && row.staleCount > 0 && (
          <span style={{ color: 'var(--term-muted)' }}>· {row.staleCount} src changed</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--term-muted)' }}>
          {row.status === 'generating' ? 'streaming…' : ts ? formatRelative(ts) : '—'}
        </span>
      </div>

      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 13.5,
          fontWeight: 600,
          color: 'var(--term-fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={title}
      >
        {title}
      </div>

      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 11.5,
          color: 'var(--term-muted)',
          lineHeight: 1.55,
          flex: 1,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {row.preview || (row.status === 'empty' ? 'no content yet' : '—')}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          color: 'var(--term-muted)',
          paddingTop: 6,
          borderTop: '1px dashed var(--term-line)',
        }}
      >
        <span>{row.msgCount} msg</span>
        {row.digestNode && (
          <>
            <span>·</span>
            <span>{row.digestNode.digest!.sources.length} sources</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        {row.status === 'fresh' || row.status === 'stale' ? (
          <span style={{ color: 'var(--term-accent)' }}>open ▸</span>
        ) : row.status === 'generating' ? (
          <span style={{ color: 'var(--term-select)' }}>watching ▸</span>
        ) : row.status === 'none' ? (
          <span style={{ color: 'var(--term-accent)' }}>+ create digest</span>
        ) : null}
      </div>
    </div>
  );
}
