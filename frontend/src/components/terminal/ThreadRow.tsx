import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatNode, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { Row, RowKebab } from './primitives';
import ContextMenu from '../ContextMenu';
import MoveThreadDialog from '../MoveThreadDialog';
import { buildThreadRowContextMenu } from '../../lib/threadRowContextMenu';
import type { MenuSection } from '../ContextMenu';
import type { ContextMenuSection } from '../../lib/threadRowContextMenu';
import type { ProjectEdge, Tree } from '../../state/chatTypes';
import type { OpenState } from '../../state/sidebarSelectors';
import { treeHasUnread } from '../../state/sidebarSelectors';

const EMPTY_EDGES: readonly ProjectEdge[] = [];

function toMenuSections(sections: ContextMenuSection[]): MenuSection[] {
  return sections.map((s, si) => ({
    label: s.label,
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

interface Actions {
  activateTree: (treeId: string) => void;
  archiveTree: (treeId: string) => void;
  unarchiveTree: (treeId: string) => void;
  pinTree: (treeId: string) => void;
  unpinTree: (treeId: string) => void;
  renameTree: (treeId: string, name: string) => void;
  deleteTree: (treeId: string) => void;
  /** Optional — wire only when there are other live workspaces to move to. */
  moveTreeToWorkspace?: (treeId: string, targetProjectId: string) => void;
}

export interface MoveTargetWorkspace {
  id: string;
  name: string;
}

interface Props {
  tree: Tree;
  projectId: string;
  isActive: boolean;
  hasBranches: boolean;
  /** Whether the thread's branches are currently shown. */
  expanded: boolean;
  /** Click on the row body — activates the thread (does not toggle).
   *  Receives the click event so the parent can inspect modifiers. */
  onActivate: (e?: React.MouseEvent) => void;
  /** Click on the chevron — toggles expand (does not activate). */
  onToggleExpand: () => void;
  actions: Actions;
  /** Subtree open-state. The bar is painted only when the row is collapsed. */
  openState?: OpenState;
  /** Other live workspaces this thread can be moved to. When empty/omitted,
   *  the "Move to workspace" section is hidden in the context menu. */
  moveTargets?: readonly MoveTargetWorkspace[];
}

export default function ThreadRow({
  tree,
  projectId,
  isActive,
  hasBranches,
  expanded,
  onActivate,
  onToggleExpand,
  actions,
  openState = 'none',
  moveTargets,
}: Props) {
  const { treeSelection, focusedNodeId, projects } = useChatProjects();
  const { prefs } = usePrefs();
  const selected = treeSelection.has(tree.id);
  const n = useChatNode(tree.rootNodeId);
  const projectEdges = projects.find((p) => p.id === projectId)?.edges ?? EMPTY_EDGES;
  const rootNodeId = tree.rootNodeId;
  const unreadSelector = useCallback(
    (nodes: Parameters<typeof treeHasUnread>[2]) =>
      treeHasUnread({ rootNodeId }, projectEdges, nodes, focusedNodeId),
    [rootNodeId, projectEdges, focusedNodeId],
  );
  const unread = useStructuralSelector(unreadSelector);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const renameBaseRef = useRef('');
  const renameRef = useRef<HTMLInputElement>(null);
  const suppressNextBlurCommitRef = useRef(false);
  const label = tree.name || n?.title || 'Untitled';

  useEffect(() => {
    if (!renaming) return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [renaming]);

  const beginRename = () => {
    suppressNextBlurCommitRef.current = false;
    renameBaseRef.current = label;
    setDraftName(label);
    setRenaming(true);
  };

  const commitRename = () => {
    if (suppressNextBlurCommitRef.current) {
      suppressNextBlurCommitRef.current = false;
      return;
    }
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== renameBaseRef.current) {
      actions.renameTree(tree.id, trimmed);
    }
    setRenaming(false);
  };

  const cancelRename = () => {
    suppressNextBlurCommitRef.current = true;
    setDraftName(renameBaseRef.current);
    setRenaming(false);
  };

  const exportTree = () =>
    window.dispatchEvent(
      new CustomEvent('michi:toggle-export-panel', { detail: { projectId, treeId: tree.id } }),
    );

  const sections = menu
    ? toMenuSections(
        buildThreadRowContextMenu({
          treeId: tree.id,
          tree,
          moveTargets,
          actions: {
            activateTree: actions.activateTree,
            archiveTree: actions.archiveTree,
            unarchiveTree: actions.unarchiveTree,
            pinTree: actions.pinTree,
            unpinTree: actions.unpinTree,
            renameTree: actions.renameTree,
            deleteTree: actions.deleteTree,
            exportTree,
            beginInlineRename: beginRename,
            moveToWorkspace: actions.moveTreeToWorkspace
              ? (targetProjectId: string) =>
                  actions.moveTreeToWorkspace!(tree.id, targetProjectId)
              : undefined,
            openMoveDialog: actions.moveTreeToWorkspace
              ? () => setMoveOpen(true)
              : undefined,
          },
        }),
      )
    : [];

  return (
    <>
      <Row
        data-sidebar-row={tree.rootNodeId}
        active={isActive || selected}
        onClick={(e) => {
          if (renaming) return;
          onActivate(e);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: 'var(--sb-row-py, 4px) 10px var(--sb-row-py, 4px) 8px',
          background: selected
            ? 'var(--term-select-f)'
            : isActive ? 'var(--term-alt)'
            : menu ? 'var(--term-alt)'
            : 'transparent',
          borderLeft: selected
            ? '2px solid var(--term-select)'
            : isActive ? '2px solid var(--term-accent)'
            : '2px solid transparent',
          color: isActive || selected || menu ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: unread ? 900 : (isActive || selected ? 600 : 450),
          fontSize: 'var(--sb-fs, 13.5px)',
          fontFamily: 'var(--ui-font)',
          position: 'relative',
        }}
      >
        <Chevron
          expanded={expanded}
          visible={hasBranches}
          onClick={(e) => {
            e.stopPropagation();
            if (hasBranches) onToggleExpand();
          }}
        />
        {tree.pinnedAt && (
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
        {renaming ? (
          <input
            ref={renameRef}
            aria-label="Thread name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
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
              background: 'var(--term-surface)',
              border: '1px solid var(--term-line)',
              outline: 'none',
              padding: '1px 4px',
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
              WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
            }}
          >
            {label}
          </span>
        )}
        {prefs.showSidebarTimestamps && (
          <span style={{ color: 'var(--term-faint)', fontSize: 'var(--sb-ts-fs, 11px)', marginRight: 2 }}>
            {formatRelative(tree.lastActiveAt)}
          </span>
        )}
        {selected && (
          <span style={{ color: 'var(--term-select)', fontSize: 11, fontWeight: 700 }}>
            ✓
          </span>
        )}
        <RowKebab
          open={!!menu}
          onOpen={(p) => setMenu({ x: p.x, y: p.y })}
          ariaLabel={`Actions for ${label}`}
        />
        {(openState === 'streaming' || (!expanded && openState === 'idle')) && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              right: 6,
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
                openState === 'streaming'
                  ? '0 0 6px 0 currentColor'
                  : undefined,
              animation:
                openState === 'streaming'
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
      <MoveThreadDialog
        open={moveOpen}
        threadLabel={label}
        targets={moveTargets ?? []}
        onClose={() => setMoveOpen(false)}
        onPick={(targetProjectId) => {
          actions.moveTreeToWorkspace?.(tree.id, targetProjectId);
        }}
      />
    </>
  );
}

/** Single-style chevron used across sidebar tree rows. Always gray, rotates
 *  90° when expanded. `visible=false` keeps the box but hides the glyph so
 *  rows align. */
export function Chevron({
  expanded,
  visible,
  onClick,
}: {
  expanded: boolean;
  visible: boolean;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        width: 12,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--ui-font)',
        fontSize: 11,
        color: visible ? 'var(--term-muted)' : 'transparent',
        cursor: visible && onClick ? 'pointer' : 'default',
        userSelect: 'none',
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transformOrigin: 'center',
        transition: 'transform 120ms var(--t-ease, ease-out)',
      }}
    >
      ›
    </span>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}
