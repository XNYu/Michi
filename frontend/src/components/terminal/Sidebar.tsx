import React, { useEffect, useRef, useState } from 'react';
import { usePrefs } from '../../state/prefs';
import { PROFILE_PAGE_ENABLED } from '../../state/featureFlags';
import { Row } from './primitives';
import WorkspaceTree from './WorkspaceTree';
import TreeSelectionBar from './TreeSelectionBar';
import ResizeHandle from '../ResizeHandle';
import {
  HomeIcon,
  WorkspacesIcon,
  SettingsIcon,
  UserIcon,
  ArtifactsIcon,
} from './icons';
import type { PageId } from '../../state/commands';

// Min must cover the Topbar Zone 1 button cluster so drag-resizing can't
// push the sidebar narrower than its header icons.  ZONE1_WIDTH (topbar.tsx)
// is TRAFFIC_LIGHT_PAD(96) + 6×26 + 5×4 + RIGHT_PAD(8) = 280px.
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_SIDEBAR_WIDTH = 280;

/** Sidebar row density → the `--sb-*` CSS vars consumed by WorkspaceRow /
 *  ThreadRow / BranchRow / merge rows / BottomNav. `compact` reproduces the
 *  historical hardcoded values, so those live on as the var fallbacks too. */
const SIDEBAR_DENSITY: Record<
  'compact' | 'comfortable' | 'airy',
  { fs: number; rowPy: number; wsGap: number; tsFs: number; navPy: number }
> = {
  compact: { fs: 13.5, rowPy: 4, wsGap: 6, tsFs: 11, navPy: 6 },
  comfortable: { fs: 13.5, rowPy: 6, wsGap: 10, tsFs: 11, navPy: 7 },
  airy: { fs: 14, rowPy: 8, wsGap: 14, tsFs: 11.5, navPy: 8 },
};

export default function TerminalSidebar({
  activePage,
  onNav,
  onOpenPalette,
  onNewThread,
  narrowMode = false,
  narrowOverlayOpen = false,
  onCloseOverlay,
}: {
  activePage: PageId;
  onNav: (p: PageId) => void;
  onOpenPalette: () => void;
  onNewThread: () => void;
  narrowMode?: boolean;
  narrowOverlayOpen?: boolean;
  onCloseOverlay?: () => void;
}) {
  const { prefs, setPref } = usePrefs();
  const asideRef = useRef<HTMLElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Clamp persisted width to current MIN so legacy narrower values auto-correct.
  const effectiveWidth = Math.max(prefs.terminalSidebarWidth, MIN_SIDEBAR_WIDTH);
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--term-sidebar-width',
      `${effectiveWidth}px`,
    );
    // Persist the correction so we don't recompute every render.
    if (prefs.terminalSidebarWidth < MIN_SIDEBAR_WIDTH) {
      setPref('terminalSidebarWidth', MIN_SIDEBAR_WIDTH);
    }
  }, [effectiveWidth, prefs.terminalSidebarWidth, setPref]);

  // Broadcast a window of "sidebar is animating its width" so panes can pause
  // ResizeObserver-driven reflows for the duration of the toggle and resume
  // once it settles. Skip the very first render so we don't fire on mount.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (narrowMode) return; // overlay slides in via CSS keyframes; panes don't reflow
    window.dispatchEvent(
      new CustomEvent('michi:sidebar-animating', { detail: { animating: true } }),
    );
    const id = window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('michi:sidebar-animating', { detail: { animating: false } }),
      );
    }, 170);
    return () => window.clearTimeout(id);
  }, [prefs.sidebarCollapsed, narrowMode]);

  // In narrow mode, when the overlay is closed, render nothing — no sliver, no
  // hit target. The Topbar's ≡ button drives narrowOverlayOpen.
  if (narrowMode && !narrowOverlayOpen) return null;

  const overlayMode = narrowMode && narrowOverlayOpen;
  // Wide mode + collapsed: keep mounted at width 0 so the open/close transition
  // can actually play. Suppress border + interactivity while collapsed so it
  // behaves like the previous unmounted state visually.
  const collapsed = !narrowMode && prefs.sidebarCollapsed;

  const d = SIDEBAR_DENSITY[prefs.sidebarDensity];
  const densityVars = {
    '--sb-fs': `${d.fs}px`,
    '--sb-row-py': `${d.rowPy}px`,
    '--sb-ws-gap': `${d.wsGap}px`,
    '--sb-ts-fs': `${d.tsFs}px`,
    '--sb-nav-py': `${d.navPy}px`,
    // Horizontal gutter between sidebar content and its edges. Applied as
    // padding on the scrollable tree + bottom nav (below), so it stacks on
    // top of each row's own left/right padding. 0 = flush (original look).
    '--sb-inset': `${prefs.sidebarInset}px`,
  } as React.CSSProperties;

  const aside = (
    <aside
      ref={asideRef}
      className="terminal-sidebar"
      aria-hidden={collapsed || undefined}
      style={{
        ...densityVars,
        width: overlayMode ? effectiveWidth : (collapsed ? 0 : effectiveWidth),
        flexShrink: 0,
        background: 'var(--term-sidebar-bg, var(--term-surface))',
        border: 'var(--term-sidebar-outline, none)',
        borderRight: overlayMode
          ? '1px solid var(--term-line)'
          : (collapsed ? 'none' : '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)'),
        borderRadius: 'var(--term-sidebar-radius, 0px)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--ui-font)',
        color: 'var(--term-fg)',
        position: overlayMode ? 'absolute' : 'relative',
        left: overlayMode ? 0 : undefined,
        top: overlayMode ? 0 : undefined,
        bottom: overlayMode ? 0 : undefined,
        // z-index 1 in non-overlay mode lifts the sidebar (and its right-edge
        // box-shadow) above sibling pane content, which otherwise paints its
        // own surface bg over the 8px shadow extension and hides the glow.
        zIndex: overlayMode ? 35 : (collapsed ? undefined : 1),
        boxShadow: overlayMode
          ? '4px 0 24px rgba(0,0,0,0.18)'
          : (collapsed
              ? undefined
              : 'var(--term-sidebar-shadow, 2px 0 6px rgba(0,0,0,0.05))'),
        // Clip the box-shadow's upward feather (top: 0) so it doesn't bleed
        // into the Topbar Zone 1 spacer above and create a visible horizontal
        // joint. Right/bottom are extended past the element so the right glow
        // and bottom feather still render. Overlay mode keeps its own halo.
        clipPath: overlayMode || collapsed ? undefined : 'inset(0 -8px -8px 0)',
        height: '100%',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        overflow: 'hidden',
        opacity: collapsed ? 0 : 1,
        pointerEvents: collapsed ? 'none' : undefined,
        transition: overlayMode || isResizing
          ? 'none'
          : 'width 150ms cubic-bezier(.4,0,.2,1), opacity 120ms ease-out',
        animation: overlayMode ? 'slideInLeft 200ms ease-out' : undefined,
      }}
    >
      <TreeSelectionBar />
      <WorkspaceTree
        onActivate={() => onNav('dashboard')}
        chatViewActive={activePage === 'dashboard'}
      />
      <BottomNav activePage={activePage} onNav={onNav} />
      {!collapsed && !overlayMode && (
        <ResizeHandle
          paneRef={asideRef}
          min={MIN_SIDEBAR_WIDTH}
          onResize={(w) => setPref('terminalSidebarWidth', Math.min(MAX_SIDEBAR_WIDTH, w))}
          onReset={() => setPref('terminalSidebarWidth', DEFAULT_SIDEBAR_WIDTH)}
          onResizeStart={() => {
            setIsResizing(true);
            window.dispatchEvent(
              new CustomEvent('michi:sidebar-resizing', { detail: { resizing: true } }),
            );
          }}
          onResizeEnd={() => {
            setIsResizing(false);
            window.dispatchEvent(
              new CustomEvent('michi:sidebar-resizing', { detail: { resizing: false } }),
            );
          }}
        />
      )}
    </aside>
  );

  if (overlayMode) {
    return (
      <>
        <div
          onMouseDown={onCloseOverlay}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.32)',
            zIndex: 34,
            animation: 'fadeIn 200ms ease-out',
          }}
        />
        {aside}
      </>
    );
  }

  return aside;
}

function BottomNav({
  activePage,
  onNav,
}: {
  activePage: PageId;
  onNav: (p: PageId) => void;
}) {
  const Item = ({
    id,
    glyph,
    label,
    kbd,
    badge,
    onClick,
  }: {
    /** Page this row navigates to. Omit for action rows (drawers) that use onClick. */
    id?: PageId;
    glyph: React.ReactNode;
    label: string;
    kbd?: string;
    badge?: number;
    /** Overrides page-nav; used by drawer toggles (e.g. Artifacts). */
    onClick?: () => void;
  }) => {
    const active = id !== undefined && activePage === id;
    return (
      <Row
        onClick={() => (onClick ? onClick() : id !== undefined && onNav(id))}
        active={active}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          // Text/icons indent by --sb-inset; the row box stays full-bleed (its
          // negative margin cancels the BottomNav container padding) so the
          // active background still reads as a full-width highlight. See index.css.
          padding: 'var(--sb-nav-py, 6px) calc(12px + var(--sb-inset, 0px))',
          color: active ? 'var(--term-fg)' : 'var(--term-mid)',
          background: active ? 'var(--term-alt)' : 'transparent',
          fontSize: 14,
          fontFamily: 'var(--ui-font)',
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            color: active ? 'var(--term-accent)' : 'var(--term-muted)',
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {glyph}
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        {badge !== undefined && badge > 0 && (
          <span
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 10.5,
              color: 'var(--term-surface)',
              background: 'var(--term-muted)',
              padding: '0 5px',
              minWidth: 16,
              textAlign: 'center',
              fontWeight: 700,
            }}
          >
            {badge}
          </span>
        )}
        {kbd && (
          <span
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 11,
              color: 'var(--term-faint)',
            }}
          >
            {kbd}
          </span>
        )}
      </Row>
    );
  };

  return (
    <div
      style={{
        padding: '6px var(--sb-inset, 0px)',
        flexShrink: 0,
      }}
    >
      {/* Branches / Map / Digest are thread-scoped views — their entries live
          in the Topbar right cluster now, next to Artifacts. */}
      <Item
        glyph={<ArtifactsIcon size={15} />}
        label="Artifacts"
        kbd="⇧⌘A"
        onClick={() => window.dispatchEvent(new CustomEvent('michi:toggle-artifacts'))}
      />
      <Item id="workspaces" glyph={<WorkspacesIcon size={15} />} label="Workspaces" />
      <Item id="home" glyph={<HomeIcon size={15} />} label="Home" />
      <Item id="settings" glyph={<SettingsIcon size={15} />} label="Settings" />
      {PROFILE_PAGE_ENABLED && (
        <Item id="profile" glyph={<UserIcon size={15} />} label="Profile" />
      )}
    </div>
  );
}

