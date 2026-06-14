import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatActions, useChatNodesSnapshot, useChatProjects } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import type { Prefs } from '../../state/prefs';
import {
  isWorkspaceExpanded,
  isThreadExpanded,
  isBranchExpanded,
  sortTrees,
  sortLiveProjects,
  mergeReferences,
  workspaceHasUnread,
} from '../../state/sidebarSelectors';
import WorkspaceRow from './WorkspaceRow';
import ContextMenu from '../ContextMenu';
import { buildTreeContextMenu } from '../../lib/treeContextMenu';
import { buildTree, descendants, findTreeIdForNode, type TreeNode } from '../../state/tree';
import { Row } from './primitives';
import { Chevron } from './ThreadRow';
import type { Project, ChatNodeState } from '../../state/chatTypes';

const MERGED_PREVIEW_LIMIT = 5;

interface MergeGroup {
  mergeNodeId: string;
  sources: string[];
  mergeTreeId: string;
}

/** Flat DFS over a project's branch nodes (skips the tree roots themselves
 *  since ThreadRow doesn't participate in multi-select). Order matches what
 *  the user sees on screen, so ⇧+click range-select feels predictable.
 *  Branches that aren't currently expanded are still included — selecting a
 *  collapsed-and-hidden range is unusual but cheap to support. */
function flattenProjectBranchIds(project: Project, isAlive: (id: string) => boolean): string[] {
  const ids: string[] = [];
  const visit = (node: TreeNode, isRoot: boolean) => {
    if (!isRoot) ids.push(node.nodeId);
    for (const child of node.children) visit(child, false);
  };
  for (const tree of project.trees) {
    if (tree.archivedAt) continue;
    if (!isAlive(tree.rootNodeId)) continue;
    const root = buildTree(tree.rootNodeId, project.edges, isAlive);
    visit(root, true);
  }
  return ids;
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
    activeProject,
    focusedNodeId,
    focusedPane,
    selection,
    unreadFilterOn,
  } = useChatProjects();
  const {
    selectProject,
    activateTree,
    archiveTree,
    unarchiveTree,
    renameTree,
    deleteTree,
    moveTreeToWorkspace,
    renameProject,
    archiveProject,
    unarchiveProject,
    deleteProject,
    createThread,
    setFocusedNodeId,
    openPane,
    openPaneInTree,
    toggleSelection,
    clearSelection,
    deleteNode,
    trimNode,
    createBlankChild,
    createMergedChat,
    createDigest,
    markAllRead,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();
  const nodesSnapshot = useChatNodesSnapshot();

  const liveProjects = useMemo(
    () => sortLiveProjects(projects, prefs.workspaceOrder),
    [projects, prefs.workspaceOrder],
  );
  const archivedProjects = useMemo(
    () => projects.filter((p) => !p.deletedAt && !!p.archivedAt),
    [projects],
  );
  const [archivedOpen, setArchivedOpen] = useState(false);
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
    (id: string) => !nodesSnapshot[id]?.deletedAt,
    [nodesSnapshot],
  );

  const toggleWorkspace = useCallback(
    (projectId: string) => {
      const cur = isWorkspaceExpanded(prefs.sidebarExpanded, projectId, activeProjectId);
      const next = {
        ...prefs.sidebarExpanded,
        workspaces: { ...prefs.sidebarExpanded.workspaces, [projectId]: !cur },
      };
      setPref('sidebarExpanded', next);
    },
    [prefs.sidebarExpanded, activeProjectId, setPref],
  );

  const toggleThread = useCallback(
    (treeId: string) => {
      const cur = isThreadExpanded(prefs.sidebarExpanded, treeId, activeProject?.activeTreeId ?? null);
      const next = {
        ...prefs.sidebarExpanded,
        threads: { ...prefs.sidebarExpanded.threads, [treeId]: !cur },
      };
      setPref('sidebarExpanded', next);
    },
    [prefs.sidebarExpanded, activeProject, setPref],
  );

  const setThreadExpanded = useCallback(
    (treeId: string, expanded: boolean) => {
      const next = {
        ...prefs.sidebarExpanded,
        threads: { ...prefs.sidebarExpanded.threads, [treeId]: expanded },
      };
      setPref('sidebarExpanded', next);
    },
    [prefs.sidebarExpanded, setPref],
  );

  const toggleBranch = useCallback(
    (nodeId: string) => {
      const cur = !!prefs.sidebarExpanded.branches[nodeId];
      const next = {
        ...prefs.sidebarExpanded,
        branches: { ...prefs.sidebarExpanded.branches, [nodeId]: !cur },
      };
      setPref('sidebarExpanded', next);
    },
    [prefs.sidebarExpanded, setPref],
  );

  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<
    { x: number; y: number; targetId: string; project: Project } | null
  >(null);

  /** Pin BOTH ends of a workspace/thread switch into the explicit map so the
   *  visual expand/collapse state right before the switch is preserved after
   *  it. Outgoing rows are implicitly expanded (active default) → pin true.
   *  Incoming rows are implicitly collapsed (non-active default) → pin false.
   *  Already-explicit entries are left alone. Returns a fresh
   *  `sidebarExpanded` value that callers must persist. */
  const snapshotBeforeSwitch = useCallback(
    (
      nextActiveTreeId: string | null,
      nextActiveProjectId: string | null,
    ): Prefs['sidebarExpanded'] => {
      const cur = prefs.sidebarExpanded;
      const prevTreeId = activeProject?.activeTreeId ?? null;
      let threads = cur.threads;
      if (prevTreeId && prevTreeId !== nextActiveTreeId && threads[prevTreeId] === undefined) {
        threads = { ...threads, [prevTreeId]: true };
      }
      if (
        nextActiveTreeId &&
        nextActiveTreeId !== prevTreeId &&
        threads[nextActiveTreeId] === undefined
      ) {
        threads = { ...threads, [nextActiveTreeId]: false };
      }
      let workspaces = cur.workspaces;
      if (
        activeProjectId &&
        activeProjectId !== nextActiveProjectId &&
        workspaces[activeProjectId] === undefined
      ) {
        workspaces = { ...workspaces, [activeProjectId]: true };
      }
      if (
        nextActiveProjectId &&
        nextActiveProjectId !== activeProjectId &&
        workspaces[nextActiveProjectId] === undefined
      ) {
        workspaces = { ...workspaces, [nextActiveProjectId]: false };
      }
      return threads !== cur.threads || workspaces !== cur.workspaces
        ? { ...cur, threads, workspaces }
        : cur;
    },
    [activeProject, activeProjectId, prefs.sidebarExpanded],
  );

  const isBranchSelected = useCallback(
    (nodeId: string) => selection.has(nodeId),
    [selection],
  );

  const branchIdsForProject = useCallback(
    (project: Project) => flattenProjectBranchIds(project, isAlive),
    [isAlive],
  );

  const selectBranch = useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      // ⌘/Ctrl+click — toggle this node in/out of the multi-selection.
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        toggleSelection(nodeId);
        anchorRef.current = nodeId;
        return;
      }
      // ⇧+click — additive range from anchor through this node.
      if (event.shiftKey && anchorRef.current) {
        event.preventDefault();
        const project = projects.find(
          (p) => !p.deletedAt && p.chatIds.includes(nodeId),
        );
        if (!project) return;
        const ids = branchIdsForProject(project);
        const a = ids.indexOf(anchorRef.current);
        const b = ids.indexOf(nodeId);
        if (a === -1 || b === -1) return;
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = ids.slice(lo, hi + 1);
        for (const rid of range) {
          if (!selection.has(rid)) toggleSelection(rid);
        }
        return;
      }
      // Plain click — replace any existing multi-selection, then focus.
      if (selection.size > 0) clearSelection();
      // Resolve which (project, tree) this node lives in. When the click
      // crosses a thread/workspace boundary we must:
      //   1. switch active project (so sidebar highlight follows)
      //   2. activate the destination tree (so ThreadRow.isActive flips)
      //   3. open the pane *in the destination tree's slot* — plain
      //      `openPane` would write into the *outgoing* paneKey because
      //      paneKey only re-derives after a re-render.
      const owningProject = projects.find(
        (p) => !p.deletedAt && p.chatIds.includes(nodeId),
      );
      const owningTreeId = owningProject
        ? findTreeIdForNode(nodeId, owningProject)
        : null;
      const crossesThread =
        !!owningProject &&
        !!owningTreeId &&
        (owningProject.id !== activeProjectId ||
          owningTreeId !== owningProject.activeTreeId);
      if (owningProject && owningTreeId && crossesThread) {
        // Snapshot expanded state before the active flip so the outgoing
        // active row stays expanded and the incoming row keeps its current
        // (collapsed) visual state — switching threads must NOT change any
        // node's expand/collapse status.
        const nextExpanded = snapshotBeforeSwitch(owningTreeId, owningProject.id);
        if (nextExpanded !== prefs.sidebarExpanded) {
          setPref('sidebarExpanded', nextExpanded);
        }
        // Order matters:
        //   - openPaneInTree first so ensurePaneSlot (called inside
        //     activateTree) sees a non-empty slot and skips its [rootB]
        //     default — otherwise the pane slot ends up [rootB, branchB].
        //   - selectProject + activateTree second so sidebar highlight + the
        //     derived paneKey switch over.
        openPaneInTree(owningProject.id, owningTreeId, nodeId);
        if (owningProject.id !== activeProjectId) selectProject(owningProject.id);
        if (owningTreeId !== owningProject.activeTreeId) {
          activateTree(owningTreeId, owningProject.id);
        }
      } else {
        openPane(nodeId);
      }
      // Set focus *after* activateTree (which would otherwise overwrite it
      // with the tree's rootNodeId).
      setFocusedNodeId(nodeId);
      anchorRef.current = nodeId;
      onActivate?.();
    },
    [
      projects,
      branchIdsForProject,
      selection,
      toggleSelection,
      clearSelection,
      activeProjectId,
      selectProject,
      activateTree,
      setFocusedNodeId,
      openPane,
      openPaneInTree,
      onActivate,
      snapshotBeforeSwitch,
      prefs.sidebarExpanded,
      setPref,
    ],
  );

  const branchContextMenu = useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      event.preventDefault();
      const project = projects.find(
        (p) => !p.deletedAt && p.chatIds.includes(nodeId),
      );
      if (!project) return;
      setMenu({ x: event.clientX, y: event.clientY, targetId: nodeId, project });
    },
    [projects],
  );

  /** Click on a thread row body. Always opens + focuses the tree's root,
   *  with the same cross-thread/workspace routing as `selectBranch` so a
   *  thread row click after a sidebar branch click correctly returns the
   *  root to the pane stack. */
  const selectThreadRoot = useCallback(
    (tree: { id: string; rootNodeId: string }, project: Project) => {
      if (selection.size > 0) clearSelection();
      const rootNodeId = tree.rootNodeId;
      const crossesThread =
        project.id !== activeProjectId || tree.id !== project.activeTreeId;
      if (crossesThread) {
        // Snapshot expanded state before the active flip — see selectBranch
        // for the rationale.
        const nextExpanded = snapshotBeforeSwitch(tree.id, project.id);
        if (nextExpanded !== prefs.sidebarExpanded) {
          setPref('sidebarExpanded', nextExpanded);
        }
        // Seed destination slot first so activateTree's ensurePaneSlot
        // no-ops when our slot is already populated.
        openPaneInTree(project.id, tree.id, rootNodeId);
        if (project.id !== activeProjectId) selectProject(project.id);
        if (tree.id !== project.activeTreeId) activateTree(tree.id, project.id);
      } else {
        openPane(rootNodeId);
      }
      setFocusedNodeId(rootNodeId);
      anchorRef.current = rootNodeId;
      onActivate?.();
    },
    [
      selection,
      clearSelection,
      activeProjectId,
      selectProject,
      activateTree,
      openPane,
      openPaneInTree,
      setFocusedNodeId,
      onActivate,
      snapshotBeforeSwitch,
      prefs.sidebarExpanded,
      setPref,
    ],
  );

  // Reveal the focused pane in the sidebar: expand the owning workspace,
  // thread, and every ancestor branch so the row becomes visible, then scroll
  // it into view. Triggered only on focusedPane changes — refs hold the
  // latest prefs/project so manual collapse/expand by the user isn't undone.
  const revealRef = useRef({
    activeProject,
    activeProjectId,
    sidebarExpanded: prefs.sidebarExpanded,
    setPref,
  });
  revealRef.current = {
    activeProject,
    activeProjectId,
    sidebarExpanded: prefs.sidebarExpanded,
    setPref,
  };
  useEffect(() => {
    if (!focusedPane) return;
    const { activeProject: project, activeProjectId: pid, sidebarExpanded: cur, setPref: write } = revealRef.current;
    if (!project) return;
    const owningTreeId = findTreeIdForNode(focusedPane, project);
    if (!owningTreeId) return;
    const owningTree = project.trees.find((t) => t.id === owningTreeId);
    if (!owningTree) return;

    const parentOf = new Map<string, string>();
    for (const e of project.edges) {
      if (e.kind !== undefined && e.kind !== 'branch') continue;
      parentOf.set(e.target, e.source);
    }
    const treeRoots = new Set(project.trees.map((t) => t.rootNodeId));
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let walker: string | undefined = parentOf.get(focusedPane);
    while (walker && !seen.has(walker)) {
      seen.add(walker);
      if (treeRoots.has(walker)) break;
      ancestors.push(walker);
      walker = parentOf.get(walker);
    }

    let next = cur;
    if (!isWorkspaceExpanded(cur, project.id, pid)) {
      next = { ...next, workspaces: { ...next.workspaces, [project.id]: true } };
    }
    const needThreadOpen = focusedPane !== owningTree.rootNodeId;
    if (needThreadOpen && !isThreadExpanded(next, owningTreeId, project.activeTreeId ?? null)) {
      next = { ...next, threads: { ...next.threads, [owningTreeId]: true } };
    }
    let branchesNext = next.branches;
    let branchChanged = false;
    for (const a of ancestors) {
      if (!branchesNext[a]) {
        if (!branchChanged) {
          branchesNext = { ...branchesNext };
          branchChanged = true;
        }
        branchesNext[a] = true;
      }
    }
    if (branchChanged) next = { ...next, branches: branchesNext };
    if (next !== cur) write('sidebarExpanded', next);

    // Wait two frames so the expansion-driven re-render commits before we
    // query the DOM — collapsed rows aren't in the document until React
    // paints with the new `sidebarExpanded`.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-sidebar-row="${CSS.escape(focusedPane)}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [focusedPane]);

  const menuSections = menu
    ? buildTreeContextMenu({
        targetId: menu.targetId,
        project: menu.project,
        nodes: nodesSnapshot,
        selection,
        actions: {
          openPane: (id) => {
            openPane(id);
            setFocusedNodeId(id);
            onActivate?.();
          },
          createBlankChild,
          toggleSelection,
          clearSelection,
          deleteNode,
          trimNode,
          createMergedChat,
          createDigest,
          openExportPanel: () =>
            window.dispatchEvent(new CustomEvent('michi:toggle-export-panel')),
          archiveTree,
          focusOrOpen: (id) => {
            openPane(id);
            setFocusedNodeId(id);
            onActivate?.();
          },
        },
      })
    : [];

  /** Jump to the original position of a merge source — mirrors the plain
   *  click path in selectBranch (open pane + focus). */
  const onSelectMergeSource = useCallback(
    (sid: string) => {
      openPane(sid);
      setFocusedNodeId(sid);
      onActivate?.();
    },
    [openPane, setFocusedNodeId, onActivate],
  );

  /** Open (or focus) the merged result node. */
  const onSelectMergeNode = useCallback(
    (nid: string) => {
      openPane(nid);
      setFocusedNodeId(nid);
      onActivate?.();
    },
    [openPane, setFocusedNodeId, onActivate],
  );

  const activateTreeStable = useCallback(
    (treeId: string, projectId: string) => {
      const next = snapshotBeforeSwitch(treeId, projectId);
      if (next !== prefs.sidebarExpanded) setPref('sidebarExpanded', next);
      if (projectId !== activeProjectId) selectProject(projectId);
      activateTree(treeId);
      onActivate?.();
    },
    [snapshotBeforeSwitch, prefs.sidebarExpanded, setPref, activeProjectId, selectProject, activateTree, onActivate],
  );

  /** Select a project and atomically set its expand state in a single
   *  setPref call. `expanded === undefined` preserves whatever the snapshot
   *  pinned (i.e. the visual state right before the switch). Bundling avoids
   *  the stale-closure race where a follow-up toggleWorkspace would clobber
   *  the snapshot's pinned values. */
  const selectProjectStable = useCallback(
    (projectId: string, expanded?: boolean) => {
      const sameProject = projectId === activeProjectId;
      if (sameProject && expanded === undefined) return;
      let next = snapshotBeforeSwitch(activeProject?.activeTreeId ?? null, projectId);
      if (expanded !== undefined) {
        next = {
          ...next,
          workspaces: { ...next.workspaces, [projectId]: expanded },
        };
      }
      if (next !== prefs.sidebarExpanded) setPref('sidebarExpanded', next);
      if (!sameProject) selectProject(projectId);
    },
    [snapshotBeforeSwitch, activeProject, activeProjectId, prefs.sidebarExpanded, setPref, selectProject],
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
          isThreadExpanded={(treeId) =>
            isThreadExpanded(
              prefs.sidebarExpanded,
              treeId,
              project.activeTreeId,
            )
          }
          isBranchExpanded={(nodeId) =>
            isBranchExpanded(prefs.sidebarExpanded, nodeId)
          }
          isBranchSelected={isBranchSelected}
          isBranchMenuTarget={(nodeId) => menu?.targetId === nodeId}
          isNodeAlive={isAlive}
          sortedTrees={sortedTreesArr}
          edges={project.edges}
          actions={{
            toggleWorkspace,
            toggleThread,
            setThreadExpanded,
            toggleBranch,
            activateTree: (treeId) => activateTreeStable(treeId, project.id),
            selectProject: selectProjectStable,
            createThread: () => {
              createThread();
              onActivate?.();
            },
            archiveTree,
            unarchiveTree,
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
            deleteProject,
            selectBranch,
            branchContextMenu,
            selectThreadRoot,
          }}
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
            onSelectMergeNode={onSelectMergeNode}
            onSelectMergeSource={onSelectMergeSource}
          />
        )}
      </React.Fragment>
    );
  };

  const projectsToRender = unreadFilterOn
    ? liveProjects.filter((p) => workspaceHasUnread(p, nodesSnapshot, focusedNodeId))
    : liveProjects;

  return (
    <div className="term-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
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
            className="t-row-hover"
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
              borderRadius: 4,
              color: 'var(--term-mid)',
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <ReadAllIcon />
            Read all
          </button>
        </div>
      )}
      {projectsToRender.map((p) => renderProject(p, { dnd: dndForProject(p.id) }))}
      {unreadFilterOn && projectsToRender.length === 0 && (
        <div
          data-testid="all-caught-up"
          style={{
            padding: '24px 16px',
            color: 'var(--term-faint)',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          All caught up ✓
        </div>
      )}
      {!unreadFilterOn && archivedProjects.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div
            onClick={() => setArchivedOpen((v) => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              fontSize: 10.5,
              color: 'var(--term-muted)',
              letterSpacing: '.06em',
              fontFamily: 'var(--ui-font)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span
              style={{
                width: 12,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--ui-font)',
                fontSize: 11,
                transform: archivedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms var(--t-ease, ease-out)',
              }}
            >
              ›
            </span>
            archived workspaces
          </div>
          {archivedOpen && archivedProjects.map((p) => renderProject(p))}
        </div>
      )}
      {menu && (
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
}) {
  const [showAllMerged, setShowAllMerged] = useState(false);
  const visibleGroups = mergeGroups.filter((g) => nodesSnapshot[g.mergeNodeId]);
  const displayedGroups = showAllMerged
    ? visibleGroups
    : visibleGroups.slice(0, MERGED_PREVIEW_LIMIT);

  return (
    <div data-testid="merged-section" style={{ marginTop: 12 }}>
      <div style={{
        padding: '4px 10px', fontSize: 10, color: 'var(--term-muted)',
        textTransform: 'uppercase', letterSpacing: 1,
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
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px 4px 8px',
                background: isFocused ? 'var(--term-alt)' : 'transparent',
                borderLeft: isFocused
                  ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
                color: isFocused ? 'var(--term-fg)' : 'var(--term-mid)',
                fontWeight: isFocused ? 600 : 400,
                fontSize: 11.5,
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
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px 4px 28px',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: deleted ? 'var(--term-muted)' : 'var(--term-faint)',
                    fontStyle: 'italic',
                    textDecoration: deleted ? 'line-through' : 'none',
                    fontSize: 11.5,
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
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px 4px 28px',
                    background: focused ? 'var(--term-alt)' : undefined,
                    borderLeft: focused
                      ? '2px solid var(--term-accent)'
                      : '2px solid transparent',
                    color: focused ? 'var(--term-fg)' : 'var(--term-mid)',
                    fontWeight: focused ? 600 : 400,
                    fontSize: 11.5,
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
      {visibleGroups.length > MERGED_PREVIEW_LIMIT && (
        <button
          type="button"
          className="t-row-hover"
          aria-label={showAllMerged ? 'Show less merged threads' : 'Show more merged threads'}
          aria-expanded={showAllMerged}
          onClick={() => setShowAllMerged((v) => !v)}
          style={{
            width: '100%',
            display: 'block',
            padding: '5px 8px 5px 25px',
            background: 'transparent',
            border: 0,
            textAlign: 'left',
            color: 'var(--term-muted)',
            fontFamily: 'var(--ui-font)',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          {showAllMerged ? 'Show less' : 'Show more'}
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
