import React, { useEffect, useRef, useState } from 'react';
import { useChatNode, useChatProjects } from '../../state/chatStore';
import { Row, RowKebab } from './primitives';
import { Chevron } from './ThreadRow';
import type { TreeNode } from '../../state/tree';
import { isNodeUnread, type OpenState } from '../../state/sidebarSelectors';
import { relativeTime } from '../../lib/relativeTime';

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
          paddingTop: 4,
          paddingRight: 10,
          paddingBottom: 4,
          paddingLeft: 8 + depth * 10,
          background: selected
            ? 'var(--term-select-f)'
            : focused ? 'var(--term-alt)'
            : menuOpen ? 'var(--term-alt)'
            : undefined,
          borderLeft: selected
            ? '2px solid var(--term-select)'
            : focused ? '2px solid var(--term-accent)'
            : '2px solid transparent',
          color: focused || selected || menuOpen ? 'var(--term-fg)' : 'var(--term-mid)',
          fontWeight: unread ? 900 : (focused || selected ? 600 : 450),
          fontSize: 13.5,
          fontFamily: 'var(--ui-font)',
        }}
      >
        <Chevron
          expanded={expanded}
          visible={hasChildren}
          onClick={(e) => {
            if (!hasChildren) return;
            e.stopPropagation();
            onToggle(node.nodeId);
          }}
        />
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
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
              WebkitMaskImage: 'linear-gradient(to right, black calc(100% - 14px), transparent)',
            }}
          >
            {title}
          </span>
        )}
        {nodeUpdatedAt > 0 && (
          <span style={{ color: 'var(--term-faint)', fontSize: 11, flexShrink: 0 }}>
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
