import React from 'react';
import { useChatStore, useChatNodesSnapshot, useStructuralSelector } from '../../../state/chatStore';
import { setManageWorkspaceId } from '../../../state/manageRoute';
import { Dot } from '../primitives';
import { initialOf, workspaceAccent } from '../workspaceAccent';
import ContextMenu, { type MenuSection } from '../../ContextMenu';
import {
  buildWorkspaceRowContextMenu,
  type ContextMenuSection,
} from '../../../lib/workspaceRowContextMenu';
import type { PageId } from '../../../state/commands';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { getElectron } from '../../../lib/electronBridge';
import { toast } from 'sonner';

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

interface ThreadPreview { title: string; age: string; branches: number; activeAt: number }
interface NodeMeta { title: string; lastActiveAt: number; kind: 'chat' | 'digest' }
interface WorkspaceCardData {
  id: string;
  name: string;
  cwd?: string;
  active: boolean;
  liveCount: number;
  branches: number;
  threadCount: number;
  streaming: number;
  digests: number;
  lastTs: number;
  threads: ThreadPreview[];
  /** All live nodes with a derivable title — used for filter scope and for the
   * search-result preview that replaces "Recent threads" while a query is
   * active. */
  nodes: NodeMeta[];
  models: string[];
  spark: number[];
}

function buildCard(p: Project, snapshot: Record<string, ChatNodeState>, streamingIds: Set<string>, activeProjectId: string | null): WorkspaceCardData {
  const liveIds = p.chatIds.filter((id) => !snapshot[id]?.deletedAt);
  const liveCount = liveIds.length;
  const streaming = liveIds.filter((id) => streamingIds.has(id)).length;
  const digests = liveIds.filter((id) => snapshot[id]?.kind === 'digest').length;

  const liveTrees = p.trees.filter((t) => !t.archivedAt);
  const sortedTrees = [...liveTrees].sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  const threads: ThreadPreview[] = sortedTrees.slice(0, 3).map((t) => {
    const root = snapshot[t.rootNodeId];
    const title = (t.name && t.name.trim())
      || (root?.title && root.title.trim())
      || (root?.messages?.[0]?.text || '').slice(0, 60)
      || '(untitled)';
    let branches = 0;
    for (const id of p.chatIds) {
      const n = snapshot[id];
      if (!n || n.deletedAt) continue;
      if (n.parentNodeId && treeContains(p, snapshot, t.rootNodeId, id)) branches++;
    }
    return {
      title,
      age: formatRelative(t.lastActiveAt || t.createdAt),
      branches: Math.max(0, branches - 1),
      activeAt: t.lastActiveAt || t.createdAt,
    };
  });

  const modelSet = new Set<string>();
  for (const id of liveIds) {
    const m = snapshot[id]?.modelId;
    if (m) modelSet.add(shortModelLabel(m));
  }

  const spark = fourteenDaySpark(liveIds, snapshot);
  const branchesTotal = Math.max(0, liveCount - liveTrees.length);
  // "Last conversation time": the most recent message timestamp across this
  // workspace. Falls back to tree.lastActiveAt, then to project.createdAt for
  // legacy workspaces with no messages persisted.
  let lastMsgTs = 0;
  for (const id of liveIds) {
    const n = snapshot[id];
    if (!n) continue;
    for (const m of n.messages || []) {
      if (m.createdAt && m.createdAt > lastMsgTs) lastMsgTs = m.createdAt;
    }
  }
  const lastTreeTs = sortedTrees[0]?.lastActiveAt || 0;
  const lastTs = lastMsgTs || lastTreeTs || p.createdAt;

  const nodes: NodeMeta[] = [];
  for (const id of liveIds) {
    const n = snapshot[id];
    if (!n) continue;
    const title =
      (n.title && n.title.trim())
      || ((n.messages?.[0]?.text || '').slice(0, 80).trim());
    if (!title) continue;
    let ts = 0;
    for (const m of n.messages || []) {
      if (m.createdAt && m.createdAt > ts) ts = m.createdAt;
    }
    nodes.push({
      title,
      lastActiveAt: ts,
      kind: n.kind === 'digest' ? 'digest' : 'chat',
    });
  }

  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd,
    active: p.id === activeProjectId,
    liveCount,
    branches: branchesTotal,
    threadCount: liveTrees.length,
    streaming,
    digests,
    lastTs,
    threads,
    nodes,
    models: Array.from(modelSet).slice(0, 3),
    spark,
  };
}

function treeContains(p: Project, snapshot: Record<string, ChatNodeState>, rootId: string, nodeId: string): boolean {
  let cur: string | undefined = nodeId;
  let guard = 0;
  while (cur && guard++ < 256) {
    if (cur === rootId) return true;
    const n: ChatNodeState | undefined = snapshot[cur];
    if (!n || n.deletedAt) return false;
    cur = n.parentNodeId;
  }
  return false;
}

function fourteenDaySpark(nodeIds: string[], snapshot: Record<string, ChatNodeState>): number[] {
  const out = new Array(14).fill(0);
  const now = Date.now();
  const dayMs = 86_400_000;
  for (const id of nodeIds) {
    const n = snapshot[id];
    if (!n) continue;
    for (const msg of n.messages || []) {
      const t = msg.createdAt;
      if (!t) continue;
      const daysAgo = Math.floor((now - t) / dayMs);
      if (daysAgo >= 0 && daysAgo < 14) out[13 - daysAgo]++;
    }
  }
  return out;
}

function shortModelLabel(modelId: string): string {
  // claude-opus-4-5 -> opus, claude-sonnet-4-5 -> sonnet, gpt-5 -> gpt-5
  const m = modelId.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return modelId.split('/').pop()!.split(':')[0];
}

function sparkPath(values: number[], w: number, h: number, pad = 1.5): string {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const step = (w - pad * 2) / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function Sparkline({ values, color, width = 110, height = 22 }: { values: number[]; color: string; width?: number; height?: number }) {
  const path = sparkPath(values, width, height);
  const area = path + ` L${width - 1.5},${height - 1.5} L${1.5},${height - 1.5} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
      <path d={area} fill={color} opacity="0.18" />
      <path d={path} stroke={color} strokeWidth="1.1" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function toMenuSections(sections: ContextMenuSection[]): MenuSection[] {
  return sections.map((s, si) => ({
    items: s.items.map((item, ii) => ({
      id: `${si}-${ii}`,
      label: item.label,
      danger: item.danger,
      disabled: item.disabled,
      keys: item.keys,
      run: item.onSelect,
    })),
  }));
}

export default function TerminalWorkspaces({ onNav }: { onNav: (p: PageId) => void }) {
  const {
    projects,
    activeProjectId,
    deleteProject,
    renameProject,
    setProjectCwd,
    archiveProject,
    unarchiveProject,
    pinProject,
    unpinProject,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const streamingIds = useStructuralSelector(
    (ns) => {
      const out = new Set<string>();
      for (const [id, n] of Object.entries(ns)) {
        if (n.status === 'streaming') out.add(id);
      }
      return out;
    },
    (a, b) => {
      if (a === b) return true;
      if (a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
      return true;
    },
  );
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);

  const changeFolder = React.useCallback(async (projectId: string) => {
    const electron = getElectron();
    if (!electron) {
      toast.info('Linking a local folder requires the desktop app.');
      return;
    }
    try {
      const result = await electron.chooseFolder();
      if (result.canceled || !result.path) return;
      setProjectCwd(projectId, result.path);
      toast.success('Workspace folder updated');
    } catch (error) {
      toast.error(`Could not update folder: ${(error as Error).message}`);
    }
  }, [setProjectCwd]);

  const menuSections = React.useMemo<MenuSection[]>(() => {
    if (!menu) return [];
    const p = projects.find((pp) => pp.id === menu.id);
    if (!p) return [];
    return toMenuSections(
      buildWorkspaceRowContextMenu({
        project: p,
        actions: {
          archiveProject,
          unarchiveProject,
          pinProject,
          unpinProject,
          deleteProject,
          beginInlineRename: (id) => setRenamingId(id),
          openManageWorkspace: (id) => {
            setManageWorkspaceId(id);
            onNav('workspace-manage');
          },
          changeFolder: (id) => { void changeFolder(id); },
        },
      }),
    );
  }, [menu, projects, archiveProject, unarchiveProject, pinProject, unpinProject, deleteProject, changeFolder, onNav]);

  const [query, setQuery] = React.useState('');

  const allCards = React.useMemo(() => {
    return projects
      .filter((p) => !p.deletedAt && !p.archivedAt)
      .map((p) => buildCard(p, nodesSnapshot, streamingIds, activeProjectId))
      .sort((a, b) => b.lastTs - a.lastTs);
  }, [projects, nodesSnapshot, streamingIds, activeProjectId]);

  const cards = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCards;
    return allCards.filter((c) =>
      c.name.toLowerCase().includes(q)
      || (c.cwd?.toLowerCase().includes(q) ?? false)
      || c.threads.some((t) => t.title.toLowerCase().includes(q))
      || c.nodes.some((n) => n.title.toLowerCase().includes(q)),
    );
  }, [allCards, query]);

  const totals = React.useMemo(() => {
    let nodes = 0, threads = 0, streaming = 0, digests = 0;
    let lastTs = 0;
    for (const c of allCards) {
      nodes += c.liveCount;
      threads += c.threadCount;
      streaming += c.streaming;
      digests += c.digests;
      if (c.lastTs > lastTs) lastTs = c.lastTs;
    }
    return { nodes, threads, streaming, digests, lastTs };
  }, [allCards]);

  const openNew = () => window.dispatchEvent(new CustomEvent('michi:open-new-workspace'));

  return (
    <div
      className="term-scrollbar"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '40px 48px 56px',
        background: 'var(--term-bg)',
      }}
    >
      <header style={{ marginBottom: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--ui-font)',
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: '.16em',
                textTransform: 'uppercase',
                color: 'var(--term-fg)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 4,
                  height: 12,
                  background: 'var(--term-accent)',
                }}
              />
              workspaces
            </h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, justifyContent: 'flex-end' }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--term-line)',
                background: 'var(--term-surface)',
                padding: '0 8px',
                height: 30,
                minWidth: 220,
                maxWidth: 320,
                flex: '0 1 280px',
              }}
            >
              <span style={{ color: 'var(--term-faint, var(--term-muted))', fontSize: 11 }}>⌕</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter workspaces, threads, paths…"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 12,
                  color: 'var(--term-fg)',
                  padding: 0,
                  height: 28,
                }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear"
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--term-muted)',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={openNew}
              style={{
                padding: '0 14px',
                height: 30,
                border: '1px solid var(--term-fg)',
                background: 'var(--term-fg)',
                color: 'var(--term-surface)',
                fontFamily: 'var(--ui-font)',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '.02em',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              + new workspace
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            flexWrap: 'wrap',
            paddingTop: 10,
            borderTop: '1px solid var(--term-line)',
            fontFamily: 'var(--ui-font)',
            fontSize: 11.5,
            color: 'var(--term-muted)',
            letterSpacing: '.04em',
          }}
        >
          <Metric label="workspaces" value={allCards.length} />
          <MetricSep />
          <Metric label="nodes" value={totals.nodes} />
          <MetricSep />
          <Metric label="threads" value={totals.threads} />
          <MetricSep />
          <Metric
            label="streaming"
            value={totals.streaming}
            color={totals.streaming > 0 ? 'var(--term-select, var(--term-accent))' : undefined}
            pulse={totals.streaming > 0}
          />
          <MetricSep />
          <Metric
            label="digests"
            value={totals.digests}
            color={totals.digests > 0 ? 'var(--term-digest, #2f6b4e)' : undefined}
          />
          <span style={{ flex: 1 }} />
          {totals.lastTs > 0 && (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              last activity{' '}
              <span style={{ color: 'var(--term-fg)' }}>{formatRelative(totals.lastTs)} ago</span>
            </span>
          )}
        </div>
      </header>

      {cards.length === 0 ? (
        allCards.length === 0 ? (
          <EmptyState onNew={openNew} />
        ) : (
          <div
            style={{
              padding: '40px 20px',
              textAlign: 'center',
              color: 'var(--term-muted)',
              fontSize: 13,
              border: '1px dashed var(--term-line)',
              background: 'var(--term-surface)',
            }}
          >
            No workspaces match &ldquo;{query}&rdquo;.
          </div>
        )
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 18,
          }}
        >
          {cards.map((w) => (
            <WorkspaceCard
              key={w.id}
              w={w}
              query={query.trim()}
              hover={hoverId === w.id}
              renaming={renamingId === w.id}
              onEnter={() => setHoverId(w.id)}
              onLeave={() => setHoverId((cur) => (cur === w.id ? null : cur))}
              onOpen={() => {
                setManageWorkspaceId(w.id);
                onNav('workspace-manage');
              }}
              onOpenMenu={(rect) => {
                setMenu({ id: w.id, x: rect.right, y: rect.bottom + 4 });
              }}
              onCommitRename={(name) => {
                const trimmed = name.trim();
                if (trimmed && trimmed !== w.name) renameProject(w.id, trimmed);
                setRenamingId(null);
              }}
              onCancelRename={() => setRenamingId(null)}
            />
          ))}
        </div>
      )}

      {menu && menuSections.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={menuSections}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function WorkspaceCard({
  w,
  query,
  hover,
  renaming,
  onEnter,
  onLeave,
  onOpen,
  onOpenMenu,
  onCommitRename,
  onCancelRename,
}: {
  w: WorkspaceCardData;
  query: string;
  hover: boolean;
  renaming: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
  onOpenMenu: (rect: DOMRect) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  // While the filter is active, replace the "Recent threads" preview with the
  // top matching nodes so the user sees *why* this card matched. Falls back
  // to recent threads if only name/cwd matched (no node-title hit).
  const matchedNodes = React.useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return w.nodes
      .filter((n) => n.title.toLowerCase().includes(q))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 3);
  }, [query, w.nodes]);
  const showMatches = query !== '' && matchedNodes.length > 0;
  const accent = workspaceAccent(w.id);
  const renameRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState(w.name);
  React.useEffect(() => {
    if (renaming) {
      setDraft(w.name);
      requestAnimationFrame(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      });
    }
  }, [renaming, w.name]);

  return (
    <article
      onClick={() => { if (!renaming) onOpen(); }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        background: 'var(--term-surface)',
        border: '1px solid var(--term-line)',
        borderTop: `2px solid ${accent}`,
        padding: '18px 18px 16px',
        cursor: 'pointer',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 240,
        outline: w.active ? `1px solid var(--term-accent)` : 'none',
        outlineOffset: w.active ? -1 : 0,
      }}
    >
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <span
          style={{
            width: 36,
            height: 36,
            background: accent,
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            fontFamily: 'var(--ui-font)',
            flexShrink: 0,
          }}
        >
          {initialOf(w.name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              ref={renameRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => onCommitRename(draft)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); onCommitRename(draft); }
                if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
              }}
              style={{
                width: '100%',
                fontFamily: 'var(--ui-font)',
                fontSize: 16,
                lineHeight: 1.25,
                fontWeight: 600,
                color: 'var(--term-fg)',
                letterSpacing: 0,
                background: 'var(--term-bg)',
                border: '1px solid var(--term-accent)',
                padding: '2px 6px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          ) : (
            <div
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 16,
                lineHeight: 1.25,
                fontWeight: 600,
                color: 'var(--term-fg)',
                letterSpacing: 0,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              <Highlight text={w.name} q={query} />
            </div>
          )}
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--term-muted)',
              marginTop: 3,
              fontFamily: w.cwd ? 'var(--font-mono, ui-monospace, monospace)' : 'var(--ui-font)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: w.cwd ? '0' : '.04em',
              textTransform: w.cwd ? 'none' : 'uppercase',
            }}
          >
            {w.cwd
              ? <Highlight text={w.cwd} q={query} />
              : 'quick chat · no folder'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {w.streaming > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 9.5,
                color: 'var(--term-select, var(--term-accent))',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '.08em',
              }}
            >
              <Dot color="var(--term-select, var(--term-accent))" size={6} pulse />
              LIVE
            </span>
          )}
          {w.active && !w.streaming && (
            <span
              style={{
                fontSize: 9.5,
                color: 'var(--term-accent)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '.08em',
              }}
            >
              ACTIVE
            </span>
          )}
        </div>
      </div>

      {/* Stats block (replaces tree preview) */}
      <div
        style={{
          background: 'var(--term-bg)',
          border: '1px solid var(--term-line)',
          padding: '10px 12px',
          marginBottom: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
        }}
      >
        <Stat label="nodes" value={String(w.liveCount)} />
        <Stat label="threads" value={String(w.threadCount)} />
        <Stat
          label="digests"
          value={w.digests > 0 ? `§ ${w.digests}` : '—'}
          color={w.digests > 0 ? 'var(--term-digest, #2f6b4e)' : undefined}
        />
      </div>

      {/* Preview list: matched nodes while filtering, recent threads otherwise. */}
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px', flex: 1 }}>
        {showMatches
          ? matchedNodes.map((n, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '4px 0',
                  borderTop: i === 0 ? 'none' : '1px dashed var(--term-line)',
                  fontSize: 12,
                  color: 'var(--term-fg)',
                }}
              >
                <span
                  style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                  }}
                >
                  {n.kind === 'digest' && (
                    <span style={{ color: 'var(--term-digest, #2f6b4e)', marginRight: 4 }}>§</span>
                  )}
                  <Highlight text={n.title} q={query} />
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--term-faint, var(--term-muted))',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    flexShrink: 0,
                  }}
                >
                  {n.lastActiveAt > 0 ? formatRelative(n.lastActiveAt) : '—'}
                </span>
              </li>
            ))
          : w.threads.map((t, i) => (
              <li
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '4px 0',
                  borderTop: i === 0 ? 'none' : '1px dashed var(--term-line)',
                  fontSize: 12,
                  color: 'var(--term-fg)',
                }}
              >
                <span
                  style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                  }}
                >
                  <Highlight text={t.title} q={query} />
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--term-faint, var(--term-muted))',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    flexShrink: 0,
                  }}
                >
                  {t.branches > 0 && <span style={{ marginRight: 6 }}>⎇{t.branches}</span>}
                  {t.age}
                </span>
              </li>
            ))}
        {!showMatches && w.threads.length === 0 && (
          <li
            style={{
              fontSize: 11.5,
              color: 'var(--term-faint, var(--term-muted))',
              fontStyle: 'italic',
              padding: '4px 0',
            }}
          >
            No threads yet.
          </li>
        )}
      </ul>

      {/* Footer: sparkline + models */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--term-line)',
          paddingTop: 10,
          gap: 10,
        }}
      >
        <Sparkline values={w.spark} color={accent} />
        <div
          style={{
            fontSize: 9.5,
            color: 'var(--term-muted)',
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            display: 'flex',
            gap: 8,
          }}
        >
          {w.models.map((m) => (
            <span key={m} style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{m}</span>
          ))}
        </div>
      </div>

      {/* Kebab menu — three dots, top-right */}
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu(e.currentTarget.getBoundingClientRect());
        }}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          width: 24,
          height: 24,
          border: '1px solid transparent',
          background: 'transparent',
          color: 'var(--term-muted)',
          opacity: hover ? 1 : 0.45,
          transition: 'opacity 100ms, background 100ms, border-color 100ms',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--term-hover-bg, var(--term-alt))';
          e.currentTarget.style.borderColor = 'var(--term-line)';
          e.currentTarget.style.color = 'var(--term-fg)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.borderColor = 'transparent';
          e.currentTarget.style.color = 'var(--term-muted)';
        }}
      >
        ⋯
      </button>
    </article>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span
        style={{
          color: 'var(--term-muted)',
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          fontSize: 9.5,
          fontFamily: 'var(--ui-font)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          color: color || 'var(--term-fg)',
          fontWeight: 500,
          fontSize: 13,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Metric({ label, value, color, pulse }: { label: string; value: number; color?: string; pulse?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {pulse && <Dot color={color || 'var(--term-accent)'} size={6} pulse />}
      <span
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontVariantNumeric: 'tabular-nums',
          color: color || 'var(--term-fg)',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {value}
      </span>
      <span style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 10.5 }}>{label}</span>
    </span>
  );
}

function MetricSep() {
  return <span style={{ color: 'var(--term-faint, var(--term-line))' }} aria-hidden>│</span>;
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const needle = q.toLowerCase();
  const haystack = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit < 0) { parts.push(text.slice(cursor)); break; }
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark
        key={key++}
        style={{
          background: 'color-mix(in srgb, var(--term-accent) 28%, transparent)',
          color: 'inherit',
          padding: '0 1px',
          borderRadius: 1,
        }}
      >
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    cursor = hit + q.length;
  }
  return <>{parts}</>;
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      style={{
        margin: '40px auto',
        maxWidth: 520,
        padding: '40px 32px',
        border: '1px dashed var(--term-line)',
        background: 'var(--term-surface)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 18,
          lineHeight: 1.3,
          fontWeight: 600,
          color: 'var(--term-fg)',
          marginBottom: 8,
        }}
      >
        Nothing here yet.
      </div>
      <p
        style={{
          margin: '0 0 20px',
          fontSize: 13,
          color: 'var(--term-muted)',
          lineHeight: 1.6,
        }}
      >
        Workspaces hold all the threads, branches, and digests for one corner of your
        thinking. Make one for a project, a question, or whatever you keep coming back to.
      </p>
      <button
        type="button"
        onClick={onNew}
        style={{
          padding: '10px 18px',
          border: '1px solid var(--term-fg)',
          background: 'var(--term-fg)',
          color: 'var(--term-surface)',
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '.02em',
          cursor: 'pointer',
        }}
      >
        + new workspace
      </button>
    </div>
  );
}
