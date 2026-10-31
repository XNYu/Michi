import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatActions, useChatNodesSnapshot, useChatPanes, useChatProjects } from '../../../state/chatStore';
import { usePrefs, type Prefs } from '../../../state/prefs';
import {
  isBranchExpanded,
  isThreadExpanded,
  isWorkspaceExpanded,
  orderPinnedFirst,
  type NodePinnedAt,
} from '../../../state/sidebarSelectors';
import { buildTree, findTreeIdForNode, type TreeNode } from '../../../state/tree';
import { buildTreeContextMenu } from '../../../lib/treeContextMenu';
import type { MenuSection } from '../../ContextMenu';
import type { Project, ProjectEdge, Tree } from '../../../state/chatTypes';

type Expanded = Prefs['sidebarExpanded'];

interface BranchMenu {
  x: number;
  y: number;
  targetId: string;
  project: Project;
}

/** Flat DFS over the branch nodes of `trees` (tree roots excluded: thread rows
 *  don't take part in branch multi-select), pinned branches first, in the order
 *  the view lists the trees. ⇧+click range selection walks this list, so it
 *  must match what the user sees. Collapsed branches are still included. */
export function flattenBranchIds(
  trees: readonly Tree[],
  edges: readonly ProjectEdge[],
  isAlive: (id: string) => boolean,
  pinnedAt: NodePinnedAt,
): string[] {
  const ids: string[] = [];
  const visit = (node: TreeNode, isRoot: boolean) => {
    if (!isRoot) ids.push(node.nodeId);
    for (const child of node.children) visit(child, false);
  };
  for (const tree of trees) {
    if (tree.archivedAt || !isAlive(tree.rootNodeId)) continue;
    visit(orderPinnedFirst(buildTree(tree.rootNodeId, edges, isAlive), pinnedAt), true);
  }
  return ids;
}

/** Pin both ends of a thread/workspace switch into the explicit maps so every
 *  row keeps the expand/collapse state it showed right before the switch.
 *  Threads default to open when they are their project's active tree, so
 *  activating `nextTreeId` moves that default inside the destination project:
 *  its current active tree is pinned open and the incoming tree pinned
 *  collapsed. Workspaces default to open when active: the outgoing one is
 *  pinned open, the incoming one collapsed. Explicit entries are left alone.
 *  `nextTreeId === null` switches workspace only. */
function pinBeforeSwitch(
  cur: Expanded,
  projects: readonly Project[],
  activeProjectId: string | null,
  nextTreeId: string | null,
  nextProjectId: string | null,
): Expanded {
  let threads = cur.threads;
  const destActiveTreeId = projects.find((p) => p.id === nextProjectId)?.activeTreeId ?? null;
  if (nextTreeId && nextTreeId !== destActiveTreeId) {
    if (destActiveTreeId && threads[destActiveTreeId] === undefined) {
      threads = { ...threads, [destActiveTreeId]: true };
    }
    if (threads[nextTreeId] === undefined) threads = { ...threads, [nextTreeId]: false };
  }
  let workspaces = cur.workspaces;
  if (activeProjectId && activeProjectId !== nextProjectId && workspaces[activeProjectId] === undefined) {
    workspaces = { ...workspaces, [activeProjectId]: true };
  }
  if (nextProjectId && nextProjectId !== activeProjectId && workspaces[nextProjectId] === undefined) {
    workspaces = { ...workspaces, [nextProjectId]: false };
  }
  return threads !== cur.threads || workspaces !== cur.workspaces
    ? { ...cur, threads, workspaces }
    : cur;
}

/**
 * Tree controller shared by the sidebar's structure view (WorkspaceTree) and
 * activity view (ActivityView): expand/collapse state, thread and branch
 * navigation, branch selection, revealing the focused pane, and the branch
 * context menu. The views keep only their own data derivation and layout.
 *
 * `branchIdsForProject` returns a project's branch ids in the view's on-screen
 * order (see `flattenBranchIds`) for ⇧+click range selection.
 */
export function useSidebarTreeController({
  onActivate,
  branchIdsForProject,
}: {
  onActivate?: () => void;
  branchIdsForProject: (project: Project) => string[];
}) {
  const { projects, activeProjectId, activeProject, selection } = useChatProjects();
  const { focusedPane } = useChatPanes();
  const {
    selectProject,
    activateTree,
    openPane,
    openPaneInTree,
    setFocusedNodeId,
    toggleSelection,
    clearSelection,
    createBlankChild,
    deleteNode,
    trimNode,
    extractNodeTree,
    archiveNode,
    createMergedChat,
    createDigest,
    archiveTree,
    pinNode,
    unpinNode,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();
  const nodes = useChatNodesSnapshot();
  const sidebarExpanded = prefs.sidebarExpanded;

  // ── Expansion ──
  // One click can write sidebarExpanded more than once (a switch's snapshot,
  // then the row's own toggle). Every write goes through the latest value, so
  // the second write builds on the first instead of on this render's copy.
  const latestExpanded = useRef(sidebarExpanded);
  const renderedExpanded = useRef(sidebarExpanded);
  if (renderedExpanded.current !== sidebarExpanded) {
    renderedExpanded.current = sidebarExpanded;
    latestExpanded.current = sidebarExpanded;
  }
  const updateExpanded = useCallback(
    (update: (cur: Expanded) => Expanded) => {
      const cur = latestExpanded.current;
      const next = update(cur);
      if (next === cur) return;
      latestExpanded.current = next;
      setPref('sidebarExpanded', next);
    },
    [setPref],
  );

  const isThreadOpen = useCallback(
    (treeId: string, ownerActiveTreeId: string | null) =>
      isThreadExpanded(sidebarExpanded, treeId, ownerActiveTreeId),
    [sidebarExpanded],
  );
  const isBranchOpen = useCallback(
    (nodeId: string) => isBranchExpanded(sidebarExpanded, nodeId),
    [sidebarExpanded],
  );

  const toggleThread = useCallback(
    (treeId: string) => {
      const ownerActiveTreeId =
        projects.find((p) => p.trees.some((t) => t.id === treeId))?.activeTreeId ?? null;
      updateExpanded((cur) => ({
        ...cur,
        threads: { ...cur.threads, [treeId]: !isThreadExpanded(cur, treeId, ownerActiveTreeId) },
      }));
    },
    [projects, updateExpanded],
  );

  const setThreadExpanded = useCallback(
    (treeId: string, expanded: boolean) =>
      updateExpanded((cur) => ({ ...cur, threads: { ...cur.threads, [treeId]: expanded } })),
    [updateExpanded],
  );

  const toggleBranch = useCallback(
    (nodeId: string) =>
      updateExpanded((cur) => ({
        ...cur,
        branches: { ...cur.branches, [nodeId]: !cur.branches[nodeId] },
      })),
    [updateExpanded],
  );

  /** Pin the visible expand state before a thread/workspace switch (see
   *  pinBeforeSwitch). `adjust` edits the pinned value in the same write. */
  const snapshotBeforeSwitch = useCallback(
    (nextTreeId: string | null, nextProjectId: string | null, adjust?: (next: Expanded) => Expanded) =>
      updateExpanded((cur) => {
        const next = pinBeforeSwitch(cur, projects, activeProjectId, nextTreeId, nextProjectId);
        return adjust ? adjust(next) : next;
      }),
    [updateExpanded, projects, activeProjectId],
  );

  // ── Navigation ──
  const anchorRef = useRef<string | null>(null);
  const treeAnchorRef = useRef<string | null>(null);

  /** Open `nodeId` in `treeId` of `project`, switching thread/workspace when
   *  needed. Order matters:
   *    - snapshot first, so the switch changes no row's expand state;
   *    - openPaneInTree before activateTree, so ensurePaneSlot (inside
   *      activateTree) sees a populated slot and skips its [root] default —
   *      plain openPane would write into the OUTGOING paneKey, which only
   *      re-derives after a re-render;
   *    - setFocusedNodeId after activateTree, which would otherwise reset
   *      focus to the tree's root. */
  const openInTree = useCallback(
    (project: Project, treeId: string, nodeId: string) => {
      const crossesThread = project.id !== activeProjectId || treeId !== project.activeTreeId;
      if (crossesThread) {
        snapshotBeforeSwitch(treeId, project.id);
        openPaneInTree(project.id, treeId, nodeId);
        if (project.id !== activeProjectId) selectProject(project.id);
        if (treeId !== project.activeTreeId) activateTree(treeId, project.id);
      } else {
        openPane(nodeId);
      }
      setFocusedNodeId(nodeId);
    },
    [activeProjectId, snapshotBeforeSwitch, openPaneInTree, selectProject, activateTree, openPane, setFocusedNodeId],
  );

  /** Click on a thread row body: open + focus the tree's root, even when the
   *  thread is already active (a branch may hold the focus). */
  const openThreadRoot = useCallback(
    (tree: Pick<Tree, 'id' | 'rootNodeId'>, project: Project) => {
      if (selection.size > 0) clearSelection();
      openInTree(project, tree.id, tree.rootNodeId);
      anchorRef.current = tree.rootNodeId;
      treeAnchorRef.current = tree.id;
      onActivate?.();
    },
    [selection, clearSelection, openInTree, onActivate],
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
      const owningProject = projects.find((p) => !p.deletedAt && p.chatIds.includes(nodeId));
      // ⇧+click — additive range from the anchor through this node.
      if (event.shiftKey && anchorRef.current) {
        event.preventDefault();
        if (!owningProject) return;
        const ids = branchIdsForProject(owningProject);
        const a = ids.indexOf(anchorRef.current);
        const b = ids.indexOf(nodeId);
        if (a === -1 || b === -1) return;
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (const id of ids.slice(lo, hi + 1)) {
          if (!selection.has(id)) toggleSelection(id);
        }
        return;
      }
      // Plain click — replace any multi-selection, then open + focus.
      if (selection.size > 0) clearSelection();
      const owningTreeId = owningProject ? findTreeIdForNode(nodeId, owningProject) : null;
      if (owningProject && owningTreeId) {
        openInTree(owningProject, owningTreeId, nodeId);
      } else {
        openPane(nodeId);
        setFocusedNodeId(nodeId);
      }
      anchorRef.current = nodeId;
      onActivate?.();
    },
    [projects, branchIdsForProject, selection, toggleSelection, clearSelection, openInTree, openPane, setFocusedNodeId, onActivate],
  );

  /** Open (or focus) a node in the current tree. */
  const focusNode = useCallback(
    (nodeId: string) => {
      openPane(nodeId);
      setFocusedNodeId(nodeId);
      onActivate?.();
    },
    [openPane, setFocusedNodeId, onActivate],
  );

  const isBranchSelected = useCallback((nodeId: string) => selection.has(nodeId), [selection]);

  // ── Reveal the focused pane ──
  // Expand the owning workspace, thread and every ancestor branch so the row
  // becomes visible, then scroll it into view. Runs only when focusedPane
  // changes; the ref holds the latest projects so a manual collapse/expand by
  // the user isn't undone by unrelated updates (e.g. background streams).
  const revealRef = useRef({ projects, activeProject, activeProjectId });
  revealRef.current = { projects, activeProject, activeProjectId };
  useEffect(() => {
    if (!focusedPane) return;
    const { projects: all, activeProject: active, activeProjectId: pid } = revealRef.current;
    const candidates = active
      ? [active, ...all.filter((p) => p.id !== active.id && !p.deletedAt && !p.archivedAt)]
      : all.filter((p) => !p.deletedAt && !p.archivedAt);
    let project: Project | undefined;
    let owningTreeId: string | null = null;
    for (const p of candidates) {
      owningTreeId = findTreeIdForNode(focusedPane, p);
      if (owningTreeId) { project = p; break; }
    }
    const owningTree = project?.trees.find((t) => t.id === owningTreeId);
    if (!project || !owningTreeId || !owningTree) return;

    const parentOf = new Map<string, string>();
    for (const e of project.edges) {
      if (e.kind !== undefined && e.kind !== 'branch') continue;
      parentOf.set(e.target, e.source);
    }
    const treeRoots = new Set(project.trees.map((t) => t.rootNodeId));
    const ancestors: string[] = [];
    const seen = new Set<string>();
    let walker = parentOf.get(focusedPane);
    while (walker && !seen.has(walker)) {
      seen.add(walker);
      if (treeRoots.has(walker)) break;
      ancestors.push(walker);
      walker = parentOf.get(walker);
    }

    const owner = project;
    const treeId = owningTreeId;
    updateExpanded((cur) => {
      let next = cur;
      if (!isWorkspaceExpanded(cur, owner.id, pid)) {
        next = { ...next, workspaces: { ...next.workspaces, [owner.id]: true } };
      }
      // The root row is visible with its thread collapsed.
      if (focusedPane !== owningTree.rootNodeId && !isThreadExpanded(next, treeId, owner.activeTreeId)) {
        next = { ...next, threads: { ...next.threads, [treeId]: true } };
      }
      const closed = ancestors.filter((a) => !next.branches[a]);
      if (closed.length > 0) {
        const branches = { ...next.branches };
        for (const a of closed) branches[a] = true;
        next = { ...next, branches };
      }
      return next;
    });

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
  }, [focusedPane, updateExpanded]);

  // ── Branch context menu ──
  const [menu, setMenu] = useState<BranchMenu | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);

  const openBranchMenu = useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      event.preventDefault();
      const project = projects.find((p) => !p.deletedAt && p.chatIds.includes(nodeId));
      if (!project) return;
      setMenu({ x: event.clientX, y: event.clientY, targetId: nodeId, project });
    },
    [projects],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const isBranchMenuTarget = useCallback((nodeId: string) => menu?.targetId === nodeId, [menu]);
  const endRename = useCallback(() => setRenamingNodeId(null), []);

  const menuSections: MenuSection[] = menu
    ? buildTreeContextMenu({
        targetId: menu.targetId,
        project: menu.project,
        nodes,
        selection,
        actions: {
          openPane: focusNode,
          createBlankChild,
          toggleSelection,
          clearSelection,
          deleteNode,
          trimNode,
          extractNodeTree: async (id) => {
            if (await extractNodeTree(id)) onActivate?.();
          },
          archiveNode,
          createMergedChat,
          createDigest,
          openExportPanel: () =>
            window.dispatchEvent(new CustomEvent('michi:toggle-export-panel')),
          archiveTree,
          focusOrOpen: focusNode,
          beginInlineRename: (id) => {
            setMenu(null);
            setRenamingNodeId(id);
          },
          pinNode,
          unpinNode,
        },
      })
    : [];

  return {
    // expansion
    isThreadOpen,
    isBranchOpen,
    toggleThread,
    setThreadExpanded,
    toggleBranch,
    snapshotBeforeSwitch,
    updateExpanded,
    // navigation and selection
    openThreadRoot,
    selectBranch,
    focusNode,
    isBranchSelected,
    treeAnchorRef,
    // branch context menu
    menu,
    menuSections,
    openBranchMenu,
    closeMenu,
    isBranchMenuTarget,
    renamingNodeId,
    endRename,
  };
}
