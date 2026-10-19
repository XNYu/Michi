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
import { Search, X } from 'lucide-react';
import { Button } from '../../ui/controls';
import { WorkspaceLocation, workspaceMachineLabel } from '../../WorkspaceLocation';
import { useBackendConnections } from '../../../state/useBackendConnections';

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
  backendConnectionId?: string;
  active: boolean;
  liveCount: number;
  branches: number;
  threadCount: number;
  streaming: number;
  digests: number;
  lastTs: number;
  threads: ThreadPreview[];
  /** All live nodes with a derivable title — used for filter scope and for the
   * search-result preview that replaces the latest thread while a query is
   * active. */
  nodes: NodeMeta[];
  models: string[];
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
    backendConnectionId: p.backendConnectionId,
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

function shortModelLabel(modelId: string): string {
  // claude-fable-5 -> fable, claude-opus-4-5 -> opus, claude-sonnet-4-5 -> sonnet, gpt-5 -> gpt-5
  const m = modelId.toLowerCase();
  if (m.includes('fable')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return modelId.split('/').pop()!.split(':')[0];
}

/** `/Users/<name>/…` and `/home/<name>/…` read as `~/…` — the home prefix is
 *  the same on every row and only costs width. `/Users/Shared` is not anyone's
 *  home, so it stays as written. */
function displayPath(cwd: string): string {
  return cwd.replace(/^\/(?:Users|home)\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, '~');
}

/** The path as the row should show it for a given filter: shortened, unless the
 *  query only hits inside the part shortening would hide — then the full path,
 *  so the highlight has something to land on. */
function pathForQuery(cwd: string, query: string): string {
  const short = displayPath(cwd);
  if (!query) return short;
  const q = query.toLowerCase();
  if (short.toLowerCase().includes(q)) return short;
  return cwd.toLowerCase().includes(q) ? cwd : short;
}

type SortKey = 'name' | 'last';
type SortDir = 'asc' | 'desc';

/** Names start A→Z; recency starts newest first. */
const INITIAL_SORT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  last: 'desc',
};

function compareBy(key: SortKey, a: WorkspaceCardData, b: WorkspaceCardData): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'last':
    default:
      return a.lastTs - b.lastTs;
  }
}

const ROW_HEIGHT = 37;
/** Left gutter of the first column — room for the active row's accent bar. */
const FIRST_CELL_PAD = 10;

const TH_STYLE: React.CSSProperties = {
  padding: '0 12px 9px 0',
  textAlign: 'left',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 'var(--fs-sm)',
  fontWeight: 500,
  letterSpacing: 'var(--ls-caps)',
  textTransform: 'uppercase',
  color: 'var(--term-muted)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--term-line-s)',
};

const TD_STYLE: React.CSSProperties = {
  height: ROW_HEIGHT,
  padding: '0 12px 0 0',
  borderBottom: '1px solid var(--term-line)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: 'var(--fs-lg)',
  color: 'var(--term-fg)',
};

const TD_NUMERIC: React.CSSProperties = {
  ...TD_STYLE,
  textAlign: 'right',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 'var(--fs-md)',
  color: 'var(--term-mid)',
};

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

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
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({ key: 'last', dir: 'desc' });

  const changeFolder = React.useCallback(async (projectId: string) => {
    if (projects.find((project) => project.id === projectId)?.backendConnectionId) {
      toast.info('Remote workspace paths are edited as server paths from Workspace Manage.');
      return;
    }
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
  }, [projects, setProjectCwd]);

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
  const connections = useBackendConnections();
  const searchRef = React.useRef<HTMLInputElement>(null);

  const allCards = React.useMemo(() => {
    return projects
      .filter((p) => !p.deletedAt && !p.archivedAt)
      .map((p) => buildCard(p, nodesSnapshot, streamingIds, activeProjectId))
      .sort((a, b) => b.lastTs - a.lastTs);
  }, [projects, nodesSnapshot, streamingIds, activeProjectId]);

  const cards = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = !q
      ? allCards
      : allCards.filter((c) =>
          c.name.toLowerCase().includes(q)
          || workspaceMachineLabel(c.backendConnectionId, connections, ' - ').toLowerCase().includes(q)
          || (connections.find(connection => connection.id === c.backendConnectionId)?.sshHost?.toLowerCase().includes(q) ?? false)
          || (c.cwd?.toLowerCase().includes(q) ?? false)
          // …and the path as the row displays it, so typing `~/code` finds it.
          || (c.cwd ? displayPath(c.cwd).toLowerCase().includes(q) : false)
          || c.threads.some((t) => t.title.toLowerCase().includes(q))
          || c.nodes.some((n) => n.title.toLowerCase().includes(q)),
        );
    // allCards arrives newest-first; Array.prototype.sort is stable, so ties on
    // the chosen column keep that recency order.
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...matching].sort((a, b) => sign * compareBy(sort.key, a, b));
  }, [allCards, query, sort, connections]);

  const toggleSort = (key: SortKey) => {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: INITIAL_SORT_DIR[key] },
    );
  };

  const totals = React.useMemo(() => {
    let streaming = 0;
    let lastTs = 0;
    for (const c of allCards) {
      streaming += c.streaming;
      if (c.lastTs > lastTs) lastTs = c.lastTs;
    }
    return { streaming, lastTs };
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
      <header style={{
        marginBottom: 28,
      }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--ui-font)',
                fontSize: 'var(--fs-4xl)',
                fontWeight: 700,
                letterSpacing: 'var(--ls-tight)',
                color: 'var(--term-fg)',
              }}
            >
              Workspaces
            </h1>
            <span style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 'var(--fs-md)',
              color: 'var(--term-muted)',
            }}>
              {allCards.length}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, justifyContent: 'flex-end' }}>
            {/* The shared page-search field and primary Button — the same
                controls the Trash page's header uses. */}
            <label className="ui-search" style={{ minWidth: 220, maxWidth: 320, flex: '0 1 280px' }}>
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Filter workspaces"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter workspaces, machines, paths…"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </label>
            {/* Same height as the search field beside it. */}
            <Button variant="primary" onClick={openNew} style={{ height: 36, padding: '0 14px' }}>
              + new workspace
            </Button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            flexWrap: 'wrap',
            marginTop: 12,
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            color: 'var(--term-muted)',
            letterSpacing: 'var(--ls-wide)',
          }}
        >
          <Metric
            label="streaming"
            value={totals.streaming}
            color={totals.streaming > 0 ? 'var(--term-select, var(--term-accent))' : undefined}
            pulse={totals.streaming > 0}
          />
          <span style={{ flex: 1 }} />
          {totals.lastTs > 0 && (
            <span style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 'var(--fs-sm)' }}>
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
              fontSize: 'var(--fs-lg)',
              border: '1px solid var(--term-line)',
              background: 'var(--term-surface)',
              boxShadow: '0 1px 2px rgba(26,25,22,.04), 0 6px 18px rgba(26,25,22,.05)',
            }}
          >
            No workspaces match &ldquo;{query}&rdquo;.
          </div>
        )
      ) : (
        // One row per workspace, so twenty of them fit a screen and each column
        // can be read straight down. Scrolls sideways rather than collapsing
        // columns when the pane is too narrow for them.
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              minWidth: 760,
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
              fontFamily: 'var(--ui-font)',
            }}
          >
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '23%' }} />
              <col style={{ width: '25%' }} />
              <col />
              {/* Wide enough for "just now" at the mono caption size. */}
              <col style={{ width: 78 }} />
              <col style={{ width: 34 }} />
            </colgroup>
            <thead>
              <tr>
                <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} first />
                <th scope="col" style={TH_STYLE}>Path</th>
                <th scope="col" style={TH_STYLE}>Connection</th>
                <th scope="col" style={TH_STYLE}>{query.trim() ? 'Match' : 'Latest thread'}</th>
                <SortHeader label="Last" sortKey="last" sort={sort} onSort={toggleSort} numeric />
                <th scope="col" style={{ ...TH_STYLE, padding: 0 }}><span style={VISUALLY_HIDDEN}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {cards.map((w) => (
                <WorkspaceTableRow
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
            </tbody>
          </table>
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

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric,
  first,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  first?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={{
        ...TH_STYLE,
        textAlign: numeric ? 'right' : 'left',
        paddingLeft: first ? FIRST_CELL_PAD : 0,
      }}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        style={{
          display: 'inline-flex',
          // Right-aligned columns put the arrow slot BEFORE the label, so the
          // label's right edge stays flush with the numbers under it.
          flexDirection: numeric ? 'row-reverse' : 'row',
          alignItems: 'center',
          gap: 4,
          padding: 0,
          border: 0,
          background: 'transparent',
          font: 'inherit',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
          color: active ? 'var(--term-fg)' : 'inherit',
          cursor: 'pointer',
        }}
      >
        {label}
        {/* Fixed-width slot so the label doesn't shift when the arrow appears.
            Never empty: an empty inline-block has no text baseline, and the
            button would then sit lower than its neighbours. */}
        <span aria-hidden style={{ display: 'inline-block', width: '1ch' }}>
          {active ? (sort.dir === 'asc' ? '↑' : '↓') : <>&nbsp;</>}
        </span>
      </button>
    </th>
  );
}

function WorkspaceTableRow({
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
  // While the filter is active, the latest-thread cell shows the newest
  // matching node instead, so the user sees *why* this row matched. Falls back
  // to the latest thread if only name/cwd matched (no node-title hit).
  const matchedNodes = React.useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return w.nodes
      .filter((n) => n.title.toLowerCase().includes(q))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [query, w.nodes]);
  const topMatch = matchedNodes[0];
  const latest = w.threads[0];
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
    <tr
      data-testid={`workspace-table-row-${w.id}`}
      // The whole row is a pointer target; keyboard users reach the same action
      // through the name button below, whose click bubbles up to here.
      onClick={() => { if (!renaming) onOpen(); }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        cursor: 'pointer',
        background: w.active
          ? 'var(--term-alt)'
          : hover ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
        transition: 'background var(--t-quick) var(--t-ease)',
      }}
    >
      <td
        style={{
          ...TD_STYLE,
          paddingLeft: FIRST_CELL_PAD,
          // The active workspace: an accent bar down the row's leading edge.
          boxShadow: w.active ? 'inset 2px 0 0 var(--term-accent)' : undefined,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            aria-hidden
            style={{
              width: 20,
              height: 20,
              background: accent,
              // eslint-disable-next-line no-restricted-syntax -- fixed workspace badge palette, not theme-driven
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 'var(--fs-sm)',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {initialOf(w.name)}
          </span>
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
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--ui-font)',
                fontSize: 'var(--fs-lg)',
                fontWeight: 500,
                color: 'var(--term-fg)',
                background: 'var(--term-bg)',
                border: '1px solid var(--term-accent)',
                padding: '2px 6px',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          ) : (
            // A real button, so the row's action is reachable and announced
            // from the keyboard. It has no handler of its own: Enter / Space
            // fire a click that bubbles to the row.
            <button
              type="button"
              style={{
                minWidth: 0,
                padding: 0,
                border: 0,
                background: 'transparent',
                font: 'inherit',
                fontWeight: 500,
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <Highlight text={w.name} q={query} />
            </button>
          )}
          {w.streaming > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                flexShrink: 0,
                fontSize: 'var(--fs-xs)',
                color: 'var(--term-select, var(--term-accent))',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 'var(--ls-caps)',
              }}
            >
              <Dot color="var(--term-select, var(--term-accent))" size={6} pulse />
              LIVE
            </span>
          )}
        </span>
      </td>

      <td
        title={w.cwd}
        style={{
          ...TD_STYLE,
          fontFamily: w.cwd ? 'var(--font-mono, ui-monospace, monospace)' : 'var(--ui-font)',
          fontSize: 'var(--fs-md)',
          color: 'var(--term-muted)',
        }}
      >
        {w.cwd
          ? <Highlight text={pathForQuery(w.cwd, query)} q={query} />
          : 'quick chat · no folder'}
      </td>

      <td style={TD_STYLE}>
        <WorkspaceLocation connectionId={w.backendConnectionId} separator=" - " />
      </td>

      <td style={{ ...TD_STYLE, color: 'var(--term-mid)' }}>
        {topMatch ? (
          <>
            {topMatch.kind === 'digest' && (
              <span style={{ color: 'var(--term-digest)', marginRight: 4 }}>●</span>
            )}
            <Highlight text={topMatch.title} q={query} />
            {matchedNodes.length > 1 && (
              <span style={{ color: 'var(--term-muted)', marginLeft: 8, fontSize: 'var(--fs-sm)' }}>
                +{matchedNodes.length - 1}
              </span>
            )}
          </>
        ) : latest ? (
          <Highlight text={latest.title} q={query} />
        ) : (
          <span style={{ color: 'var(--term-muted)' }}>—</span>
        )}
      </td>

      <td style={{ ...TD_NUMERIC, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>
        {formatRelative(w.lastTs)}
      </td>

      <td style={{ ...TD_STYLE, padding: 0, textOverflow: 'clip' }}>
        <button
          type="button"
          title="More actions"
          aria-label="More actions"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu(e.currentTarget.getBoundingClientRect());
          }}
          style={{
            width: 24,
            height: 24,
            border: '1px solid transparent',
            background: 'transparent',
            color: 'var(--term-muted)',
            opacity: hover ? 1 : 0.45,
            transition: 'opacity var(--t-soft), background var(--t-soft), border-color var(--t-soft)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--fs-2xl)',
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
      </td>
    </tr>
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
          fontSize: 'var(--fs-lg)',
          fontWeight: 600,
        }}
      >
        {value}
      </span>
      <span style={{ textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)', fontSize: 'var(--fs-2xs)' }}>{label}</span>
    </span>
  );
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
          borderRadius: 'var(--ui-radius-sm)',
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
        border: '1px solid var(--term-line)',
        background: 'var(--term-surface)',
        textAlign: 'center',
        boxShadow: '0 1px 2px rgba(26,25,22,.04), 0 6px 18px rgba(26,25,22,.05)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-3xl)',
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
          fontSize: 'var(--fs-lg)',
          color: 'var(--term-muted)',
          lineHeight: 1.6,
        }}
      >
        Workspaces hold all the threads, branches, and digests for one corner of your
        thinking. Make one for a project, a question, or whatever you keep coming back to.
      </p>
      <Button variant="primary" onClick={onNew} style={{ padding: '10px 18px' }}>
        + new workspace
      </Button>
    </div>
  );
}
