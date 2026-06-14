import React from 'react';
import type { ChatNodeState, Project, Tree } from '../../../state/chatTypes';
import { deriveTreeRows, firstUserSnippet, type TreeRow } from './derive';
import ContextMenu from '../../ContextMenu';
import { buildThreadRowContextMenu } from '../../../lib/threadRowContextMenu';
import type {
  MenuSection as UiMenuSection,
} from '../../ContextMenu';
import type {
  ContextMenuSection as ThreadCtxSection,
} from '../../../lib/threadRowContextMenu';

export interface ChatTreeListMenuActions {
  activateTree: (id: string) => void;
  archiveTree: (id: string) => void;
  unarchiveTree: (id: string) => void;
  pinTree?: (id: string) => void;
  unpinTree?: (id: string) => void;
  renameTree: (id: string, name: string) => void;
  deleteTree: (id: string) => void;
  exportTree: (id: string) => void;
}

interface Props {
  workspace: Project;
  nodes: Record<string, ChatNodeState>;
  filter: string;
  onOpen: (chatId: string) => void;
  menuActions?: ChatTreeListMenuActions;
}

function toMenuSections(sections: ThreadCtxSection[]): UiMenuSection[] {
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

interface TreeGroup {
  treeId: string;
  title: string;
  lastActiveAt: number;
  pinned: boolean;
  root: Extract<TreeRow, { kind: 'root' }>;
  branches: Extract<TreeRow, { kind: 'branch' }>[];
  overflow: Extract<TreeRow, { kind: 'overflow' }> | null;
}

function rowsToGroups(rows: TreeRow[]): TreeGroup[] {
  const groups: TreeGroup[] = [];
  let current: TreeGroup | null = null;
  for (const row of rows) {
    if (row.kind === 'label') {
      // Label rows mark the start of a new tree but we'll attach data on root.
      continue;
    }
    if (row.kind === 'root') {
      current = {
        treeId: row.treeId,
        title: '',
        lastActiveAt: 0,
        pinned: row.pinned,
        root: row,
        branches: [],
        overflow: null,
      };
      groups.push(current);
    } else if (row.kind === 'branch' && current && current.treeId === row.treeId) {
      current.branches.push(row);
    } else if (row.kind === 'overflow' && current && current.treeId === row.treeId) {
      current.overflow = row;
    }
  }
  // Backfill title + lastActiveAt from the label row pass.
  for (const row of rows) {
    if (row.kind !== 'label') continue;
    const g = groups.find((x) => x.treeId === row.treeId);
    if (g) {
      g.title = row.title;
      g.lastActiveAt = row.lastActiveAt;
    }
  }
  return groups;
}

export default function ChatTreeList({
  workspace,
  nodes,
  filter,
  onOpen,
  menuActions,
}: Props) {
  const rows = React.useMemo(
    () => deriveTreeRows(workspace, nodes, filter),
    [workspace, nodes, filter],
  );
  const groups = React.useMemo(() => rowsToGroups(rows), [rows]);
  const pinned = groups.filter((g) => g.pinned);
  const rest = groups.filter((g) => !g.pinned);

  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [menu, setMenu] = React.useState<{ x: number; y: number; tree: Tree } | null>(null);

  const treeById = React.useMemo(() => {
    const m = new Map<string, Tree>();
    for (const t of workspace.trees) m.set(t.id, t);
    return m;
  }, [workspace.trees]);

  const openMenuForTree = (tree: Tree | undefined, x: number, y: number) => {
    if (!tree || !menuActions) return;
    setMenu({ x, y, tree });
  };

  const closeMenu = () => setMenu(null);

  const menuSections = menu && menuActions
    ? toMenuSections(
        buildThreadRowContextMenu({
          treeId: menu.tree.id,
          tree: menu.tree,
          actions: {
            activateTree: menuActions.activateTree,
            archiveTree: menuActions.archiveTree,
            unarchiveTree: menuActions.unarchiveTree,
            pinTree: menuActions.pinTree,
            unpinTree: menuActions.unpinTree,
            renameTree: menuActions.renameTree,
            deleteTree: menuActions.deleteTree,
            exportTree: menuActions.exportTree,
          },
        }),
      )
    : [];

  if (groups.length === 0) {
    return (
      <div
        style={{
          padding: '20px 0',
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-muted)',
        }}
      >
        no chats yet — start one above
      </div>
    );
  }

  const renderGroup = (g: TreeGroup) => (
    <TreeBlock
      key={g.treeId}
      group={g}
      tree={treeById.get(g.treeId)}
      hoveredId={hoveredId}
      selectedId={selectedId}
      onHover={setHoveredId}
      onSelect={(id) => {
        setSelectedId(id);
        onOpen(id);
      }}
      onContextMenu={(e, tree) => {
        if (!tree || !menuActions) return;
        e.preventDefault();
        openMenuForTree(tree, e.clientX, e.clientY);
      }}
      onMoreClick={(rect, tree) => openMenuForTree(tree, rect.right, rect.bottom)}
      menuEnabled={!!menuActions}
    />
  );

  return (
    <>
      <style>{`
        .chat-tree-block + .chat-tree-block {
          border-top: 1px solid color-mix(in srgb, var(--term-line) 45%, transparent);
        }
        .chat-tree-block:has([data-hovered="true"]) { border-top-color: transparent; }
        .chat-tree-block:has([data-hovered="true"]) + .chat-tree-block { border-top-color: transparent; }
      `}</style>
      <div role="list">
        {pinned.length > 0 && (
          <>
            <SectionLabel icon={<StarGlyph filled />} text="PINNED" tone="pin" />
            {pinned.map(renderGroup)}
            <div style={{ height: 6 }} />
            <SectionLabel text="RECENT" />
          </>
        )}
        {rest.map(renderGroup)}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          sections={menuSections}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

function SectionLabel({
  text,
  icon,
  tone,
}: {
  text: string;
  icon?: React.ReactNode;
  tone?: 'pin';
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        color: 'var(--term-muted)',
        padding: '6px 18px 14px',
        letterSpacing: '0.12em',
        fontWeight: 500,
        fontFamily: 'var(--ui-font)',
      }}
    >
      {icon && (
        <span
          style={{
            color: tone === 'pin' ? 'var(--term-pin, #c48300)' : 'inherit',
            display: 'inline-flex',
          }}
        >
          {icon}
        </span>
      )}
      {text}
    </div>
  );
}

interface TreeBlockProps {
  group: TreeGroup;
  tree: Tree | undefined;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, tree: Tree | undefined) => void;
  onMoreClick: (rect: DOMRect, tree: Tree | undefined) => void;
  menuEnabled: boolean;
}

function TreeBlock({
  group,
  tree,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
  onContextMenu,
  onMoreClick,
  menuEnabled,
}: TreeBlockProps) {
  return (
    <div
      className="chat-tree-block"
      style={{
        padding: '2px 0',
        transition: 'border-color 100ms',
      }}
    >
      <ChatRow
        row={group.root}
        isBranch={false}
        hovered={hoveredId === group.root.nodeId}
        selected={selectedId === group.root.nodeId}
        onHover={onHover}
        onSelect={onSelect}
        onContextMenu={(e) => onContextMenu(e, tree)}
        onMoreClick={(r) => onMoreClick(r, tree)}
        menuEnabled={menuEnabled}
      />
      {group.branches.map((b) => (
        <ChatRow
          key={b.nodeId}
          row={b}
          isBranch
          hovered={hoveredId === b.nodeId}
          selected={selectedId === b.nodeId}
          onHover={onHover}
          onSelect={onSelect}
          onContextMenu={(e) => e.preventDefault()}
          onMoreClick={() => undefined}
          menuEnabled={false}
        />
      ))}
      {group.overflow && (
        <div
          style={{
            paddingLeft: 40,
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            color: 'var(--term-faint, var(--term-muted))',
          }}
        >
          … +{group.overflow.count} deeper
        </div>
      )}
    </div>
  );
}

interface ChatRowProps {
  row: Extract<TreeRow, { kind: 'root' | 'branch' }>;
  isBranch: boolean;
  hovered: boolean;
  selected: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMoreClick: (rect: DOMRect) => void;
  menuEnabled: boolean;
}

function ChatRow({
  row,
  isBranch,
  hovered,
  selected,
  onHover,
  onSelect,
  onContextMenu,
  onMoreClick,
  menuEnabled,
}: ChatRowProps) {
  const node = row.node;
  const snippet = firstUserSnippet(node);
  const isRoot = row.kind === 'root';
  const branchCount = !isBranch && row.kind === 'root' ? row.branchCount : 0;

  return (
    <div
      role="listitem"
      data-hovered={hovered}
      data-selected={selected}
      data-pinned={isRoot && row.kind === 'root' ? row.pinned : false}
      onMouseEnter={() => onHover(node.nodeId)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(node.nodeId)}
      onContextMenu={onContextMenu}
      style={{
        position: 'relative',
        padding: '6px 10px 6px 8px',
        marginLeft: isBranch ? 18 : 0,
        background: selected
          ? 'var(--term-sel, color-mix(in srgb, var(--term-accent) 14%, transparent))'
          : hovered
            ? 'var(--term-hover, var(--term-alt))'
            : 'transparent',
        cursor: 'pointer',
        transition: 'background 100ms',
      }}
    >
      {selected && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            background: 'var(--term-accent)',
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        {isBranch && (
          <span
            style={{
              color: 'var(--term-faint, var(--term-muted))',
              fontSize: 12,
              lineHeight: 1.2,
              flexShrink: 0,
            }}
          >
            ›
          </span>
        )}
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: isBranch ? 14 : 15,
            lineHeight: 1.3,
            fontWeight: 500,
            color: 'var(--term-fg)',
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.title || 'Untitled'}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--term-muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            fontFamily: 'var(--ui-font)',
          }}
        >
          {node.messages.length}m
        </span>
        {branchCount > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 12,
              color: 'var(--term-muted)',
              flexShrink: 0,
              fontFamily: 'var(--ui-font)',
            }}
          >
            <BranchGlyph /> {branchCount}
          </span>
        )}
        {isRoot && menuEnabled && hovered ? (
          <button
            type="button"
            aria-label="more actions"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMoreClick(r);
            }}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--term-muted)',
              fontSize: 14,
              lineHeight: 1,
              padding: '2px 6px',
              flexShrink: 0,
            }}
          >
            ⋯
          </button>
        ) : null}
      </div>
      {snippet && (
        <div
          style={{
            marginTop: 1,
            marginLeft: isBranch ? 16 : 0,
            fontFamily: 'var(--ui-font)',
            fontSize: 12.5,
            lineHeight: 1.4,
            color: 'var(--term-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {snippet}
        </div>
      )}
    </div>
  );
}

function StarGlyph({ filled }: { filled?: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3 4.1 13.3 5 9 1.7 6l4.4-.5L8 1.5z" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="4" cy="3" r="1.3" />
      <circle cx="4" cy="13" r="1.3" />
      <circle cx="12" cy="8" r="1.3" />
      <path d="M4 4.3v7.4M4.8 12.6c2.5-.5 6.4-1.6 6.4-4.6 0-1.4-.8-2.6-2.4-3" />
    </svg>
  );
}
