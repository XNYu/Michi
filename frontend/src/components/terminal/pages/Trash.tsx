import React, { useMemo, useState } from 'react';
import { useChatStore, useChatNodesSnapshot, chatLabel, ChatNodeState } from '../../../state/chatStore';
import type { Project } from '../../../state/chatTypes';
import { usePrefs } from '../../../state/prefs';
import type { PageId } from '../../../state/commands';
import { workspaceAccent, initialOf } from '../workspaceAccent';
import { kbd } from '../../../lib/platform';
import { isArchiveGroupId } from '../../../state/trashActions';

interface TrashGroup {
  id: string;
  projectId: string;
  deletedAt: number;
  rootNode: ChatNodeState | null;
  rootTitle: string;
  memberCount: number;
}

interface WorkspaceSection {
  project: Project;
  isDeleted: boolean;
  groups: TrashGroup[];
  // Newest activity in this section (workspace delete time or any group time).
  // Used to sort sections so the most-recent trash activity floats to the top.
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

export default function TerminalTrash({ onNav }: { onNav?: (p: PageId) => void } = {}) {
  const {
    projects,
    restoreDeletion,
    purgeDeletionAsync,
    emptyTrashAsync,
    openPane,
    restoreProject,
    purgeProject,
    selectProject,
  } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const { prefs } = usePrefs();
  // True while a destructive backend call is in flight. Disables the
  // empty-trash button (and dims it) so users can't double-click during the
  // round-trip — important because each click pauses the persistence sync
  // and a second click before the first resolves would race.
  const [purging, setPurging] = useState(false);

  const groups: TrashGroup[] = useMemo(() => {
    const byGid = new Map<string, ChatNodeState[]>();
    for (const n of Object.values(nodesSnapshot)) {
      if (!n.deletionGroupId) continue;
      if (isArchiveGroupId(n.deletionGroupId)) continue; // archived lane has its own page
      const arr = byGid.get(n.deletionGroupId) ?? [];
      arr.push(n);
      byGid.set(n.deletionGroupId, arr);
    }
    const out: TrashGroup[] = [];
    byGid.forEach((members, gid) => {
      const deletedSet = new Set(members.map((m) => m.nodeId));
      // Root of the group = member whose parent is NOT in the group.
      const root = members.find((m) => !m.parentNodeId || !deletedSet.has(m.parentNodeId))
        ?? members[0];
      const deletedAt = Math.max(...members.map((m) => m.deletedAt ?? 0));
      out.push({
        id: gid,
        projectId: root?.projectId ?? '',
        deletedAt,
        rootNode: root ?? null,
        rootTitle: root?.title || chatLabel(root) || 'thread',
        memberCount: members.length,
      });
    });
    return out;
  }, [nodesSnapshot]);

  const ttl = prefs.trashTTLDays;

  const sections: WorkspaceSection[] = useMemo(() => {
    const byProj = new Map<string, WorkspaceSection>();
    for (const g of groups) {
      const proj = projects.find((p) => p.id === g.projectId);
      if (!proj) continue;
      const cur = byProj.get(proj.id) ?? {
        project: proj,
        isDeleted: !!proj.deletedAt,
        groups: [],
        sortKey: proj.deletedAt ?? 0,
      };
      cur.groups.push(g);
      cur.sortKey = Math.max(cur.sortKey, g.deletedAt);
      byProj.set(proj.id, cur);
    }
    // Surface deleted workspaces that no longer contain any deletion groups
    // (their threads were either purged or never trashed individually) so the
    // user can still restore or purge the workspace itself.
    for (const p of projects) {
      if (!p.deletedAt) continue;
      if (byProj.has(p.id)) continue;
      byProj.set(p.id, {
        project: p,
        isDeleted: true,
        groups: [],
        sortKey: p.deletedAt,
      });
    }
    return Array.from(byProj.values()).sort((a, b) => {
      // Deleted workspaces sink to the bottom so the user sees their live
      // workspace's discarded threads first.
      if (a.isDeleted !== b.isDeleted) return a.isDeleted ? 1 : -1;
      return b.sortKey - a.sortKey;
    });
  }, [groups, projects]);

  // Sort groups within each section newest-first.
  const sortedSections = useMemo(
    () => sections.map((s) => ({ ...s, groups: [...s.groups].sort((a, b) => b.deletedAt - a.deletedAt) })),
    [sections],
  );

  const totalGroupCount = groups.length;
  const totalDeletedProjects = projects.filter((p) => p.deletedAt).length;
  const totalCount = totalGroupCount + totalDeletedProjects;

  return (
    <div
      className="term-scrollbar"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '26px 32px',
        background: 'var(--term-bg)',
      }}
    >
      {/* Title + count live in the topbar. Body keeps only the action button. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        {ttl > 0 && (
          <span
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 11,
              color: 'var(--term-muted)',
            }}
          >
            auto-purge after {ttl} days
          </span>
        )}
        {totalCount > 0 && (
          <button
            type="button"
            disabled={purging}
            onClick={async () => {
              if (purging) return;
              if (!window.confirm(`Permanently delete all ${totalCount} items from trash?`)) return;
              setPurging(true);
              try {
                // Run the per-workspace /trash/empty calls AND any whole-workspace
                // DELETEs in parallel. Both flows internally pause the persistence
                // sync (Empty Trash via store-level syncPausedRef, workspace
                // delete via the row already being filtered out of projects state
                // before the next interval tick) so a pre-purge POST /sync can't
                // race-cover the backend deletes by re-inserting their rows.
                await Promise.all([
                  emptyTrashAsync(),
                  ...projects
                    .filter((p) => p.deletedAt)
                    .map((p) => purgeProject(p.id)),
                ]);
              } catch (err) {
                window.alert(`Failed to empty trash: ${(err as Error).message}`);
              } finally {
                setPurging(false);
              }
            }}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--term-danger)',
              background: 'var(--term-danger)',
              color: 'var(--term-surface)',
              fontFamily: 'var(--ui-font)',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: purging ? 'wait' : 'pointer',
              opacity: purging ? 0.6 : 1,
            }}
          >
            {purging ? '× purging…' : '× empty trash'}
          </button>
        )}
      </div>

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
          — empty — deleted items will appear here · {kbd('mod', 'Z')} restores the most recent deletion
        </div>
      ) : (
        <div style={{ background: 'var(--term-surface)', border: '1px solid var(--term-line)' }}>
          {sortedSections.map((s, i) => (
            <WorkspaceSectionView
              key={s.project.id}
              section={s}
              isFirst={i === 0}
              onRestoreGroup={(g) => {
                // Restoring a thread/subtree implicitly brings the workspace
                // back too — otherwise the restored node has no live home.
                if (s.isDeleted) restoreProject(s.project.id);
                const root = restoreDeletion(g.id);
                if (root) {
                  selectProject(s.project.id);
                  openPane(root);
                  onNav?.('dashboard');
                }
              }}
              onPurgeGroup={async (g) => {
                if (!window.confirm(`Permanently delete "${g.rootTitle}" (${g.memberCount} node${g.memberCount === 1 ? '' : 's'})?`)) return;
                try {
                  await purgeDeletionAsync(g.id);
                } catch (err) {
                  window.alert(`Failed to delete thread: ${(err as Error).message}`);
                }
              }}
              onRestoreWorkspace={() => {
                restoreProject(s.project.id);
                selectProject(s.project.id);
                onNav?.('dashboard');
              }}
              onPurgeWorkspace={async () => {
                const extra = s.groups.length;
                const tail = extra > 0 ? ` and ${extra} trashed thread${extra === 1 ? '' : 's'} inside it` : '';
                if (!window.confirm(`Permanently delete workspace "${s.project.name}"${tail}?`)) return;
                try {
                  await purgeProject(s.project.id);
                } catch (err) {
                  window.alert(`Failed to delete workspace: ${(err as Error).message}`);
                }
              }}
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
  onRestoreWorkspace,
  onPurgeWorkspace,
}: {
  section: WorkspaceSection;
  isFirst: boolean;
  onRestoreGroup: (g: TrashGroup) => void;
  onPurgeGroup: (g: TrashGroup) => void;
  onRestoreWorkspace: () => void;
  onPurgeWorkspace: () => void;
}) {
  const { project, isDeleted, groups } = section;
  return (
    <div style={{ borderTop: isFirst ? 'none' : '1px solid var(--term-line)' }}>
      {/* Workspace band */}
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
        <span style={{ color: 'var(--term-fg)', fontWeight: 600, fontSize: 12 }}>
          {project.name}
        </span>
        {isDeleted && (
          <span
            style={{
              fontSize: 9,
              letterSpacing: '.14em',
              padding: '1px 6px',
              border: '1px solid var(--term-danger)',
              color: 'var(--term-danger)',
            }}
          >
            DELETED
          </span>
        )}
        <span style={{ color: 'var(--term-muted)', fontSize: 10 }}>
          {groups.length} thread{groups.length === 1 ? '' : 's'}
          {isDeleted && project.deletedAt ? ` · workspace deleted ${formatRelative(project.deletedAt)}` : ''}
        </span>
        <div style={{ flex: 1 }} />
        {isDeleted && (
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <span
              onClick={onRestoreWorkspace}
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 11,
                color: 'var(--term-fg)',
                cursor: 'pointer',
                padding: '3px 10px',
                border: '1px solid var(--term-fg)',
                letterSpacing: '.04em',
              }}
            >
              ↺ restore workspace
            </span>
            <span
              onClick={onPurgeWorkspace}
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 11,
                color: 'var(--term-danger)',
                cursor: 'pointer',
                padding: '3px 10px',
                border: '1px solid var(--term-danger)',
                letterSpacing: '.04em',
              }}
            >
              × purge workspace
            </span>
          </div>
        )}
      </div>

      {/* Thread rows */}
      {groups.map((g) => (
        <TrashListRow
          key={g.id}
          title={g.rootTitle}
          meta={`${g.memberCount} node${g.memberCount === 1 ? '' : 's'}`}
          deletedAt={g.deletedAt}
          onRestore={() => onRestoreGroup(g)}
          onPurge={() => onPurgeGroup(g)}
        />
      ))}
      {groups.length === 0 && (
        <div
          style={{
            padding: '12px 14px',
            color: 'var(--term-muted)',
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
          }}
        >
          — no trashed threads in this workspace —
        </div>
      )}
    </div>
  );
}

function TrashListRow({
  title,
  meta,
  deletedAt,
  onRestore,
  onPurge,
}: {
  title: string;
  meta: string;
  deletedAt: number;
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
      <span style={{ fontSize: 14, color: 'var(--term-muted)' }}>🗑</span>
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
        <div
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 10,
            color: 'var(--term-muted)',
            marginTop: 2,
          }}
        >
          {meta}
        </div>
      </div>
      <span
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 11,
          color: 'var(--term-muted)',
        }}
      >
        {formatRelative(deletedAt)}
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
