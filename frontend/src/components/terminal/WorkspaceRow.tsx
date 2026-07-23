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
import {
  nodeOpenState,
  selectProjectNodeStatuses,
  subtreeOpenState,
  workspaceHasUnread,
  treeHasUnread,
  type OpenState,
} from '../../state/sidebarSelectors';

const THREAD_PREVIEW_LIMIT = 5;
const THREAD_PAGE_SIZE = 10;

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
  /** Toggle expand/collapse in one click regardless of active state. */
  toggleWorkspaceExpand: (projectId: string) => void;
  createThread: () => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string) => void;
  deleteTree: (treeId: string) => void;
  moveTreeToWorkspace: (treeId: string, targetProjectId: string) => void;
  renameProject: (projectId: string, name: string) => void;
  archiveProject: (projectId: string) => void;
  unarchiveProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  /** Plain click + modifier-aware click on a branch row. */
  selectBranch: (nodeId: string, event: React.MouseEvent) => void;
  /** Right-click on a branch row. */
  branchContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  /** Click on a thread row body — opens + focuses that thread's root node,
   *  with cross-thread/workspace routing equivalent to `selectBranch`. */
  selectThreadRoot: (tree: Tree, project: Project) => void;
  /** Modifier-aware click on a thread row — handles ⌘/⇧ multi-selection. */
  selectThread: (treeId: string, project: Project, event: React.MouseEvent) => void;
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
  /** The nodeId currently in inline-rename mode (or null). */
  renamingNodeId?: string | null;
  /** Commit a node rename. */
  onRenameNode?: (nodeId: string, title: string) => void;
  /** Clear the renaming state. */
  onRenameEnd?: () => void;
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
  renamingNodeId,
  onRenameNode,
  onRenameEnd,
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
  const [threadVisibleLimit, setThreadVisibleLimit] = useState(THREAD_PREVIEW_LIMIT);

  // Reset visible limit when workspace is collapsed — re-opening starts fresh at 5
  useEffect(() => {
    if (!workspaceExpanded) setThreadVisibleLimit(THREAD_PREVIEW_LIMIT);
  }, [workspaceExpanded]);

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
            pinProject: actions.pinProject,
            unpinProject: actions.unpinProject,
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
  const nodeStatusesSelector = useCallback(
    (nodes: Record<string, ChatNodeState>) => selectProjectNodeStatuses(project.chatIds, nodes),
    [project.chatIds],
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
  // Pinned trees always visible — preview limit applies only to unpinned.
  const pinnedTrees = filteredLiveTrees.filter((t) => !!t.pinnedAt);
  const unpinnedTrees = filteredLiveTrees.filter((t) => !t.pinnedAt);
  // The active tree must stay visible even when its recency rank falls past
  // the visible limit (opening a historical thread via search/palette does NOT
  // bump lastActiveAt) — append it below the visible slice so the sidebar
  // can reveal & scroll to it.
  const visibleUnpinned = unpinnedTrees.slice(0, threadVisibleLimit);
  const activeBeyondCap =
    activeTreeId !== null
    && !pinnedTrees.some((t) => t.id === activeTreeId)
    && !visibleUnpinned.some((t) => t.id === activeTreeId)
      ? unpinnedTrees.find((t) => t.id === activeTreeId)
      : undefined;
  const displayedLiveTrees = forceExpand
    ? filteredLiveTrees
    : (() => {
        const sliced = [...pinnedTrees, ...visibleUnpinned];
        if (activeBeyondCap && !sliced.some((t) => t.id === activeBeyondCap.id)) {
          sliced.push(activeBeyondCap);
        }
        return sliced;
      })();

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
        marginTop: 'var(--sb-ws-gap, 6px)',
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
          actions.toggleWorkspaceExpand(project.id);
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
          // +--sb-inset on both sides indents the folder glyph + name; the row
          // box stays full-bleed (negative margin cancels the tree container
          // inset) so the isActiveWorkspaceAway borderLeft hugs the true edge.
          padding: 'var(--sb-row-py, 5px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(4px + var(--sb-inset, 0px))',
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
          <>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 'var(--sb-fs, 13.5px)',
                  fontWeight: wsUnread ? 900 : 450,
                  color: 'var(--term-fg)',
                  fontFamily: 'var(--ui-font)',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {project.name}
              </span>
              {project.pinnedAt && (
                <svg
                  aria-label="pinned"
                  width="9"
                  height="9"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                  style={{ color: 'var(--term-pin, #c48300)', flexShrink: 0 }}
                >
                  <path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3 4.1 13.3 5 9 1.7 6l4.4-.5L8 1.5z" />
                </svg>
              )}
              <span
                className="ws-hover-chevron"
                aria-hidden
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--term-muted)',
                  flexShrink: 0,
                  transition: 'transform 120ms ease-out',
                  transform: workspaceExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  ...(menu ? { opacity: 1, pointerEvents: 'auto' as const } : {}),
                }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </span>
            </span>
            <span className="ws-hover-actions" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0, ...(menu ? { opacity: 1, pointerEvents: 'auto' as const } : {}) }}>
              <button
                type="button"
                className="ws-action-btn"
                aria-label="Workspace options"
                title="Workspace options"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.bottom + 4 });
                }}
              >
                ⋯
              </button>
              <button
                type="button"
                className="ws-action-btn"
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
            </span>
          </>
        )}
        {workspaceOpenState !== 'none' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: 2,
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
              renamingNodeId,
              onRenameNode,
              onRenameEnd,
            }),
          )}
          {!forceExpand && unpinnedTrees.length > threadVisibleLimit && (
            <button
              type="button"
              className="sb-flush show-more-toggle"
              aria-expanded={threadVisibleLimit > THREAD_PREVIEW_LIMIT}
              onClick={() => setThreadVisibleLimit((v) => v + THREAD_PAGE_SIZE)}
              style={{
                width: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '5px 8px 5px 25px',
                background: 'transparent',
                border: 0,
                textAlign: 'left',
                color: 'var(--term-faint)',
                fontFamily: 'var(--ui-font)',
                fontSize: 11.5,
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
  renamingNodeId?: string | null;
  onRenameNode?: (nodeId: string, title: string) => void;
  onRenameEnd?: () => void;
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
    renamingNodeId,
    onRenameNode,
    onRenameEnd,
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
        onActivate={(e?: React.MouseEvent) => {
          // ⌘/⇧+click are pure selection ops — don't activate or toggle.
          if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
            actions.selectThread(tree.id, project, e);
            return;
          }
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
          pinTree: actions.pinTree,
          unpinTree: actions.unpinTree,
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
              renamingNodeId={renamingNodeId}
              onRenameNode={onRenameNode}
              onRenameEnd={onRenameEnd}
            />
          ))}
        </div>
      )}
    </React.Fragment>
  );
}
