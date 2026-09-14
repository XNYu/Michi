import React, { useEffect, useRef, useState } from 'react';
import { useChatNode, useChatProjects } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { Row, RowKebab } from './primitives';
import { Chevron, CARD_FILL, CARD_FILL_SELECT, PinMark } from './ThreadRow';
import { rowGeom, rowPadding, caretKebabClearance } from './sidebarRowStyle';
import type { TreeNode } from '../../state/tree';
import { isNodeUnread, type OpenState } from '../../state/sidebarSelectors';
import { relativeTime } from '../../lib/relativeTime';
import { useNewPanePulse } from './useNewPanePulse';

interface Props {
  /** This branch node and its descendants. */
  node: TreeNode;
  /** 1 = direct child of a thread. 2/3+ for deeper levels. */
  depth: number;
  /** Whether this branch is currently expanded in the UI. */
  expanded: boolean;
  /** Per-node lookup: is this node the focused/open node in the dashboard? */
  isFocused: (nodeId: string) => boolean;
  /** Per-node lookup: is this node in the current multi-selection? */
  isSelected: (nodeId: string) => boolean;
  /** Resolves whether a deeper branch is expanded (called per child). */
  isExpanded: (nodeId: string) => boolean;
  /** Per-node lookup: is this node the current target of the open context
   *  menu? Used to pin the hover kebab visible while the parent-rendered
   *  menu is showing, since branch menu state lives upstream. */
  isMenuTarget?: (nodeId: string) => boolean;
  /** Click on chevron — toggles `expanded`. No-op when leaf. */
  onToggle: (nodeId: string) => void;
  /** Click on row body — `event` lets the handler branch on ⌘ / ⇧ modifiers. */
  onSelect: (nodeId: string, event: React.MouseEvent) => void;
  /** Right-click — open context menu at cursor. */
  onContextMenu: (nodeId: string, event: React.MouseEvent) => void;
  /** The current row's openState, already resolved by the caller. */
  openState: OpenState;
  /** Resolves openState for any descendant (called per child during recursion). */
  getOpenState: (nodeId: string) => OpenState;
  /** The nodeId currently in inline-rename mode (or null). */
  renamingNodeId?: string | null;
  /** Commit a node rename. */
  onRenameNode?: (nodeId: string, title: string) => void;
  /** Clear the renaming state. */
  onRenameEnd?: () => void;
}

export default function BranchRow({
  node,
  depth,
  expanded,
  isFocused,
  isSelected,
  isExpanded,
  isMenuTarget,
  onToggle,
  onSelect,
  onContextMenu,
  openState,
  getOpenState,
  renamingNodeId,
  onRenameNode,
  onRenameEnd,
}: Props) {
  const n = useChatNode(node.nodeId);
  const { prefs } = usePrefs();
  const newPanePulse = useNewPanePulse(node.nodeId);
  const hasChildren = node.children.length > 0;
  const title =
    n?.title ||
    n?.messages.find((m) => m.role === 'user')?.text.slice(0, 40) ||
    'Untitled';
  const nodeUpdatedAt = n?.lastAssistantAt ?? n?.messages[n.messages.length - 1]?.createdAt ?? 0;
  const focused = isFocused(node.nodeId);
  const selected = isSelected(node.nodeId);
  const menuOpen = !!isMenuTarget?.(node.nodeId);
  const { focusedNodeId } = useChatProjects();
  const unread = !!n && isNodeUnread(n, focusedNodeId);
  const geom = rowGeom(prefs.sidebarRowStyle, prefs.sidebarInset);

  const renaming = renamingNodeId === node.nodeId;
  const [draftName, setDraftName] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const suppressBlurRef = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    setDraftName(title);
    // Small delay so the input is mounted before focus
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [renaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitRename = () => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== title) {
      onRenameNode?.(node.nodeId, trimmed);
    }
    onRenameEnd?.();
  };

  const cancelRename = () => {
    suppressBlurRef.current = true;
    setDraftName(title);
    onRenameEnd?.();
  };

  const openMenuAt = (clientX: number, clientY: number) => {
    // Reuse the upstream branch context menu handler. It only reads
    // clientX/Y + preventDefault, so a synthetic event-like is enough.
    onContextMenu(
      node.nodeId,
      { preventDefault: () => {}, clientX, clientY } as unknown as React.MouseEvent,
    );
  };

  return (
    <>
      <Row
        data-sidebar-row={node.nodeId}
        active={focused || selected}
        onClick={(e) => {
          if (renaming) return;
          // Capture focus state BEFORE selecting so the toggle decision
          // reflects the highlight state at click time, not after.
          const wasFocused = focused;
          onSelect(node.nodeId, e);
          // ⌘/⇧+click are pure selection ops — don't toggle the branch open.
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          if (!hasChildren) return;
          // Unified expand rule (see WorkspaceRow):
          //   collapsed → expand; expanded + already highlighted → collapse;
          //   expanded + not highlighted → keep open (just highlight).
          if (!expanded) {
            onToggle(node.nodeId);
          } else if (wasFocused) {
            onToggle(node.nodeId);
          }
        }}
        onContextMenu={(e) => onContextMenu(node.nodeId, e)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 'var(--sb-row-py, 4px)',
          // Classic: +--sb-inset on both sides indents the text while the
          // full-bleed row box (negative margin cancels the container inset)
          // keeps the borderLeft indicator + streaming bar flush to the sidebar
          // edge. See index.css.
          //
          // Card modes reuse rowPadding with a per-depth indent, which means the
          // row BOX is identical to a thread row's — only the text steps in. A
          // selected branch therefore fills the full row width instead of
          // showing an inset notch.
          paddingRight: geom.isCard
            ? rowPadding(geom).paddingRight
            : 'calc(10px + var(--sb-inset, 0px))',
          paddingBottom: 'var(--sb-row-py, 4px)',
          paddingLeft: geom.isCard
            ? rowPadding(geom, depth * geom.indentStep).paddingLeft
            : `calc(${8 + depth * 10}px + var(--sb-inset, 0px))`,
          // Translucent in card modes so a selected branch keeps the sidebar's
          // glass — see CARD_FILL in ThreadRow.
          background: selected
            ? (geom.isCard ? CARD_FILL_SELECT : 'var(--term-select-f)')
            : (focused || menuOpen)
              ? (geom.isCard ? CARD_FILL : 'var(--term-alt)')
              : undefined,
          ...(geom.isCard
            ? { borderRadius: 'var(--sb-radius, 0px)' }
            : {
                borderLeft: selected
                  ? '2px solid var(--term-select)'
                  : focused ? '2px solid var(--term-accent)'
                  : '2px solid transparent',
              }),
          // Same weight/color ladder as classic — one flat weight read too black.
          color: focused || selected || menuOpen ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: unread ? 900 : (focused || selected ? 600 : 450),
          fontSize: 'var(--sb-fs, 13.5px)',
          fontFamily: 'var(--ui-font)',
        }}
      >
        {geom.chevronLeading && (
          <Chevron
            expanded={expanded}
            visible={hasChildren}
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              onToggle(node.nodeId);
            }}
          />
        )}
        {!!n?.pinnedAt && <PinMark />}
        {renaming ? (
          <input
            ref={renameRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '1px 4px',
              fontSize: 13.5,
              fontFamily: 'var(--ui-font)',
              fontWeight: 500,
              background: 'var(--term-surface)',
              border: '1px solid var(--term-accent)',
              borderRadius: 3,
              color: 'var(--term-fg)',
              outline: 'none',
            }}
          />
        ) : (
          <span
            style={{
              flex: 1,
              // Card modes only: lets the title shrink past its content so the
              // trailing marks/caret can't push the row wider. Classic is left
              // exactly as it was.
              ...(geom.isCard ? { minWidth: 0 } : {}),
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 26 : 14}px), transparent)`,
              WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${geom.isCard ? 26 : 14}px), transparent)`,
            }}
          >
            {title}
          </span>
        )}
        {geom.isCard && hasChildren && (
          <span
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.nodeId);
            }}
            style={{
              flexShrink: 0,
              width: 9,
              // Keeps clear of the hover-revealed ⋯ — see caretKebabClearance.
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
        {prefs.showSidebarTimestamps && nodeUpdatedAt > 0 && (
          <span style={{ color: 'var(--term-faint)', fontSize: 'var(--sb-ts-fs, 11px)', flexShrink: 0 }}>
            {relativeTime(nodeUpdatedAt)}
          </span>
        )}
        {selected && (
          <span style={{ color: 'var(--term-select)', fontSize: 11, fontWeight: 700 }}>
            ✓
          </span>
        )}
        <RowKebab
          open={menuOpen}
          onOpen={(p) => openMenuAt(p.x, p.y)}
          ariaLabel={`Actions for ${title}`}
        />
        {openState !== 'none' && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              // Right edge in every mode — see ThreadRow.
              right: geom.isCard ? 3 : 2,
              top: 5,
              bottom: 5,
              width: 2,
              borderRadius: 1,
              // Classic paints both states accent and leans on pulse + glow to
              // tell them apart; card modes give idle a neutral rail so accent
              // always means something is actually running.
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
                  : newPanePulse
                    ? 'bar-pulse-once 600ms ease-in-out 2'
                    : undefined,
              pointerEvents: 'none',
            }}
          />
        )}
      </Row>
      {hasChildren && expanded &&
        node.children.map((child) => (
          <BranchRow
            key={child.nodeId}
            node={child}
            depth={depth + 1}
            expanded={isExpanded(child.nodeId)}
            isFocused={isFocused}
            isSelected={isSelected}
            isExpanded={isExpanded}
            isMenuTarget={isMenuTarget}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            openState={getOpenState(child.nodeId)}
            getOpenState={getOpenState}
            renamingNodeId={renamingNodeId}
            onRenameNode={onRenameNode}
            onRenameEnd={onRenameEnd}
          />
        ))}
    </>
  );
}
