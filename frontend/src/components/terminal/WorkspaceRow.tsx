import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Row } from './primitives';
import { usePrefs } from '../../state/prefs';
import WorkspaceIcon, { modeForPalette } from './WorkspaceIcon';
import { workspaceAccent } from './workspaceAccent';
import ThreadRow, { Chevron } from './ThreadRow';
import BranchRow from './BranchRow';
import ContextMenu, { type MenuSection } from '../ContextMenu';
import { buildTree } from '../../state/tree';
import {
  buildWorkspaceRowContextMenu,
  type ContextMenuSection,
} from '../../lib/workspaceRowContextMenu';
import type { Project, Tree, ProjectEdge, ChatNodeState } from '../../state/chatTypes';
import { useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { nodeOpenState, subtreeOpenState, workspaceHasUnread, treeHasUnread, type OpenState } from '../../state/sidebarSelectors';

const THREAD_PREVIEW_LIMIT = 5;

interface Actions {
  toggleWorkspace: (projectId: string) => void;
  toggleThread: (treeId: string) => void;
  setThreadExpanded: (treeId: string, expanded: boolean) => void;
  toggleBranch: (nodeId: string) => void;
  activateTree: (treeId: string) => void;
  /** `expanded` is bundled into the same prefs write as the project switch
   *  to avoid stale-closure races between snapshotBeforeSwitch (which pins
   *  the outgoing/incoming visual state) and a follow-up toggle. */
  selectProject: (projectId: string, expanded?: boolean) => void;
  createThread: () => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string) => void;
  deleteTree: (treeId: string) => void;
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => void;
  renameProject: (projectId: string, name: string) => void;
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  /** Plain click + modifier-aware click on a branch row. */
  selectBranch: (nodeId: string, event: React.MouseEvent) => void;
  /** Right-click on a branch row. */
  branchContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  /** Click on a thread row body — opens + focuses that thread's root node,
   *  with cross-thread/workspace routing equivalent to `selectBranch`. */
  selectThreadRoot: (tree: Tree, project: Project) => void;
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

export interface WorkspaceRowDndProps {
  draggable: true;
  isDragSource: boolean;
  isDropTarget: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

interface Props {
  project: Project;
  workspaceExpanded: boolean;
  activeProjectId: string | null;
  /** False when the user has navigated to Map/Digest/etc. — used to surface
   *  a subtle "you're on this workspace, but not in chat" marker. */
  chatViewActive?: boolean;
  activeTreeId: string | null;
  focusedNodeId: string | null;
  isThreadExpanded: (treeId: string) => boolean;
  isBranchExpanded: (nodeId: string) => boolean;
  isBranchSelected: (nodeId: string) => boolean;
  /** Whether the given branch is currently the target of an open context
   *  menu. Used to pin the hover kebab visible since branch menu state lives
   *  upstream in WorkspaceTree. */
  isBranchMenuTarget?: (nodeId: string) => boolean;
  isNodeAlive: (nodeId: string) => boolean;
  sortedTrees: Tree[];
  edges: readonly ProjectEdge[];
  actions: Actions;
  dnd?: WorkspaceRowDndProps;
  /** When true (filter mode), force-expand the workspace and show only unread threads. */
  forceExpand?: boolean;
}

export default function WorkspaceRow({
  project,
  workspaceExpanded,
  activeProjectId,
  chatViewActive = true,
  activeTreeId,
  focusedNodeId,
  isThreadExpanded,
  isBranchExpanded,
  isBranchSelected,
  isBranchMenuTarget,
  isNodeAlive,
  sortedTrees,
  edges,
  actions,
  dnd,
  forceExpand = false,
}: Props) {
  const { prefs } = usePrefs();
  const accent = workspaceAccent(project.id);
  // When chat view is hidden (Map/Digest/etc.), surface a subtle marker on the
  // active workspace row so the user knows which workspace context they're in.
  const isActiveWorkspaceAway = !chatViewActive && project.id === activeProjectId;
  // Trees whose root is soft-deleted live in Trash, not in the sidebar — they
  // come back here when restoreDeletion clears the flag.
  const visibleTrees = sortedTrees.filter((t) => isNodeAlive(t.rootNodeId));
  const liveTrees = visibleTrees.filter((t) => !t.archivedAt);
  const archivedTrees = visibleTrees.filter((t) => !!t.archivedAt);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  const beginRename = () => {
    setDraftName(project.name);
    setRenaming(true);
  };
  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== project.name) {
      actions.renameProject(project.id, trimmed);
    }
    setRenaming(false);
  };
  const cancelRename = () => {
    setDraftName(project.name);
    setRenaming(false);
  };

  const sections = menu
    ? toMenuSections(
        buildWorkspaceRowContextMenu({
          project,
          actions: {
            archiveProject: actions.archiveProject,
            unarchiveProject: actions.unarchiveProject,
            deleteProject: actions.deleteProject,
            beginInlineRename: () => beginRename(),
            openManageWorkspace: (projectId) => {
              window.dispatchEvent(
                new CustomEvent('michi:open-workspace-manage', { detail: { projectId } }),
              );
            },
          },
        }),
      )
    : [];

  const { projects, openPanes, focusedPane } = useChatProjects();
  // Other live (not archived, not in trash) workspaces this thread can move
  // to. Computed once per render; an empty list hides the section entirely.
  const moveTargets = React.useMemo(
    () =>
      projects
        .filter((p) => p.id !== project.id && !p.deletedAt && !p.archivedAt)
        .map((p) => ({ id: p.id, name: p.name })),
    [projects, project.id],
  );
  const nodeStatuses = useStructuralSelector(
    (ns) => {
      const result: Record<string, ChatNodeState['status']> = {};
      for (const [id, n] of Object.entries(ns)) result[id] = n.status;
      return result;
    },
    (a, b) => {
      const ak = Object.keys(a);
      if (ak.length !== Object.keys(b).length) return false;
      for (const id of ak) if (a[id] !== b[id]) return false;
      return true;
    },
  );
  const wsUnread = useStructuralSelector(
    (nodes) => workspaceHasUnread(project, nodes, focusedNodeId),
  );
  // When filter mode is on, compute which trees have unread so we can show only those.
  const unreadTreeIds = useStructuralSelector(
    (nodes) =>
      forceExpand
        ? new Set(liveTrees.filter((t) => treeHasUnread(t, edges, nodes, focusedNodeId)).map((t) => t.id))
        : null,
    (a, b) => {
      if (a === null && b === null) return true;
      if (a === null || b === null) return false;
      if (a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
      return true;
    },
  );
  // In filter mode, show only trees with unread nodes; otherwise apply the preview limit.
  const filteredLiveTrees = forceExpand && unreadTreeIds
    ? liveTrees.filter((t) => unreadTreeIds.has(t.id))
    : liveTrees;
  // The active tree must stay visible even when its recency rank falls past
  // the preview cap (opening a historical thread via search/palette does NOT
  // bump lastActiveAt) — append it below the preview slice so the sidebar
  // can reveal & scroll to it.
  const previewTrees = filteredLiveTrees.slice(0, THREAD_PREVIEW_LIMIT);
  const activeBeyondCap =
    activeTreeId !== null && !previewTrees.some((t) => t.id === activeTreeId)
      ? filteredLiveTrees.find((t) => t.id === activeTreeId)
      : undefined;
  const displayedLiveTrees = forceExpand
    ? filteredLiveTrees
    : showAllThreads
      ? filteredLiveTrees
      : activeBeyondCap
        ? [...previewTrees, activeBeyondCap]
        : previewTrees;

  const getNodeOpenState = useCallback(
    (id: string): OpenState =>
      nodeOpenState(id, openPanes, focusedPane, nodeStatuses[id] ?? 'idle'),
    [openPanes, focusedPane, nodeStatuses],
  );

  const getSubtreeOpenState = useCallback(
    (rootId: string): OpenState =>
      subtreeOpenState(rootId, edges, isNodeAlive, getNodeOpenState),
    [edges, isNodeAlive, getNodeOpenState],
  );

  // The workspace row paints a bar when collapsed and any live descendant is open.
  // Use liveTrees (not sortedTrees) so archived threads don't trigger the bar
  // indicator when the user can't see why it's lit.
  const workspaceOpenState: OpenState = !workspaceExpanded
    ? liveTrees.reduce<OpenState>((acc, tree) => {
        if (acc === 'streaming') return acc;
        const sub = getSubtreeOpenState(tree.rootNodeId);
        if (sub === 'streaming') return 'streaming';
        if (sub === 'idle') return 'idle';
        return acc;
      }, 'none')
    : 'none';

  return (
    <div
      data-testid={`workspace-row-${project.id}`}
      draggable={dnd?.draggable ?? false}
      onDragStart={dnd?.onDragStart}
      onDragOver={dnd?.onDragOver}
      onDragLeave={dnd?.onDragLeave}
      onDrop={dnd?.onDrop}
      onDragEnd={dnd?.onDragEnd}
      style={{
        position: 'relative',
        opacity: dnd?.isDragSource ? 0.5 : 1,
        marginTop: 6,
      }}
    >
      {dnd?.isDropTarget && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: 2,
            background: 'var(--term-accent)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
      <Row
        onClick={() => {
          if (renaming) return;
          // Unified expand rule for ws/thread-root/branch rows:
          //   - Collapsed → always expand (regardless of prior highlight).
          //   - Expanded + already highlighted → collapse.
          //   - Expanded + not highlighted → just highlight, keep open.
          const wasActive = project.id === activeProjectId;
          let nextExpanded: boolean | undefined;
          if (!workspaceExpanded) nextExpanded = true;
          else if (wasActive) nextExpanded = false;
          // (else: keep open — undefined leaves snapshot's pin intact)
          actions.selectProject(project.id, nextExpanded);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          // Lead-in math (keep in sync with WorkspaceIcon folder slot = 15px):
          //   border 2 + paddingLeft 4 + folder 15 + gap 6 = 27px text offset,
          //   which exactly matches the thread row below it
          //   (border 2 + paddingLeft 8 + chevron 12 + gap 5 = 27px), so the
          //   workspace name and its threads share one left edge. The folder
          //   glyph lands at x[6,21] — centered between the sidebar edge and
          //   the text.
          gap: 6,
          padding: '5px 10px 4px 4px',
          fontFamily: 'var(--ui-font)',
          background: menu ? 'var(--term-alt)' : undefined,
          borderLeft: isActiveWorkspaceAway
            ? `2px solid ${accent}`
            : '2px solid transparent',
        }}
      >
        <WorkspaceIcon
          project={project}
          mode={modeForPalette(prefs.terminalPalette)}
          active={project.id === activeProjectId}
        />
        {renaming ? (
          <input
            ref={renameRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={commitRename}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              background: 'var(--term-alt)',
              border: '1px solid var(--term-line)',
              outline: 'none',
              padding: '1px 4px',
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              // Idle weight is unified at 450 across all three tree levels
              // (workspace / thread / node) so the resting sidebar reads as one
              // consistent typographic plane; hierarchy is carried by the folder
              // icon + indentation, not by weight. Interaction states keep their
              // own emphasis (unread 900).
              fontWeight: wsUnread ? 900 : 450,
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
              WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
            }}
          >
            {project.name}
          </span>
        )}
        <button
          type="button"
          className="t-add-btn"
          aria-label="New chat in this workspace"
          title="New chat in this workspace"
          onClick={(e) => {
            e.stopPropagation();
            actions.selectProject(project.id);
            window.dispatchEvent(new CustomEvent('michi:goto-home'));
          }}
        >
          +
        </button>
        {workspaceOpenState !== 'none' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: 4,
              top: 5,
              bottom: 5,
              width: 2,
              borderRadius: 1,
              // Brand accent for both states; the streaming pulse + glow (below)
              // distinguish "live" from a static idle-open pane. `color` is set so
              // the glow's currentColor matches the bar instead of inheriting the
              // row's neutral text color.
              color: 'var(--term-accent)',
              background: 'var(--term-accent)',
              boxShadow:
                workspaceOpenState === 'streaming'
                  ? '0 0 6px 0 currentColor'
                  : undefined,
              animation:
                workspaceOpenState === 'streaming'
                  ? 'tpulse 1.4s ease-in-out infinite'
                  : undefined,
              pointerEvents: 'none',
            }}
          />
        )}
      </Row>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={sections}
          onClose={() => setMenu(null)}
        />
      )}

      {(workspaceExpanded || forceExpand) && (
        <div style={{ marginTop: 4, marginBottom: 4 }}>
          {filteredLiveTrees.length === 0 && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--term-muted)',
                padding: '4px 8px',
              }}
            >
              — no threads —
            </div>
          )}
          {displayedLiveTrees.map((tree) =>
            renderThread({
              moveTargets,
              tree,
              project,
              activeProjectId,
              activeTreeId,
              focusedNodeId,
              threadOpen: isThreadExpanded(tree.id),
              isBranchExpanded,
              isBranchSelected,
              isBranchMenuTarget,
              isNodeAlive,
              edges,
              actions,
              getNodeOpenState,
              getSubtreeOpenState,
            }),
          )}
          {!forceExpand && filteredLiveTrees.length > THREAD_PREVIEW_LIMIT && (
            <button
              type="button"
              className="t-row-hover"
              aria-expanded={showAllThreads}
              onClick={() => setShowAllThreads((v) => !v)}
              style={{
                width: '100%',
                display: 'block',
                padding: '5px 8px 5px 25px',
                background: 'transparent',
                border: 0,
                textAlign: 'left',
                color: 'var(--term-muted)',
                fontFamily: 'var(--ui-font)',
                fontSize: 12.5,
                cursor: 'pointer',
              }}
            >
              {showAllThreads ? 'Show less' : 'Show more'}
            </button>
          )}
          {archivedTrees.length > 0 && (
            <ArchivedSection
              archivedTrees={archivedTrees}
              project={project}
              activeProjectId={activeProjectId}
              activeTreeId={activeTreeId}
              focusedNodeId={focusedNodeId}
              isThreadExpanded={isThreadExpanded}
              isBranchExpanded={isBranchExpanded}
              isBranchSelected={isBranchSelected}
              isBranchMenuTarget={isBranchMenuTarget}
              isNodeAlive={isNodeAlive}
              edges={edges}
              actions={actions}
              getNodeOpenState={getNodeOpenState}
              getSubtreeOpenState={getSubtreeOpenState}
              moveTargets={moveTargets}
            />
          )}
        </div>
      )}
    </div>
  );
}

function renderThread(args: {
  tree: Tree;
  project: Project;
  activeProjectId: string | null;
  activeTreeId: string | null;
  focusedNodeId: string | null;
  threadOpen: boolean;
  isBranchExpanded: (nodeId: string) => boolean;
  isBranchSelected: (nodeId: string) => boolean;
  isBranchMenuTarget?: (nodeId: string) => boolean;
  isNodeAlive: (nodeId: string) => boolean;
  edges: readonly ProjectEdge[];
  actions: Actions;
  getNodeOpenState: (nodeId: string) => OpenState;
  getSubtreeOpenState: (rootId: string) => OpenState;
  moveTargets?: readonly { id: string; name: string }[];
}) {
  const {
    tree,
    project,
    activeProjectId,
    activeTreeId,
    focusedNodeId,
    threadOpen,
    isBranchExpanded,
    isBranchSelected,
    isBranchMenuTarget,
    isNodeAlive,
    edges,
    actions,
    getNodeOpenState,
    getSubtreeOpenState,
    moveTargets,
  } = args;
  const isActive = tree.id === activeTreeId && project.id === activeProjectId;
  const root = buildTree(tree.rootNodeId, edges, isNodeAlive);
  const hasBranches = root.children.length > 0;
  const threadOpenStateValue = getSubtreeOpenState(tree.rootNodeId);
  return (
    <React.Fragment key={tree.id}>
      <ThreadRow
        tree={tree}
        projectId={project.id}
        isActive={isActive}
        hasBranches={hasBranches}
        expanded={threadOpen}
        openState={threadOpenStateValue}
        onActivate={() => {
          // Always route through selectThreadRoot so the root node is opened
          // and focused — even when this thread is already active. Without
          // this, after the sidebar focus has been moved to a branch via
          // selectBranch, clicking the thread row would only toggle expand
          // and never restore root to the pane stack.
          actions.selectThreadRoot(tree, project);
          // Unified expand rule (see WorkspaceRow):
          //   collapsed → expand; expanded + already active → collapse;
          //   expanded + inactive → keep open (just activate).
          if (!hasBranches) return;
          if (!threadOpen) {
            actions.toggleThread(tree.id);
          } else if (isActive) {
            actions.toggleThread(tree.id);
          }
        }}
        onToggleExpand={() => actions.toggleThread(tree.id)}
        actions={{
          activateTree: actions.activateTree,
          archiveTree: actions.archiveTree,
          unarchiveTree: actions.unarchiveTree,
          renameTree: actions.renameTree,
          deleteTree: actions.deleteTree,
          moveTreeToWorkspace: actions.moveTreeToWorkspace,
        }}
        moveTargets={moveTargets}
      />
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
              isMenuTarget={isBranchMenuTarget}
              onToggle={actions.toggleBranch}
              onSelect={actions.selectBranch}
              onContextMenu={actions.branchContextMenu}
              openState={getNodeOpenState(child.nodeId)}
              getOpenState={getNodeOpenState}
            />
          ))}
        </div>
      )}
    </React.Fragment>
  );
}

function ArchivedSection({
  archivedTrees,
  project,
  activeProjectId,
  activeTreeId,
  focusedNodeId,
  isThreadExpanded,
  isBranchExpanded,
  isBranchSelected,
  isBranchMenuTarget,
  isNodeAlive,
  edges,
  actions,
  getNodeOpenState,
  getSubtreeOpenState,
  moveTargets,
}: {
  archivedTrees: Tree[];
  project: Project;
  activeProjectId: string | null;
  activeTreeId: string | null;
  focusedNodeId: string | null;
  isThreadExpanded: (treeId: string) => boolean;
  isBranchExpanded: (nodeId: string) => boolean;
  isBranchSelected: (nodeId: string) => boolean;
  /** Whether the given branch is currently the target of an open context
   *  menu. Used to pin the hover kebab visible since branch menu state lives
   *  upstream in WorkspaceTree. */
  isBranchMenuTarget?: (nodeId: string) => boolean;
  isNodeAlive: (nodeId: string) => boolean;
  edges: readonly ProjectEdge[];
  actions: Actions;
  getNodeOpenState: (nodeId: string) => OpenState;
  getSubtreeOpenState: (rootId: string) => OpenState;
  moveTargets?: readonly { id: string; name: string }[];
}) {
  const [open, setOpen] = React.useState(false);
  // Pop the section open when the active tree lives inside it (e.g. a global
  // search result landed on an archived thread) — its row only exists in the
  // DOM while the section is open, so the sidebar reveal can't reach it
  // otherwise. Keyed on activeTreeId so a manual collapse afterwards sticks.
  const activeIsArchived = activeTreeId !== null && archivedTrees.some((t) => t.id === activeTreeId);
  React.useEffect(() => {
    if (activeIsArchived) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTreeId]);
  return (
    <div>
      <Row
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          fontSize: 10.5,
          color: 'var(--term-muted)',
          letterSpacing: '.06em',
          fontFamily: 'var(--ui-font)',
        }}
      >
        <Chevron expanded={open} visible={true} />
        archived ({archivedTrees.length})
      </Row>
      {open &&
        archivedTrees.map((tree) =>
          renderThread({
            tree,
            project,
            activeProjectId,
            activeTreeId,
            focusedNodeId,
            threadOpen: isThreadExpanded(tree.id),
            isBranchExpanded,
            isBranchSelected,
            isBranchMenuTarget,
            isNodeAlive,
            edges,
            actions,
            getNodeOpenState,
            getSubtreeOpenState,
            moveTargets,
          }),
        )}
    </div>
  );
}
