import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatNode, useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
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
import { rowGeom, rowPadding, caretKebabClearance } from './sidebarRowStyle';

const EMPTY_EDGES: readonly ProjectEdge[] = [];

/** Card-mode row fills. Deliberately NOT the solid `--term-alt` /
 *  `--term-select-f` tokens: the sidebar is translucent (CSS glass, or the
 *  native macOS vibrancy material under Electron), and painting a light colour
 *  on top of it is ADDITIVE — the row ends up more opaque than its neighbours
 *  and visibly loses the frost. These resolve to low-alpha foreground overlays
 *  that tint what shows through instead; see the `--sb-card-*` block in
 *  index.css, which also dials them down under native vibrancy.
 *  Exported so BranchRow paints selection identically. */
export const CARD_FILL = 'var(--sb-card-fill)';
export const CARD_FILL_SELECT = 'var(--sb-card-fill-select)';

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
  /** Extra left indent in px, folded into the row's own paddingLeft so the box
   *  (and its edge indicators) stay where they belong. Structure view passes a
   *  step so a workspace's threads sit in from the workspace name. */
  indent?: number;
  /** Workspace name shown as a second line INSIDE the row, card modes only.
   *  Activity view passes it (its threads span workspaces); Structure view
   *  omits it because the workspace group header already says it. */
  subtitle?: string;
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
  indent = 0,
  subtitle,
}: Props) {
  const { treeSelection, focusedNodeId, projects } = useChatProjects();
  const { clearTreeSelection } = useChatActions();
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
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);
  // Same rule in every mode: the rail is a SUMMARY for a collapsed subtree, so
  // it's suppressed once the row is expanded and each branch speaks for itself.
  const showIdleMark = !expanded && openState === 'idle';

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
          treeSelection,
          clearTreeSelection,
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
          // Flex in both modes. Card modes put the two text lines in a column
          // child and hang the caret off the Row itself, so the caret (and the
          // absolutely-positioned kebab) centre across BOTH lines instead of
          // riding the first one.
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          // Classic: horizontal padding folds in --sb-inset so the label indents
          // from the sidebar edge while the row box stays full-bleed (its negative
          // margin cancels the tree container's inset padding) — keeping the
          // borderLeft selection indicator and the streaming bar flush to the
          // true edge. Card modes take their padding from rowGeom instead, which
          // resolves the title onto a fixed absolute spine.
          ...(geom.isCard
            ? {
                paddingTop: 'var(--sb-row-py, 4px)',
                paddingBottom: 'calc(var(--sb-row-py, 4px) + 1px)',
                paddingLeft: rowPadding(geom, indent).paddingLeft,
                paddingRight: rowPadding(geom, indent).paddingRight,
              }
            : {
                padding: 'var(--sb-row-py, 4px) calc(10px + var(--sb-inset, 0px)) var(--sb-row-py, 4px) calc(8px + var(--sb-inset, 0px))',
              }),
          // Card modes keep the fill PARTIALLY TRANSPARENT. A solid --term-alt
          // punches an opaque hole through the sidebar's glass / vibrancy
          // material, so the selected row stops frosting and reads as a pasted-on
          // block. color-mix against `transparent` keeps the blur underneath.
          background: selected
            ? (geom.isCard ? CARD_FILL_SELECT : 'var(--term-select-f)')
            : (isActive || menu)
              ? (geom.isCard ? CARD_FILL : 'var(--term-alt)')
              : 'transparent',
          // Card modes carry selection with the fill alone — no edge bar.
          ...(geom.isCard
            ? {}
            : {
                borderLeft: selected
                  ? '2px solid var(--term-select)'
                  : isActive ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
              }),
          // Weight + color ladder is shared with classic: quiet mid/450 at rest,
          // fg/600 when focused, 900 when unread. Flattening it to one weight
          // read as uniformly too-black.
          color: isActive || selected || menu ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: unread ? 900 : (isActive || selected ? 600 : 450),
          fontSize: 'var(--sb-fs, 13.5px)',
          fontFamily: 'var(--ui-font)',
          position: 'relative',
        }}
      >
        {/* Text column (card modes) / transparent passthrough (classic). */}
        <div style={geom.isCard ? { flex: 1, minWidth: 0 } : { display: 'contents' }}>
        <div
          style={
            geom.isCard
              ? { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
              : { display: 'contents' }
          }
        >
        {geom.chevronLeading && (
          <Chevron
            expanded={expanded}
            visible={hasBranches}
            onClick={(e) => {
              e.stopPropagation();
              if (hasBranches) onToggleExpand();
            }}
          />
        )}
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
              // Card modes only — see BranchRow. Classic keeps its original box.
              ...(geom.isCard ? { minWidth: 0 } : {}),
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 28 : 14}px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 28 : 14}px), transparent)`,
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
        </div>
        {geom.isCard && geom.subtitleInRow && subtitle && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 2,
              fontSize: 'var(--sb-ts-fs, 11.5px)',
              color: 'var(--term-faint)',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            <SubtitleFolder />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                maskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)',
                WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 28px), transparent)',
              }}
            >
              {subtitle}
            </span>
          </div>
        )}
        </div>
        {/* Card modes move the expand affordance to the row end. With no branch
            count shown, this caret is the ONLY hint that a thread has branches,
            so it stays visible rather than appearing on hover.

            It sits OUTSIDE the text column — a sibling of it under the Row's
            `align-items: center` — so on a two-line card it centres across both
            lines, matching the absolutely-positioned kebab. Inside the first
            line it was centred on that line alone and read as misaligned.

            The right margin clears the kebab — see caretKebabClearance, which
            derives it per mode from that mode's own right padding. */}
        {geom.isCard && hasBranches && (
          <span
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            style={{
              flexShrink: 0,
              width: 9,
              marginRight: caretKebabClearance(geom),
              textAlign: 'center',
              fontSize: 10,
              color: 'var(--term-muted)',
              cursor: 'pointer',
            }}
          >
            {expanded ? '⌄' : '›'}
          </span>
        )}
        <RowKebab
          open={!!menu}
          onOpen={(p) => setMenu({ x: p.x, y: p.y })}
          ariaLabel={`Actions for ${label}`}
        />
        {(openState === 'streaming' || showIdleMark) && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              // Right edge in every mode. Card modes briefly had this on the
              // left as an inset strip; it read as a stray marker rather than
              // the familiar open-pane rail.
              right: geom.isCard ? 3 : 2,
              top: 5,
              bottom: 5,
              width: 2,
              borderRadius: 1,
              // Classic paints both states in the brand accent and leans on the
              // pulse + glow to tell "live" from "merely open". Card modes give
              // idle a neutral rail so accent in the sidebar always means
              // something is actually running.
              color: 'var(--term-accent)',
              background:
                openState === 'streaming'
                  ? 'var(--term-accent)'
                  : (geom.isCard ? 'var(--term-line-s)' : 'var(--term-accent)'),
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

/** Small folder glyph that anchors the workspace-name subtitle in card modes,
 *  so the second line reads as metadata rather than another list item. */
export function SubtitleFolder() {
  return (
    <svg
      aria-hidden
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      style={{ flexShrink: 0, opacity: 0.8 }}
    >
      <path d="M1.8 4.2h4l1.4 1.6h7v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V4.2z" />
    </svg>
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
