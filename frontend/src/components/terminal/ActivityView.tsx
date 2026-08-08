import React, { useCallback, useMemo, useState } from 'react';
import { useChatProjects, useChatActions, useChatNodesSnapshot, useStructuralSelector } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import type { Project, Tree, ProjectEdge, ChatNodeState } from '../../state/chatTypes';
import { buildTree, findTreeIdForNode } from '../../state/tree';
import ThreadRow from './ThreadRow';
import BranchRow from './BranchRow';
import {
  isThreadExpanded,
  isBranchExpanded as isBranchExpandedFn,
  nodeOpenState,
  subtreeOpenState,
  selectProjectNodeStatuses,
  type OpenState,
} from '../../state/sidebarSelectors';

// ── Time bucket helpers ────────────────────────────────────────────────────

type TimeBucket = 'now' | 'today' | 'yesterday' | 'earlier';

function getTimeBucket(lastActiveAt: number, isStreaming: boolean): TimeBucket {
  if (isStreaming) return 'now';
  const now = Date.now();
  const d = new Date(lastActiveAt);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (lastActiveAt >= today.getTime()) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (lastActiveAt >= yesterday.getTime()) return 'yesterday';
  return 'earlier';
}

const BUCKET_ORDER: TimeBucket[] = ['now', 'today', 'yesterday', 'earlier'];
const BUCKET_LABELS: Record<TimeBucket, string> = {
  now: 'Now',
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};

// ── Data derivation ────────────────────────────────────────────────────────

interface ActivityTree {
  tree: Tree;
  project: Project;
  isStreaming: boolean;
  bucket: TimeBucket;
}

function hasStreamingNode(
  tree: Tree,
  project: Project,
  nodes: Record<string, ChatNodeState>,
): boolean {
  const stack = [tree.rootNodeId];
  const seen = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const e of project.edges) {
    if (e.kind && e.kind !== 'branch') continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = nodes[id];
    if (n?.status === 'streaming') return true;
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return false;
}

function deriveActivityData(
  projects: readonly Project[],
  nodes: Record<string, ChatNodeState>,
): ActivityTree[] {
  const items: ActivityTree[] = [];
  for (const project of projects) {
    if (project.deletedAt || project.archivedAt) continue;
    for (const tree of project.trees) {
      if (tree.archivedAt) continue;
      const rootNode = nodes[tree.rootNodeId];
      if (!rootNode || rootNode.deletedAt) continue;
      const streaming = hasStreamingNode(tree, project, nodes);
      const bucket = getTimeBucket(tree.lastActiveAt, streaming);
      items.push({ tree, project, isStreaming: streaming, bucket });
    }
  }
  items.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return b.tree.lastActiveAt - a.tree.lastActiveAt;
  });
  return items;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ActivityView({
  onActivate,
}: {
  onActivate?: () => void;
}) {
  const { projects, activeProjectId, activeProject, focusedNodeId, openPanes, focusedPane, selection, treeSelection } = useChatProjects();
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
    openPane,
    openPaneInTree,
    setFocusedNodeId,
    toggleSelection,
    clearSelection,
    toggleTreeSelection,
    clearTreeSelection,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();
  const nodes = useChatNodesSnapshot();

  const activityItems = useMemo(
    () => deriveActivityData(projects, nodes),
    [projects, nodes],
  );

  const bucketGroups = useMemo(() => {
    const groups = new Map<TimeBucket, ActivityTree[]>();
    for (const item of activityItems) {
      const arr = groups.get(item.bucket) ?? [];
      arr.push(item);
      groups.set(item.bucket, arr);
    }
    return groups;
  }, [activityItems]);

  const isAlive = useCallback(
    (id: string) => !nodes[id]?.deletedAt,
    [nodes],
  );

  // ── Thread expand/collapse ──
  const isThreadExpandedFn = useCallback(
    (treeId: string, ownerActiveTreeId: string | null) =>
      isThreadExpanded(prefs.sidebarExpanded, treeId, ownerActiveTreeId),
    [prefs.sidebarExpanded],
  );

  const toggleThread = useCallback(
    (treeId: string) => {
      const cur = prefs.sidebarExpanded.threads[treeId] ?? false;
      const next = {
        ...prefs.sidebarExpanded,
        threads: { ...prefs.sidebarExpanded.threads, [treeId]: !cur },
      };
      setPref('sidebarExpanded', next);
    },
    [prefs.sidebarExpanded, setPref],
  );

  const isBranchExpandedCb = useCallback(
    (nodeId: string) => isBranchExpandedFn(prefs.sidebarExpanded, nodeId),
    [prefs.sidebarExpanded],
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

  // ── Node status for open-state bars ──
  const allChatIds = useMemo(
    () => projects.flatMap((p) => p.chatIds),
    [projects],
  );
  const nodeStatusesSelector = useCallback(
    (ns: Record<string, ChatNodeState>) => selectProjectNodeStatuses(allChatIds, ns),
    [allChatIds],
  );
  const nodeStatuses = useStructuralSelector(
    nodeStatusesSelector,
    (a, b) => {
      const ak = Object.keys(a);
      if (ak.length !== Object.keys(b).length) return false;
      for (const id of ak) if (a[id] !== b[id]) return false;
      return true;
    },
  );

  const getNodeOpenState = useCallback(
    (id: string): OpenState =>
      nodeOpenState(id, openPanes, focusedPane, nodeStatuses[id] ?? 'idle'),
    [openPanes, focusedPane, nodeStatuses],
  );

  const getSubtreeOpenState = useCallback(
    (rootId: string, edges: readonly ProjectEdge[]): OpenState =>
      subtreeOpenState(rootId, edges, isAlive, getNodeOpenState),
    [isAlive, getNodeOpenState],
  );

  // ── Navigation: clicking a tree/branch in Activity view ──
  const handleActivateTree = useCallback(
    (tree: Tree, project: Project) => {
      if (selection.size > 0) clearSelection();
      const rootNodeId = tree.rootNodeId;
      const crossesThread =
        project.id !== activeProjectId || tree.id !== project.activeTreeId;
      if (crossesThread) {
        openPaneInTree(project.id, tree.id, rootNodeId);
        if (project.id !== activeProjectId) selectProject(project.id);
        if (tree.id !== project.activeTreeId) activateTree(tree.id, project.id);
      } else {
        openPane(rootNodeId);
      }
      setFocusedNodeId(rootNodeId);
      onActivate?.();
    },
    [selection, clearSelection, activeProjectId, selectProject, activateTree, openPane, openPaneInTree, setFocusedNodeId, onActivate],
  );

  const handleSelectBranch = useCallback(
    (nodeId: string, event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        toggleSelection(nodeId);
        return;
      }
      if (selection.size > 0) clearSelection();
      // Find owning project/tree
      const owningProject = projects.find(
        (p) => !p.deletedAt && p.chatIds.includes(nodeId),
      );
      const owningTreeId = owningProject
        ? findTreeIdForNode(nodeId, owningProject)
        : null;
      if (owningProject && owningTreeId) {
        const crossesThread =
          owningProject.id !== activeProjectId ||
          owningTreeId !== owningProject.activeTreeId;
        if (crossesThread) {
          openPaneInTree(owningProject.id, owningTreeId, nodeId);
          if (owningProject.id !== activeProjectId) selectProject(owningProject.id);
          if (owningTreeId !== owningProject.activeTreeId) {
            activateTree(owningTreeId, owningProject.id);
          }
        } else {
          openPane(nodeId);
        }
      } else {
        openPane(nodeId);
      }
      setFocusedNodeId(nodeId);
      onActivate?.();
    },
    [projects, selection, clearSelection, toggleSelection, activeProjectId, selectProject, activateTree, openPane, openPaneInTree, setFocusedNodeId, onActivate],
  );

  const handleBranchContextMenu = useCallback(
    (_nodeId: string, event: React.MouseEvent) => {
      event.preventDefault();
      // Activity view doesn't have its own context menu for branches (yet)
    },
    [],
  );

  const isBranchSelected = useCallback(
    (nodeId: string) => selection.has(nodeId),
    [selection],
  );

  // ── Other live workspaces for the "Move to workspace" menu ──
  const moveTargetsFor = useCallback(
    (projectId: string) =>
      projects
        .filter((p) => p.id !== projectId && !p.deletedAt && !p.archivedAt)
        .map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );

  return (
    <div
      className="activity-view term-scrollbar"
      style={{
        flex: 1,
        overflowY: 'auto',
        paddingLeft: 'var(--sb-inset, 0px)',
        paddingRight: 'var(--sb-inset, 0px)',
        fontSize: 'var(--sb-fs, 13.5px)',
      }}
    >
      {BUCKET_ORDER.map((bucket) => {
        const items = bucketGroups.get(bucket);
        if (!items || items.length === 0) return null;
        return (
          <div key={bucket} className="activity-section">
            <div
              className="activity-time-label"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                color: 'var(--term-faint)',
                padding: 'var(--sb-row-py, 5px) 10px var(--sb-row-py, 4px) 6px',
                marginTop: 8,
              }}
            >
              {bucket === 'now' && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--term-ok, #5dd882)',
                    animation: 'pulse 2s ease-in-out infinite',
                    flexShrink: 0,
                  }}
                />
              )}
              {BUCKET_LABELS[bucket]}
            </div>
            {items.map((item) => (
              <ActivityTreeEntry
                key={item.tree.id}
                item={item}
                isAlive={isAlive}
                isThreadExpandedFn={isThreadExpandedFn}
                isBranchExpanded={isBranchExpandedCb}
                isBranchSelected={isBranchSelected}
                toggleThread={toggleThread}
                toggleBranch={toggleBranch}
                getNodeOpenState={getNodeOpenState}
                getSubtreeOpenState={getSubtreeOpenState}
                onActivateTree={handleActivateTree}
                onSelectBranch={handleSelectBranch}
                onBranchContextMenu={handleBranchContextMenu}
                moveTargets={moveTargetsFor(item.project.id)}
                activeProjectId={activeProjectId}
                focusedNodeId={focusedNodeId}
                archiveTree={archiveTree}
                unarchiveTree={unarchiveTree}
                pinTree={pinTree}
                unpinTree={unpinTree}
                renameTree={renameTree}
                deleteTree={deleteTree}
                moveTreeToWorkspace={moveTreeToWorkspace}
                treeSelection={treeSelection}
                clearTreeSelection={clearTreeSelection}
              />
            ))}
          </div>
        );
      })}
      {activityItems.length === 0 && (
        <div
          style={{
            padding: '40px 16px',
            textAlign: 'center',
            color: 'var(--term-muted)',
            fontSize: 12,
          }}
        >
          No activity yet
        </div>
      )}
    </div>
  );
}

// ── Per-tree entry: ThreadRow + workspace label + BranchRow children ────────

function ActivityTreeEntry({
  item,
  isAlive,
  isThreadExpandedFn,
  isBranchExpanded,
  isBranchSelected,
  toggleThread,
  toggleBranch,
  getNodeOpenState,
  getSubtreeOpenState,
  onActivateTree,
  onSelectBranch,
  onBranchContextMenu,
  moveTargets,
  activeProjectId,
  focusedNodeId,
  archiveTree,
  unarchiveTree,
  pinTree,
  unpinTree,
  renameTree,
  deleteTree,
  moveTreeToWorkspace,
  treeSelection,
  clearTreeSelection,
}: {
  item: ActivityTree;
  isAlive: (id: string) => boolean;
  isThreadExpandedFn: (treeId: string, ownerActiveTreeId: string | null) => boolean;
  isBranchExpanded: (nodeId: string) => boolean;
  isBranchSelected: (nodeId: string) => boolean;
  toggleThread: (treeId: string) => void;
  toggleBranch: (nodeId: string) => void;
  getNodeOpenState: (id: string) => OpenState;
  getSubtreeOpenState: (rootId: string, edges: readonly ProjectEdge[]) => OpenState;
  onActivateTree: (tree: Tree, project: Project) => void;
  onSelectBranch: (nodeId: string, event: React.MouseEvent) => void;
  onBranchContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  moveTargets: readonly { id: string; name: string }[];
  activeProjectId: string | null;
  focusedNodeId: string | null;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string, projectId?: string) => void;
  deleteTree: (treeId: string) => void;
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => void;
  treeSelection: ReadonlySet<string>;
  clearTreeSelection: () => void;
}) {
  const { tree, project } = item;
  const root = buildTree(tree.rootNodeId, project.edges, isAlive);
  const hasBranches = root.children.length > 0;
  const isActive = tree.id === project.activeTreeId && project.id === activeProjectId;
  // In Activity view, threads default to expanded to show their branches
  const threadOpen = isThreadExpandedFn(tree.id, project.activeTreeId);
  const threadOpenState = getSubtreeOpenState(tree.rootNodeId, project.edges);

  return (
    <div style={{ marginTop: 'var(--sb-ws-gap, 6px)' }}>
      <ThreadRow
        tree={tree}
        projectId={project.id}
        isActive={isActive}
        hasBranches={hasBranches}
        expanded={threadOpen}
        openState={threadOpenState}
        onActivate={(e?: React.MouseEvent) => {
          if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
          onActivateTree(tree, project);
          // Expand on activate if collapsed
          if (hasBranches && !threadOpen) {
            toggleThread(tree.id);
          } else if (hasBranches && threadOpen && isActive) {
            toggleThread(tree.id);
          }
        }}
        onToggleExpand={() => toggleThread(tree.id)}
        actions={{
          activateTree: (treeId) => {
            const t = project.trees.find((tt) => tt.id === treeId);
            if (t) onActivateTree(t, project);
          },
          archiveTree,
          unarchiveTree,
          pinTree,
          unpinTree,
          renameTree: (treeId, name) => renameTree(treeId, name, project.id),
          deleteTree,
          moveTreeToWorkspace: (treeId, targetProjectId) => {
            void moveTreeToWorkspace(treeId, targetProjectId);
          },
        }}
        moveTargets={moveTargets}
      />
      {/* Workspace name — shown below root, before branches */}
      <div
        style={{
          fontSize: 11,
          color: 'var(--term-faint)',
          fontFamily: 'var(--ui-font)',
          // Indent to align with the thread title text:
          // ThreadRow: borderLeft(2) + paddingLeft(8+inset) + chevron(12) + gap(5) = 27+inset
          // We match that alignment for the workspace subtitle
          padding: '0 calc(10px + var(--sb-inset, 0px)) 0 calc(27px + var(--sb-inset, 0px))',
          marginTop: -1,
          marginBottom: threadOpen && hasBranches ? 2 : 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
        }}
      >
        {project.name}
      </div>
      {/* Branches — same as Structure view */}
      {threadOpen && hasBranches && (
        <div style={{ marginTop: 1 }}>
          {root.children.map((child) => (
            <BranchRow
              key={child.nodeId}
              node={child}
              depth={1}
              expanded={isBranchExpanded(child.nodeId)}
              isFocused={(id) => id === focusedNodeId}
              isSelected={isBranchSelected}
              isExpanded={isBranchExpanded}
              onToggle={toggleBranch}
              onSelect={onSelectBranch}
              onContextMenu={onBranchContextMenu}
              openState={getNodeOpenState(child.nodeId)}
              getOpenState={getNodeOpenState}
            />
          ))}
        </div>
      )}
    </div>
  );
}
