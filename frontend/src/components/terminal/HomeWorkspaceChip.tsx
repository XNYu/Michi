import React, { useId, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import ContextMenu, { menuOpenKey, type MenuSection } from '../ContextMenu';
import { workspaceRemoteNote } from '../WorkspaceLocation';
import { useBackendConnections } from '../../state/useBackendConnections';
import { FolderIcon } from './icons';
import { composerMenusOpenBelow } from './PaneComposerToolbarLeft';

interface MinimalProject {
  id: string;
  name: string;
  backendConnectionId?: string;
}

export interface HomeWorkspaceChipProps {
  active: MinimalProject | null;
  liveProjects: ReadonlyArray<MinimalProject>;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
  /** Leave the active workspace and chat without one. Offered only while a
   *  workspace is active: as a × over the folder icon on hover, and as a
   *  menu row for touch and keyboard. */
  onClear?: () => void;
}

const CLEAR_LABEL = 'Chat without a workspace';

/** Filled circle with a knocked-out ×. The mask cuts the × through to
 *  whatever is behind the chip, so no background colour is assumed. */
function ClearGlyph() {
  const maskId = `home-ws-clear-${useId().replace(/:/g, '')}`;
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true">
      <mask id={maskId}>
        <circle cx="8" cy="8" r="7" fill="white" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="black" strokeWidth={1.6} strokeLinecap="round" />
      </mask>
      <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

export function HomeWorkspaceChip({
  active,
  liveProjects,
  onSelect,
  onNewWorkspace,
  onClear,
}: HomeWorkspaceChipProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; anchorBottom: number; preferBelow: boolean; trigger: HTMLElement } | null>(null);
  const canClear = !!active && !!onClear;
  const connections = useBackendConnections();

  const sections: MenuSection[] = [
    {
      trailingGlyph: true,
      items:
        liveProjects.length === 0
          ? [{ id: 'empty', label: '— no workspaces —', disabled: true, run: () => {} }]
          : liveProjects.map((p) => ({
              id: `ws-${p.id}`,
              label: p.name,
              // Remote workspaces say which backend they live on; local ones need no note.
              sublabel: workspaceRemoteNote(p.backendConnectionId, connections),
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
        ...(canClear
          ? [{ id: 'no-workspace', label: 'no workspace', glyph: '×', run: () => onClear!() }]
          : []),
      ],
    },
  ];

  return (
    // Sized in homeCards.css: whole in the toolbar, shortened in the tray.
    <span
      className="home-workspace-chip"
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
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
          const preferBelow = composerMenusOpenBelow(trigger);
          setMenu((open) => (open ? null : { x: r.left, y: r.bottom + 6, anchorBottom: r.top - 6, preferBelow, trigger }));
        }}
        style={{
          color: active ? 'var(--term-fg)' : 'var(--term-muted)',
          fontStyle: active ? undefined : 'italic',
        }}
      >
        <span className="home-workspace-chip__folder" style={{ display: 'inline-flex', color: 'var(--term-faint)', flexShrink: 0 }}>
          <FolderIcon size={12} />
        </span>
        <span className="t-chip-label">{active?.name ?? 'no workspace'}</span>
      </button>
      {canClear && (
        // A sibling over the folder icon, not a child: a button cannot hold
        // another button. CSS reveals it while the chip is hovered.
        <button
          type="button"
          className="home-workspace-chip__clear"
          aria-label={CLEAR_LABEL}
          title={CLEAR_LABEL}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
            onClear!();
          }}
        >
          <ClearGlyph />
        </button>
      )}
      <AnimatePresence>
        {menu && (
          <ContextMenu
            key={menuOpenKey(menu)}
            x={menu.x}
            y={menu.y}
            anchorBottom={menu.anchorBottom}
            preferBelow={menu.preferBelow}
            trigger={menu.trigger}
            sections={sections}
            menuKind="workspace"
            searchable
            searchPlaceholder="Search workspaces…"
            onClose={() => setMenu(null)}
          />
        )}
      </AnimatePresence>
    </span>
  );
}
