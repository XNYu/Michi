import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  chatLabel,
  shallowArrayEqual,
  useChatActions,
  useChatPanes,
  useStructuralSelector,
} from '../../state/chatStore';
import type { PaneItemKind } from '../../state/paneItems';
import ContextMenu from '../ContextMenu';
import { Dot } from './primitives';
import PaneLauncher from './PaneLauncher';
import { kbd } from '../../lib/platform';

const TAB_DRAG_MIME = 'application/x-michi-tab-id';

type TabKind = PaneItemKind | 'chat' | 'digest' | 'artifact';

const KIND_GLYPH: Partial<Record<TabKind, string>> = {
  launcher: '+',
  files: '▱',
  review: '±',
  file: '◇',
  diff: '±',
  terminal: '>_',
  'agent-run': '◆',
  digest: '§',
};

function ChatGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <path
        d="M8 2.5c3.3 0 5.5 2 5.5 4.6S11.3 11.7 8 11.7c-.6 0-1.2-.1-1.8-.2L3.4 13l.6-2.4C3 9.7 2.5 8.5 2.5 7.1 2.5 4.5 4.7 2.5 8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TabIcon({ kind, status }: { kind: TabKind; status: string }) {
  if (status === 'streaming') return <Dot color="var(--term-select)" size={7} pulse />;
  if (status === 'error') return <Dot color="var(--term-danger)" size={7} />;
  const glyph = KIND_GLYPH[kind];
  if (!glyph) return <ChatGlyph />;
  return (
    <span aria-hidden style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0 }}>
      {glyph}
    </span>
  );
}

/**
 * Single-page mode's browser-style tab bar: one tab per pane in the active
 * tree's slot. Only the focused tab's pane is shown below it.
 */
export default function PaneTabStrip({ titleOverride, leftInset }: {
  /** Fixed title for every tab (the assistant's hidden workspace). */
  titleOverride?: string;
  /** Clearance for the floating Zone 1 cluster when the sidebar is collapsed. */
  leftInset: number;
}) {
  const { tabPanes = [], focusedPane, paneItems = {} } = useChatPanes();
  const { focusPane, closePane, reorderPane, setPaneWidth } = useChatActions();

  const titles = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => {
      if (paneItems[id]) return paneItems[id].title;
      if (titleOverride) return titleOverride;
      const node = nodesMap[id];
      return node ? node.title || chatLabel(node) : '';
    }),
    shallowArrayEqual,
  );
  const statuses = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => {
      const node = nodesMap[id];
      if (paneItems[id] || !node) return 'idle';
      return node.status === 'streaming' && node.visibleResponseComplete ? 'idle' : node.status ?? 'idle';
    }),
    shallowArrayEqual,
  );
  const kinds = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => (paneItems[id]?.kind ?? nodesMap[id]?.kind ?? 'chat') as string),
    shallowArrayEqual,
  );

  const closeOthers = useCallback((keepId: string) => {
    for (const id of tabPanes) if (id !== keepId) closePane(id);
    focusPane(keepId);
    setPaneWidth(keepId, undefined);
  }, [tabPanes, closePane, focusPane, setPaneWidth]);

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Keep the active tab in view when it changes (Ctrl+Tab, background opens).
  useEffect(() => {
    if (focusedPane) tabRefs.current[focusedPane]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusedPane]);

  return (
    <>
    <div
      role="tablist"
      aria-label="Open panes"
      className="hide-sb"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        marginLeft: leftInset,
        padding: '0 160px 0 8px',
        overflowX: 'auto',
        overflowY: 'hidden',
        // Gaps between tabs stay window-draggable; tabs opt out.
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {tabPanes.map((id, i) => (
        <PaneTab
          key={id}
          id={id}
          title={titles[i] || 'Untitled'}
          kind={(kinds[i] ?? 'chat') as TabKind}
          status={statuses[i] ?? 'idle'}
          active={id === focusedPane}
          tabRef={(el) => { tabRefs.current[id] = el; }}
          onSelect={focusPane}
          onClose={closePane}
          onMenu={(x, y) => setMenu({ id, x, y })}
          onReorder={reorderPane}
        />
      ))}
      <span style={{ display: 'inline-flex', marginLeft: 4, flexShrink: 0 }}>
        <PaneLauncher />
      </span>
    </div>
      {/* Outside the drag region so Electron doesn't swallow menu clicks. */}
      <AnimatePresence>{menu && (
        <ContextMenu
          key={`${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          sections={[{
            items: [
              { id: 'close', label: 'Close', keys: kbd('mod', 'W'), run: () => closePane(menu.id) },
              {
                id: 'close-others',
                label: 'Close Others',
                disabled: tabPanes.length < 2,
                run: () => closeOthers(menu.id),
              },
            ],
          }]}
        />
      )}</AnimatePresence>
    </>
  );
}

function PaneTab({ id, title, kind, status, active, tabRef, onSelect, onClose, onMenu, onReorder }: {
  id: string;
  title: string;
  kind: TabKind;
  status: string;
  active: boolean;
  tabRef: (el: HTMLDivElement | null) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMenu: (x: number, y: number) => void;
  onReorder: (fromId: string, toId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={active}
      title={title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DRAG_MIME, id);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
        e.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        setDropTarget(false);
        const from = e.dataTransfer.getData(TAB_DRAG_MIME);
        if (from) onReorder(from, id);
      }}
      onClick={() => onSelect(id)}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 30,
        flex: '0 1 auto',
        minWidth: 72,
        maxWidth: 240,
        boxSizing: 'border-box',
        padding: '0 6px 0 10px',
        borderRadius: 'var(--ui-radius-lg)',
        border: `1px solid ${active ? 'var(--term-line)' : 'transparent'}`,
        boxShadow: dropTarget ? 'inset 2px 0 0 var(--term-accent)' : undefined,
        background: active
          ? 'var(--term-surface)'
          : hovered ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
        color: active ? 'var(--term-fg)' : 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-md)',
        userSelect: 'none',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
        transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease)',
      } as React.CSSProperties}
    >
      <TabIcon kind={kind} status={status} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </span>
      {active ? (
        <TabButton
          label={`Actions for ${title}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(rect.left, rect.bottom + 4);
          }}
        >
          ⋯
        </TabButton>
      ) : (
        <TabButton label={`Close ${title}`} hidden={!hovered} onClick={() => onClose(id)}>
          ×
        </TabButton>
      )}
    </div>
  );
}

function TabButton({ label, hidden = false, onClick, children }: {
  label: string;
  hidden?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={hidden ? -1 : 0}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        borderRadius: 'var(--ui-radius-sm)',
        background: hover ? 'var(--term-alt)' : 'transparent',
        color: hover ? 'var(--term-fg)' : 'var(--term-muted)',
        fontFamily: 'inherit',
        fontSize: 'var(--fs-lg)',
        lineHeight: 1,
        cursor: 'pointer',
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    >
      {children}
    </button>
  );
}
