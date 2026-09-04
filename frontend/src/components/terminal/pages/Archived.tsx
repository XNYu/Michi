import React, { useMemo } from 'react';
import { useChatStore, useChatNodesSnapshot, chatLabel, ChatNodeState } from '../../../state/chatStore';
import type { Project } from '../../../state/chatTypes';
import type { PageId } from '../../../state/commands';
import { workspaceAccent, initialOf } from '../workspaceAccent';
import { isArchiveGroupId } from '../../../state/trashActions';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { descendants } from '../../../state/tree';

/**
 * Unified archive surface — shows both archived threads (tree-level archive
 * via `tree.archivedAt`) and archived nodes (single-node archive via
 * `deletionGroupId` prefixed `arch-`) in one mixed-chronological list.
 *
 * The two archive mechanisms have different semantics internally:
 * - Thread archive: hides an entire tree, preserving its structure.
 * - Node archive: trims a single node out of the conversation, reparenting
 *   children up. Restore reverses via the trimSnapshot.
 *
 * Both are presented identically to the user. The `_kind` discriminator on
 * ArchiveGroup routes restore/delete to the correct underlying function.
 */

interface ArchiveGroup {
  id: string;
  projectId: string;
  archivedAt: number;
  rootTitle: string;
  memberCount: number;
  /** Internal discriminator — not surfaced in UI. */
  _kind: 'node' | 'tree';
  /** Tree id, only set when _kind === 'tree'. */
  _treeId?: string;
}

interface WorkspaceSection {
  project: Project;
  groups: ArchiveGroup[];
  sortKey: number;
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Count live (non-deleted) nodes belonging to a tree, including its root. */
function countTreeNodes(
  rootNodeId: string,
  edges: Project['edges'],
  nodes: Record<string, ChatNodeState>,
): number {
  const liveEdges = edges.filter(
    (e) => !nodes[e.source]?.deletedAt && !nodes[e.target]?.deletedAt,
  );
  const desc = descendants(rootNodeId, liveEdges);
  // +1 for the root itself, but only if the root node exists and is not deleted
  const rootNode = nodes[rootNodeId];
  const rootAlive = rootNode && !rootNode.deletedAt ? 1 : 0;
  return desc.size + rootAlive;
}

export default function TerminalArchived({ onNav }: { onNav?: (p: PageId) => void } = {}) {
  const {
    projects,
    restoreDeletion,
    purgeDeletionAsync,
    unarchiveTree,
    deleteTree,
    openPane,
    selectProject,
    activateTree,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();

  // ── Node archive groups (existing logic) ──────────────────────────────
  const nodeGroups: ArchiveGroup[] = useMemo(() => {
    const byGid = new Map<string, ChatNodeState[]>();
    for (const n of Object.values(nodesSnapshot)) {
      if (!isArchiveGroupId(n.deletionGroupId)) continue;
      const arr = byGid.get(n.deletionGroupId!) ?? [];
      arr.push(n);
      byGid.set(n.deletionGroupId!, arr);
    }
    const out: ArchiveGroup[] = [];
    byGid.forEach((members, gid) => {
      const deletedSet = new Set(members.map((m) => m.nodeId));
      const root = members.find((m) => !m.parentNodeId || !deletedSet.has(m.parentNodeId)) ?? members[0];
      const archivedAt = Math.max(...members.map((m) => m.deletedAt ?? 0));
      out.push({
        id: gid,
        projectId: root?.projectId ?? '',
        archivedAt,
        rootTitle: root?.title || chatLabel(root) || 'thread',
        memberCount: members.length,
        _kind: 'node',
      });
    });
    return out;
  }, [nodesSnapshot]);

  // ── Thread archive entries (new) ──────────────────────────────────────
  const threadGroups: ArchiveGroup[] = useMemo(() => {
    const out: ArchiveGroup[] = [];
    for (const p of projects) {
      for (const t of p.trees) {
        if (!t.archivedAt) continue;
        const root = nodesSnapshot[t.rootNodeId];
        const nodeCount = countTreeNodes(t.rootNodeId, p.edges, nodesSnapshot);
        out.push({
          id: `tree-${t.id}`,
          projectId: p.id,
          archivedAt: t.archivedAt,
          rootTitle: root?.title || t.name || 'Untitled thread',
          memberCount: nodeCount,
          _kind: 'tree',
          _treeId: t.id,
        });
      }
    }
    return out;
  }, [projects, nodesSnapshot]);

  // ── Merge + group by workspace ────────────────────────────────────────
  const allGroups = useMemo(
    () => [...nodeGroups, ...threadGroups],
    [nodeGroups, threadGroups],
  );

  const sortedSections: WorkspaceSection[] = useMemo(() => {
    const byProj = new Map<string, WorkspaceSection>();
    for (const g of allGroups) {
      const proj = projects.find((p) => p.id === g.projectId);
      if (!proj) continue;
      const cur = byProj.get(proj.id) ?? { project: proj, groups: [], sortKey: 0 };
      cur.groups.push(g);
      cur.sortKey = Math.max(cur.sortKey, g.archivedAt);
      byProj.set(proj.id, cur);
    }
    return Array.from(byProj.values())
      .map((s) => ({ ...s, groups: [...s.groups].sort((a, b) => b.archivedAt - a.archivedAt) }))
      .sort((a, b) => b.sortKey - a.sortKey);
  }, [allGroups, projects]);

  const totalCount = allGroups.length;

  // ── Restore / purge handlers routed by _kind ──────────────────────────
  const handleRestore = (project: Project, g: ArchiveGroup) => {
    if (g._kind === 'tree' && g._treeId) {
      unarchiveTree(g._treeId);
      selectProject(project.id);
      activateTree(g._treeId);
      onNav?.('dashboard');
    } else {
      const root = restoreDeletion(g.id);
      if (root) {
        selectProject(project.id);
        openPane(root);
        onNav?.('dashboard');
      }
    }
  };

  const handlePurge = async (g: ArchiveGroup) => {
    const noun = g._kind === 'tree' ? 'thread' : 'node';
    if (!(await confirmDialog({
      title: `Delete ${noun}`,
      message: `Permanently delete "${g.rootTitle}" (${g.memberCount} node${g.memberCount === 1 ? '' : 's'})?`,
      confirmLabel: 'Delete',
    }))) return;

    try {
      if (g._kind === 'tree' && g._treeId) {
        deleteTree(g._treeId);
      } else {
        await purgeDeletionAsync(g.id);
      }
    } catch (err) {
      window.alert(`Failed to delete: ${(err as Error).message}`);
    }
  };

  return (
    <div
      className="term-scrollbar"
      style={{ flex: 1, overflowY: 'auto', padding: '26px 32px', background: 'var(--term-bg)' }}
    >
      {totalCount === 0 ? (
        <div
          style={{
            background: 'var(--term-surface)',
            border: '1px solid var(--term-line)',
            padding: 20,
            color: 'var(--term-muted)',
            fontSize: 12,
            fontFamily: 'var(--ui-font)',
          }}
        >
          — empty — archive a thread or node from its context menu to keep it here
        </div>
      ) : (
        <div style={{ background: 'var(--term-surface)', border: '1px solid var(--term-line)' }}>
          {sortedSections.map((s, i) => (
            <WorkspaceSectionView
              key={s.project.id}
              section={s}
              isFirst={i === 0}
              onRestoreGroup={(g) => handleRestore(s.project, g)}
              onPurgeGroup={handlePurge}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceSectionView({
  section,
  isFirst,
  onRestoreGroup,
  onPurgeGroup,
}: {
  section: WorkspaceSection;
  isFirst: boolean;
  onRestoreGroup: (g: ArchiveGroup) => void;
  onPurgeGroup: (g: ArchiveGroup) => void;
}) {
  const { project, groups } = section;
  return (
    <div style={{ borderTop: isFirst ? 'none' : '1px solid var(--term-line)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'var(--term-alt)',
          borderBottom: '1px solid var(--term-line)',
          fontFamily: 'var(--ui-font)',
          fontSize: 11,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            background: workspaceAccent(project.id),
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {initialOf(project.name)}
        </span>
        <span style={{ color: 'var(--term-fg)', fontWeight: 600, fontSize: 12 }}>{project.name}</span>
        <span style={{ color: 'var(--term-muted)', fontSize: 10 }}>
          {groups.length} item{groups.length === 1 ? '' : 's'}
        </span>
      </div>

      {groups.map((g) => (
        <ArchiveListRow
          key={g.id}
          title={g.rootTitle}
          meta={g._kind === 'tree'
            ? `thread · ${g.memberCount} node${g.memberCount === 1 ? '' : 's'}`
            : `${g.memberCount} node${g.memberCount === 1 ? '' : 's'}`}
          archivedAt={g.archivedAt}
          onRestore={() => onRestoreGroup(g)}
          onPurge={() => onPurgeGroup(g)}
        />
      ))}
    </div>
  );
}

function ArchiveListRow({
  title,
  meta,
  archivedAt,
  onRestore,
  onPurge,
}: {
  title: string;
  meta: string;
  archivedAt: number;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '46px 1fr 140px auto',
        padding: '12px 14px',
        borderBottom: '1px solid var(--term-line)',
        alignItems: 'center',
        background: 'var(--term-surface)',
      }}
    >
      <span style={{ fontSize: 14, color: 'var(--term-muted)' }}>▣</span>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            color: 'var(--term-fg)',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div style={{ fontFamily: 'var(--ui-font)', fontSize: 10, color: 'var(--term-muted)', marginTop: 2 }}>
          {meta}
        </div>
      </div>
      <span style={{ fontFamily: 'var(--ui-font)', fontSize: 11, color: 'var(--term-muted)' }}>
        {formatRelative(archivedAt)}
      </span>
      <div style={{ display: 'inline-flex', gap: 8, justifySelf: 'end' }}>
        <span
          onClick={onRestore}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            color: 'var(--term-fg)',
            cursor: 'pointer',
            padding: '4px 10px',
            border: '1px solid var(--term-fg)',
            letterSpacing: '.04em',
          }}
        >
          ↺ restore
        </span>
        <span
          onClick={onPurge}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            color: 'var(--term-danger)',
            cursor: 'pointer',
            padding: '4px 10px',
            border: '1px solid var(--term-danger)',
            letterSpacing: '.04em',
          }}
        >
          × delete permanently
        </span>
      </div>
    </div>
  );
}
