import React, { useState } from 'react';
import ContextMenu, { type MenuSection } from '../ContextMenu';
import { FolderIcon } from './WorkspaceMenuButton';

interface MinimalProject {
  id: string;
  name: string;
}

export interface HomeWorkspaceChipProps {
  active: MinimalProject | null;
  liveProjects: ReadonlyArray<MinimalProject>;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
}

export function HomeWorkspaceChip({
  active,
  liveProjects,
  onSelect,
  onNewWorkspace,
}: HomeWorkspaceChipProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; anchorBottom: number; trigger: HTMLElement } | null>(null);

  const sections: MenuSection[] = [
    {
      trailingGlyph: true,
      items:
        liveProjects.length === 0
          ? [{ id: 'empty', label: '— no workspaces —', disabled: true, run: () => {} }]
          : liveProjects.map((p) => ({
              id: `ws-${p.id}`,
              label: p.name,
              glyph: active?.id === p.id ? '✓' : undefined,
              run: () => onSelect(p.id),
            })),
    },
    {
      // Trailing slot reserved for action-style row; leading glyph keeps the
      // "+" affordance visually aligned with the row text instead of floating
      // on the right where state indicators live.
      trailingGlyph: false,
      pinned: true,
      items: [
        {
          id: 'new-workspace',
          label: 'new workspace',
          glyph: '+',
          run: () => onNewWorkspace(),
        },
      ],
    },
  ];

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        className="t-toolbar-chip"
        title="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          e.stopPropagation();
          const trigger = e.currentTarget;
          const r = trigger.getBoundingClientRect();
          setMenu((open) => (open ? null : { x: r.left, y: r.bottom + 6, anchorBottom: r.top - 6, trigger }));
        }}
        style={{
          color: active ? 'var(--term-fg)' : 'var(--term-faint)',
          fontStyle: active ? undefined : 'italic',
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--term-faint)', flexShrink: 0 }}>
          <FolderIcon size={12} />
        </span>
        <span className="t-chip-label">{active?.name ?? 'no workspace'}</span>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchorBottom={menu.anchorBottom}
          trigger={menu.trigger}
          sections={sections}
          menuKind="workspace"
          searchable
          searchPlaceholder="Search workspaces…"
          onClose={() => setMenu(null)}
        />
      )}
    </span>
  );
}
