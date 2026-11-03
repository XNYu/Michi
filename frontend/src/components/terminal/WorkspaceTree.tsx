import React, { useCallback, useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { shallowArrayEqual, useChatActions, useChatNodesSnapshot, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { isWorkspaceExpanded, sortTrees, sortLiveProjects, workspaceHasUnread, type NodePinnedAt } from '../../state/sidebarSelectors';
import { isVisibleConversationNode } from '../../state/conversationVisibility';
import WorkspaceRow from './WorkspaceRow';
import ContextMenu from '../ContextMenu';
import { descendants } from '../../state/tree';
import { flattenBranchIds, useSidebarTreeController } from './sidebar/useSidebarTreeController';
import { Row } from './primitives';
import { Chevron } from './ThreadRow';
import type { Project, ChatNodeState } from '../../state/chatTypes';

const MERGED_PREVIEW_LIMIT = 5;
const MERGED_PAGE_SIZE = 10;

interface MergeGroup {
  mergeNodeId: string;
  sources: string[];
  mergeTreeId: string;
}

export default function WorkspaceTree({
  onActivate,
  chatViewActive = true,
}: {
  /** Called after a thread/branch click so the parent can switch to dashboard. */
  onActivate?: () => void;
  /** False when the user is on Map/Digest/etc. — suppresses thread/branch
   *  active highlights so the sidebar doesn't claim something is open when
   *  the user has navigated away. The workspace row still gets a marker. */
  chatViewActive?: boolean;
}) {
  const {
    projects,
    activeProjectId,
    focusedNodeId,
    treeSelection,
    unreadFilterOn,
  } = useChatProjects();
  const {
    selectProject,
    activateTree,
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    renameTree,
    deleteTree,
    moveTreeToWorkspace,
    renameProject,
    archiveProject,
    unarchiveProject,
    pinProject,
    unpinProject,
    deleteProject,
    createThread,
    toggleTreeSelection,
    clearTreeSelection,
    markAllRead,
    renameNode,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();
  const nodesSnapshot = useChatNodesSnapshot();

  const liveProjects = useMemo(
    () => sortLiveProjects(projects, prefs.workspaceOrder),
    [projects, prefs.workspaceOrder],
  );
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [collapsedMergeGroups, setCollapsedMergeGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMergeGroup = useCallback((mergeNodeId: string) => {
    setCollapsedMergeGroups((prev) => {
      const next = new Set(prev);
      if (next.has(mergeNodeId)) next.delete(mergeNodeId);
      else next.add(mergeNodeId);
      return next;
    });
  }, []);

  const commitWorkspaceReorder = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      const ids = liveProjects.map((p) => p.id);
      const fromIdx = ids.indexOf(sourceId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return;
      const next = [...ids];
      const [moved] = next.splice(fromIdx, 1);
      const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
      next.splice(insertAt, 0, moved);
      // Preserve any archived/stale IDs from the current pref as tombstones
      // — sortLiveProjects ignores them, but they let us restore explicit
      // ordering if a workspace is later unarchived.
      const liveSet = new Set(ids);
      const tombstones = prefs.workspaceOrder.filter((id) => !liveSet.has(id));
      setPref('workspaceOrder', [...next, ...tombstones]);
    },
    [liveProjects, prefs.workspaceOrder, setPref],
  );

  const dndForProject = useCallback(
    (projectId: string) => ({
      draggable: true as const,
      isDragSource: dragSourceId === projectId,
      isDropTarget: dropTargetId === projectId && dragSourceId !== null && dragSourceId !== projectId,
      onDragStart: (e: React.DragEvent) => {
        setDragSourceId(projectId);
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Some browsers refuse to start a drag without setData.
          try { e.dataTransfer.setData('text/plain', projectId); } catch {}
        }
      },
      onDragOver: (e: React.DragEvent) => {
        if (!dragSourceId || dragSourceId === projectId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        if (dropTargetId !== projectId) setDropTargetId(projectId);
      },
      onDragLeave: () => {
        setDropTargetId((cur) => (cur === projectId ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragSourceId) commitWorkspaceReorder(dragSourceId, projectId);
        setDragSourceId(null);
        setDropTargetId(null);
      },
      onDragEnd: () => {
        setDragSourceId(null);
        setDropTargetId(null);
      },
    }),
    [dragSourceId, dropTargetId, commitWorkspaceReorder],
  );

  const isAlive = useCallback(
    (id: string) => !nodesSnapshot[id]?.deletedAt && isVisibleConversationNode(nodesSnapshot[id]),
    [nodesSnapshot],
  );
  const nodePinnedAt = useCallback<NodePinnedAt>(
    (id) => nodesSnapshot[id]?.pinnedAt,
    [nodesSnapshot],
  );

  const branchIdsForProject = useCallback(
    (project: Project) => flattenBranchIds(project.trees, project.edges, isAlive, nodePinnedAt),
    [isAlive, nodePinnedAt],
  );
  const {
    isThreadOpen,
    isBranchOpen,
    toggleThread,
    setThreadExpanded,
    toggleBranch,
    snapshotBeforeSwitch,
    updateExpanded,
    openThreadRoot,
    selectBranch,
    focusNode,
    isBranchSelected,
    treeAnchorRef,
    menu,
    menuSections,
    openBranchMenu,
    closeMenu,
    isBranchMenuTarget,
    renamingNodeId,
    endRename,
  } = useSidebarTreeController({ onActivate, branchIdsForProject });

  const toggleWorkspace = useCallback(
    (projectId: string) =>
      updateExpanded((cur) => ({
        ...cur,
        workspaces: { ...cur.workspaces, [projectId]: !isWorkspaceExpanded(cur, projectId, activeProjectId) },
      })),
    [activeProjectId, updateExpanded],
  );

  const selectThread = useCallback(
    (treeId: string, project: Project, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        toggleTreeSelection(treeId);
        treeAnchorRef.current = treeId;
        return;
      }
      if (event.shiftKey && treeAnchorRef.current) {
        event.preventDefault();
        const normalTrees = project.trees.filter((t) => t.kind !== 'merge');
        const sorted = sortTrees(normalTrees, project.activeTreeId);
        const visible = sorted.filter((t) => !t.archivedAt && isAlive(t.rootNodeId));
        const ids = visible.map((t) => t.id);
        const a = ids.indexOf(treeAnchorRef.current);
        const b = ids.indexOf(treeId);
        if (a === -1 || b === -1) return;
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = ids.slice(lo, hi + 1);
        for (const rid of range) {
          if (!treeSelection.has(rid)) toggleTreeSelection(rid);
        }
        return;
      }
      if (treeSelection.size > 0) clearTreeSelection();
      treeAnchorRef.current = treeId;
    },
    [isAlive, treeSelection, toggleTreeSelection, clearTreeSelection, treeAnchorRef],
  );

  const activateTreeStable = useCallback(
    (treeId: string, projectId: string) => {
      snapshotBeforeSwitch(treeId, projectId);
      if (projectId !== activeProjectId) selectProject(projectId);
      activateTree(treeId);
      onActivate?.();
    },
    [snapshotBeforeSwitch, activeProjectId, selectProject, activateTree, onActivate],
  );

  /** Select a project and set its expand state in the same sidebarExpanded
   *  write as the switch snapshot. `expanded === undefined` preserves whatever
   *  the snapshot pinned (i.e. the visual state right before the switch). */
  const selectProjectStable = useCallback(
    (projectId: string, expanded?: boolean) => {
      const sameProject = projectId === activeProjectId;
      if (sameProject && expanded === undefined) return;
      snapshotBeforeSwitch(null, projectId, (next) =>
        expanded === undefined
          ? next
          : { ...next, workspaces: { ...next.workspaces, [projectId]: expanded } },
      );
      if (!sameProject) selectProject(projectId);
    },
    [snapshotBeforeSwitch, activeProjectId, selectProject],
  );

  const toggleWorkspaceExpand = useCallback(
    (projectId: string) => {
      // Clicking an INACTIVE workspace is a project switch: activate it and
      // keep it expanded (never collapse on activation), routing through
      // selectProjectStable so snapshotBeforeSwitch pins the outgoing
      // (implicit-active → expanded) workspace before the active flip.
      // Without this the previously-active workspace silently collapses.
      // Collapse only happens on a SECOND click, once the workspace is active.
      if (projectId !== activeProjectId) {
        selectProjectStable(projectId, true);
        return;
      }
      // Active workspace: plain expand/collapse toggle. Collapsing must NOT
      // switch active project — that would trigger the focusedPane reveal
      // effect which re-expands it.
      toggleWorkspace(projectId);
    },
    [activeProjectId, selectProjectStable, toggleWorkspace],
  );

  const renderProject = (project: typeof projects[number], opts: { dnd?: ReturnType<typeof dndForProject> } = {}) => {
    const wsExpanded = isWorkspaceExpanded(
      prefs.sidebarExpanded,
      project.id,
      activeProjectId,
    );
    const normalTrees = project.trees.filter((t) => t.kind !== 'merge');
    const mergeTrees = project.trees.filter((t) => t.kind === 'merge');
    const sortedTreesArr = sortTrees(normalTrees, project.activeTreeId);
    const isActive = project.id === activeProjectId;
    const mergeGroups = isActive
      ? sortTrees(mergeTrees, project.activeTreeId).map((t) => {
          const sources = (nodesSnapshot[t.rootNodeId]?.mergeSources ?? []) as string[];
          return { mergeNodeId: t.rootNodeId, sources, mergeTreeId: t.id };
        })
      : [];
    return (
      <React.Fragment key={project.id}>
        <WorkspaceRow
          project={project}
          dnd={opts.dnd}
          workspaceExpanded={wsExpanded}
          forceExpand={unreadFilterOn}
          activeProjectId={activeProjectId}
          chatViewActive={chatViewActive}
          activeTreeId={chatViewActive ? project.activeTreeId : null}
          focusedNodeId={chatViewActive ? focusedNodeId : null}
          isThreadExpanded={(treeId) => isThreadOpen(treeId, project.activeTreeId)}
          isBranchExpanded={isBranchOpen}
          isBranchSelected={isBranchSelected}
          isBranchMenuTarget={isBranchMenuTarget}
          isNodeAlive={isAlive}
          nodePinnedAt={nodePinnedAt}
          sortedTrees={sortedTreesArr}
          edges={project.edges}
          actions={{
            toggleWorkspace,
            toggleThread,
            setThreadExpanded,
            toggleBranch,
            activateTree: (treeId) => activateTreeStable(treeId, project.id),
            selectProject: selectProjectStable,
            toggleWorkspaceExpand,
            createThread: () => {
              createThread();
              onActivate?.();
            },
            archiveTree,
            unarchiveTree,
            pinTree,
            unpinTree,
            renameTree: (treeId, name) => renameTree(treeId, name, project.id),
            deleteTree,
            moveTreeToWorkspace: (treeId, targetProjectId) => {
              // Fire-and-forget — the action is async but the menu invoker is
              // synchronous; failures surface via toast inside the store.
              void moveTreeToWorkspace(treeId, targetProjectId);
            },
            renameProject,
            archiveProject,
            unarchiveProject,
            pinProject,
            unpinProject,
            deleteProject,
            selectBranch,
            branchContextMenu: openBranchMenu,
            selectThreadRoot: openThreadRoot,
            selectThread,
          }}
          renamingNodeId={renamingNodeId}
          onRenameNode={renameNode}
          onRenameEnd={endRename}
        />
        {wsExpanded && mergeGroups.length > 0 && (
          <MergedGroupsSection
            key={`merged-${project.id}`}
            project={project}
            mergeGroups={mergeGroups}
            nodesSnapshot={nodesSnapshot}
            focusedNodeId={focusedNodeId}
            collapsedMergeGroups={collapsedMergeGroups}
            toggleMergeGroup={toggleMergeGroup}
            isAlive={isAlive}
            onSelectMergeNode={focusNode}
            onSelectMergeSource={focusNode}
            onContextMenu={openBranchMenu}
          />
        )}
      </React.Fragment>
    );
  };

  // Subscribed, so reading a thread (or "Read all") updates the filtered list
  // and the caught-up state without waiting for an unrelated re-render.
  const projectsToRender = useStructuralSelector(
    (nodes) => (unreadFilterOn
      ? liveProjects.filter((p) => workspaceHasUnread(p, nodes, focusedNodeId))
      : liveProjects),
    shallowArrayEqual,
  );

  return (
    <div
      className="term-scrollbar"
      style={{
        flex: 1,
        overflowY: 'auto',
        // Horizontal gutter between tree content and the sidebar edges. The
        // scrollbar still sits at the element's true right edge; only the rows
        // inset. 0 = original flush look. See Sidebar.tsx `--sb-inset`.
        paddingLeft: 'var(--sb-inset, 0px)',
        paddingRight: 'var(--sb-inset, 0px)',
      }}
    >
      {unreadFilterOn && projectsToRender.length > 0 && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            padding: '6px 8px',
            background: 'var(--term-sidebar-bg, var(--term-surface))',
            borderBottom: '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)',
          }}
        >
          <button
            type="button"
            className="t-row-hover sb-flush"
            aria-label="Mark all threads as read"
            onClick={() => markAllRead()}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '5px 8px',
              background: 'transparent',
              border: '1px solid var(--term-line)',
              borderRadius: 'var(--ui-radius)',
              color: 'var(--term-mid)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-md)',
              cursor: 'pointer',
            }}
          >
            <ReadAllIcon />
            Read all
          </button>
        </div>
      )}
      {(() => {
        const pinned = projectsToRender.filter((p) => !!p.pinnedAt);
        const unpinned = projectsToRender.filter((p) => !p.pinnedAt);
        const showPinnedSection = pinned.length > 0;
        return (
          <>
            {showPinnedSection && (
              <>
                <SectionLabel label="Pinned" />
                <div className="sb-section-items">
                  {pinned.map((p) => renderProject(p, { dnd: dndForProject(p.id) }))}
                </div>
              </>
            )}
            {unpinned.length > 0 && (
              <>
                <SectionLabel label="Projects" />
                <div className="sb-section-items">
                  {unpinned.map((p) => renderProject(p, { dnd: dndForProject(p.id) }))}
                </div>
              </>
            )}
            <SectionLabel label="Chats" />
            <div className="sb-section-items">
              <div
                style={{
                  padding: '4px 6px 4px 6px',
                  fontSize: 'var(--fs-sm)',
                  color: 'var(--term-muted)',
                  fontFamily: 'var(--ui-font)',
                }}
              >
                No project chats
              </div>
            </div>
          </>
        );
      })()}
      {unreadFilterOn && projectsToRender.length === 0 && (
        <div
          data-testid="all-caught-up"
          style={{
            padding: '24px 16px',
            color: 'var(--term-muted)',
            fontSize: 'var(--fs-md)',
            textAlign: 'center',
          }}
        >
          All caught up ✓
        </div>
      )}
      <AnimatePresence>
        {menu && (
          <ContextMenu
            key={`${menu.x}:${menu.y}`}
            x={menu.x}
            y={menu.y}
            sections={menuSections}
            onClose={closeMenu}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Section header for the Structure sidebar (Pinned / Projects / Chats).
 *  Style matches ActivityView's time-label: uppercase, 11px, faint color,
 *  aligned to WorkspaceRow folder-icon left edge (6 + inset from sidebar). */
function SectionLabel({ label }: { label: string }) {
  return (
    <div
      data-testid={`section-label-${label.toLowerCase()}`}
      className="sidebar-section-label"
    >
      {label}
    </div>
  );
}

function MergedGroupsSection({
  project,
  mergeGroups,
  nodesSnapshot,
  focusedNodeId,
  collapsedMergeGroups,
  toggleMergeGroup,
  isAlive,
  onSelectMergeNode,
  onSelectMergeSource,
  onContextMenu,
}: {
  project: Project;
  mergeGroups: MergeGroup[];
  nodesSnapshot: Readonly<Record<string, ChatNodeState>>;
  focusedNodeId: string | null;
  collapsedMergeGroups: ReadonlySet<string>;
  toggleMergeGroup: (mergeNodeId: string) => void;
  isAlive: (nodeId: string) => boolean;
  onSelectMergeNode: (nodeId: string) => void;
  onSelectMergeSource: (nodeId: string) => void;
  onContextMenu: (nodeId: string, event: React.MouseEvent) => void;
}) {
  const [mergedVisibleLimit, setMergedVisibleLimit] = useState(MERGED_PREVIEW_LIMIT);
  const visibleGroups = mergeGroups.filter((g) => nodesSnapshot[g.mergeNodeId]);
  const displayedGroups = visibleGroups.slice(0, mergedVisibleLimit);

  return (
    <div data-testid="merged-section" style={{ marginTop: 12 }}>
      <div style={{
        padding: '4px 10px', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)',
      }}>
        ── Merged ──
      </div>
      {displayedGroups.map((g) => {
        const merged = nodesSnapshot[g.mergeNodeId];
        const mergedTitle = merged.title ?? 'Untitled';
        const isFocused = focusedNodeId === g.mergeNodeId;
        const expanded = !collapsedMergeGroups.has(g.mergeNodeId);
        const branchChildIds = Array.from(descendants(g.mergeNodeId, project.edges, isAlive));
        const hasChildren = g.sources.length > 0 || branchChildIds.length > 0;
        return (
          <div key={g.mergeNodeId} data-testid={`merge-group-${g.mergeNodeId}`}>
            <Row
              active={isFocused}
              onClick={() => onSelectMergeNode(g.mergeNodeId)}
              onContextMenu={(e: React.MouseEvent) => onContextMenu(g.mergeNodeId, e)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                // +--sb-inset indents the text; full-bleed box keeps the focused
                // borderLeft flush to the sidebar edge (see index.css / ThreadRow).
                padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(8px + var(--sb-inset, 0px))',
                background: isFocused ? 'var(--term-alt)' : 'transparent',
                borderLeft: isFocused
                  ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
                // Focus changes colour and fill, not weight (see ThreadRow).
                color: isFocused ? 'var(--term-fg)' : 'var(--term-mid)',
                fontWeight: 400,
                fontSize: 'var(--fs-md)',
                fontFamily: 'var(--ui-font)',
              }}
            >
              <Chevron
                expanded={expanded}
                visible={hasChildren}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) toggleMergeGroup(g.mergeNodeId);
                }}
              />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                  WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                }}
              >
                {mergedTitle}
              </span>
            </Row>
            {expanded && g.sources.map((sid) => {
              const src = nodesSnapshot[sid];
              const deleted = !src || !!src.deletedAt;
              const title = deleted ? '(deleted)' : (src?.title ?? 'Untitled');
              const focused = focusedNodeId === sid;
              return (
                <Row
                  key={`src-${sid}`}
                  active={focused}
                  onClick={() => { if (!deleted) onSelectMergeSource(sid); }}
                  onContextMenu={(e: React.MouseEvent) => { if (!deleted) onContextMenu(sid, e); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(28px + var(--sb-inset, 0px))',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: 'var(--term-muted)',
                    fontStyle: 'italic',
                    textDecoration: deleted ? 'line-through' : 'none',
                    fontSize: 'var(--fs-md)',
                    fontFamily: 'var(--ui-font)',
                    cursor: deleted ? 'default' : 'pointer',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                      WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                    }}
                  >
                    {title}
                  </span>
                </Row>
              );
            })}
            {expanded && branchChildIds.map((cid) => {
              const child = nodesSnapshot[cid];
              if (!child) return null;
              const childTitle = child.title ?? 'Untitled';
              const focused = focusedNodeId === cid;
              return (
                <Row
                  key={`child-${cid}`}
                  active={focused}
                  onClick={() => onSelectMergeSource(cid)}
                  onContextMenu={(e: React.MouseEvent) => onContextMenu(cid, e)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(28px + var(--sb-inset, 0px))',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: focused ? 'var(--term-fg)' : 'var(--term-mid)',
                    fontWeight: 400,
                    fontSize: 'var(--fs-md)',
                    fontFamily: 'var(--ui-font)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                      WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
                    }}
                  >
                    {childTitle}
                  </span>
                </Row>
              );
            })}
          </div>
        );
      })}
      {visibleGroups.length > mergedVisibleLimit && (
        <button
          type="button"
          className="sb-flush show-more-toggle"
          aria-label="Show more merged threads"
          aria-expanded={mergedVisibleLimit > MERGED_PREVIEW_LIMIT}
          onClick={() => setMergedVisibleLimit((v) => v + MERGED_PAGE_SIZE)}
          style={{
            width: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 8px 5px 25px',
            background: 'transparent',
            border: 0,
            textAlign: 'left',
            color: 'var(--term-muted)',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted',
            textUnderlineOffset: '3px',
            textDecorationColor: 'var(--term-faint)',
          }}
        >
          Show more
        </button>
      )}

    </div>
  );
}

/** Double-check glyph — "mark all read". */
function ReadAllIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8.5l3 3 6-6.5" />
      <path d="M7 11l.7.7 6-6.7" />
    </svg>
  );
}
