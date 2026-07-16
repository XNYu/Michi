import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatActions, useChatProjects, useStructuralSelector, shallowArrayEqual } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { IconBtn } from './primitives';
import { checkVersion, triggerUpdate } from '../../services/api';
import { getElectron } from '../../lib/electronBridge';
import SidebarToggleButton from './SidebarToggleButton';
import ContextsPopover from '../ContextsPopover';
import PaneCaption from './PaneCaption';
import { HeaderTooltip } from './WorkspaceMenuButton';
import { selectUnreadTotal } from '../../state/sidebarSelectors';

import type { PageId } from '../../state/commands';
import { kbd } from '../../lib/platform';
import { isArchiveGroupId } from '../../state/trashActions';
import { ArtifactsIcon } from './icons';

const TOPBAR_HEIGHT = 44;
// Traffic-light cluster ends at ~x=66 (start 14 + 3×12 + 2×8 = 66). Pushing
// our icon cluster to x=96 leaves a ~30px breathing gap so the chrome (dots)
// and our chrome (sidebar/+/search) read as two distinct groups.
const TRAFFIC_LIGHT_PAD = 96;
// 26px hit targets give a comfortable click area; the cluster is vertically
// centered in the 44px topbar (y=22), which matches the traffic-light center
// (pos 16 + 6 radius). Horizontal rhythm intentionally differs from the dots.
const ZONE1_BUTTON_W = 26;
const ZONE1_BUTTON_GAP = 4;
// toggle + new-chat + search + unread + back + forward = 6 buttons.
const ZONE1_BUTTON_COUNT = 6;
const ZONE1_BUTTON_CLUSTER_WIDTH =
  ZONE1_BUTTON_COUNT * ZONE1_BUTTON_W + (ZONE1_BUTTON_COUNT - 1) * ZONE1_BUTTON_GAP;
const ZONE1_RIGHT_PAD = 8;
const ZONE1_WIDTH = TRAFFIC_LIGHT_PAD + ZONE1_BUTTON_CLUSTER_WIDTH + ZONE1_RIGHT_PAD;
const BROWSER_BRAND_WIDTH = 76;
const BROWSER_ZONE1_WIDTH = 14 + BROWSER_BRAND_WIDTH + 4 + ZONE1_BUTTON_CLUSTER_WIDTH + ZONE1_RIGHT_PAD;
// Zone 1 hosts toggle + new-chat + search past the traffic-light pad.
// When collapsed, zone-2 still starts directly after zone-1 — no extra pad.
const COLLAPSED_LEFT_PAD = 0;

export default function TerminalTopbar({
  page,
  onNav: _onNav,
  sidebarCollapsed,
  onToggleSidebar,
  onNewThread,
  onOpenPalette,
  artifactsOpen = false,
}: {
  page: PageId;
  onNav: (p: PageId) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewThread?: () => void;
  onOpenPalette?: () => void;
  artifactsOpen?: boolean;
}) {
  const {
    activeProject,
    projects,
    openPanes,
    focusedPane,
    focusedNodeId,
    unreadFilterOn,
    canNavBack,
    canNavForward,
  } = useChatProjects();
  const {
    focusPane,
    closePane,
    reorderPane,
    setPaneWidth,
    setUnreadFilterOn,
    navBack,
    navForward,
  } = useChatActions();
  const { prefs } = usePrefs();

  const closeOtherPanes = useCallback((keepId: string) => {
    const others = openPanes.filter((id) => id !== keepId);
    for (const id of others) closePane(id);
    focusPane(keepId);
    // Drop any custom width so the lone surviving pane expands to fill the
    // window (a single pane with no paneWidth renders as a 1fr grid track).
    setPaneWidth(keepId, undefined);
  }, [openPanes, closePane, focusPane, setPaneWidth]);

  const unreadTotal = useStructuralSelector(
    (nodes) => selectUnreadTotal(nodes, focusedNodeId),
  );
  const unreadDisplay = unreadTotal === 0 ? '' : unreadTotal >= 10 ? '9+' : String(unreadTotal);

  const onUnreadClick = useCallback(() => {
    const next = !unreadFilterOn;
    setUnreadFilterOn(next);
    // No page navigation: the filter has no effect on any page body — it only
    // narrows + force-expands the WorkspaceTree, which lives in the always-present
    // sidebar. Turning the filter on therefore "force-shows" the unread items by
    // making sure the sidebar is open (handles narrow/overlay mode too, since
    // sidebarCollapsed/onToggleSidebar are the effective values from the shell).
    if (next && sidebarCollapsed) onToggleSidebar();
  }, [unreadFilterOn, setUnreadFilterOn, sidebarCollapsed, onToggleSidebar]);

  // Per-pane data we need to render captions: title, status, kind. Uses
  // useStructuralSelector so HIGH_FREQ streaming dispatches don't re-render the topbar.
  const paneTitles = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => nodesMap[id]?.title ?? ''),
    shallowArrayEqual,
  );
  const paneStatuses = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => nodesMap[id]?.status ?? 'idle'),
    shallowArrayEqual,
  );
  const paneKinds = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => nodesMap[id]?.kind ?? 'chat'),
    shallowArrayEqual,
  );
  // Pane widths drive the cell grid template — keep zone-2 cells aligned with
  // the Dashboard's pane columns so caption ↔ pane is a single visual stack.
  const paneWidths = useStructuralSelector(
    (nodesMap) => openPanes.map((id) => nodesMap[id]?.paneWidth),
    shallowArrayEqual,
  );

  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Contexts popover state (preserved from the previous Topbar implementation).
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const contextsBtnRef = useRef<HTMLButtonElement>(null);

  // Caption strip scroll sync — when Dashboard scrolls horizontally (overflow
  // mode, ≥3 panes), the caption strip mirrors it so cell ↔ pane stays
  // visually locked. Both sides use a programmatic-scroll guard ref to
  // suppress the echo back.
  const cellsStripRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);

  // Mirror Sidebar's isResizing so Zone 1's width transition can be suppressed
  // during drag-resize — otherwise the topbar lags the sidebar by 200ms.
  const [sidebarResizing, setSidebarResizing] = useState(false);

  useEffect(() => {
    const onPaneScroll = (e: Event) => {
      const detail = (e as CustomEvent<{ scrollLeft: number }>).detail;
      const el = cellsStripRef.current;
      if (!el) return;
      if (Math.abs(el.scrollLeft - detail.scrollLeft) < 0.5) return;
      programmaticScrollRef.current = true;
      el.scrollLeft = detail.scrollLeft;
      // The scroll event fires asynchronously — clear the guard next frame.
      requestAnimationFrame(() => { programmaticScrollRef.current = false; });
    };
    window.addEventListener('michi:dashboard-scroll', onPaneScroll as EventListener);
    return () => window.removeEventListener('michi:dashboard-scroll', onPaneScroll as EventListener);
  }, []);

  useEffect(() => {
    const onResizing = (e: Event) => {
      setSidebarResizing((e as CustomEvent<{ resizing: boolean }>).detail.resizing);
    };
    window.addEventListener('michi:sidebar-resizing', onResizing as EventListener);
    return () => window.removeEventListener('michi:sidebar-resizing', onResizing as EventListener);
  }, []);

  const openContextsPopover = useCallback(() => {
    const r = contextsBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    setAnchorRect(r);
    setPopoverOpen(true);
  }, []);

  const toggleContextsPopover = useCallback(() => {
    if (popoverOpen) setPopoverOpen(false);
    else openContextsPopover();
  }, [popoverOpen, openContextsPopover]);

  // ⌘; from TerminalShell flips the popover via this custom event.
  useEffect(() => {
    const onToggle = () => toggleContextsPopover();
    window.addEventListener('michi:toggle-contexts', onToggle);
    return () => window.removeEventListener('michi:toggle-contexts', onToggle);
  }, [toggleContextsPopover]);

  // Only the packaged Electron build should ever offer Update & Restart.
  // Vite dev (`npm run dev`, `electron:dev`) flips import.meta.env.DEV true;
  // the unpackaged Electron path leaves window.electron.isPackaged false.
  // Both must be production for the button to even probe the version endpoint.
  const updateChannelEnabled =
    !import.meta.env.DEV && getElectron()?.isPackaged === true;

  useEffect(() => {
    if (!updateChannelEnabled) return;
    checkVersion()
      .then((v) => { if (v.updateAvailable) setUpdateAvailable(true); })
      .catch(() => {});
  }, [updateChannelEnabled]);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      let result = await triggerUpdate();
      if (!result.ok && result.requiresConfirm) {
        const target = result.branch ?? 'upstream';
        const detail =
          result.reason === 'ahead'
            ? `${result.aheadCount} local commit(s) ahead of ${target} would be hard-reset away.\n\nProceed anyway? A backup ref will be created so the prior tip is recoverable.`
            : `Tracked files have uncommitted changes that reset --hard will discard.\n\nProceed anyway?`;
        if (!window.confirm(detail)) {
          setUpdating(false);
          return;
        }
        result = await triggerUpdate(true);
      }
      if (result.ok) {
        const electron = getElectron();
        if (electron?.relaunch) {
          electron.relaunch();
        } else {
          window.location.reload();
        }
      } else {
        alert(`Update failed: ${result.error}`);
        setUpdating(false);
      }
    } catch (err) {
      alert(`Update failed: ${err}`);
      setUpdating(false);
    }
  };

  const showWorkspaceTitle =
    page === 'workspaces' || page === 'trash' || page === 'archived' ||
    page === 'workspace-manage' ||
    (!!activeProject && (page === 'branches' || page === 'map' || page === 'digest'));
  // Home page body inherits --term-bg from the shell; the rest of the app
  // paints panes with --term-pane-bg (≈ --term-surface), which is lighter.
  // On Home, align the topbar to --term-bg so there's no white band above
  // the cream body. Other pages keep the pane-bg topbar.
  const topbarBg = page === 'home'
    ? 'var(--term-bg)'
    : 'var(--term-pane-bg, var(--term-surface))';
  const pageLabel =
    page === 'branches' ? 'BRANCHES'
    : page === 'map' ? 'MAP'
    : page === 'digest' ? 'DIGEST'
    : page === 'workspaces' ? 'WORKSPACES'
    : page === 'trash' ? 'TRASH'
    : page === 'archived' ? 'ARCHIVED'
    : '';
  // Trash title mirrors the Workspaces pattern: a single counts line in the
  // topbar so the page body can drop its in-page header. Combines deleted
  // workspaces with deletion groups (matches Settings.tsx's tally).
  const trashGroupCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId);
    }
    return gids.size;
  });
  const trashCount = trashGroupCount + projects.filter((p) => p.deletedAt).length;
  const archivedCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId!);
    }
    return gids.size;
  });
  const showBrowserBrand = getElectron() === null;
  const zone1Width = showBrowserBrand ? BROWSER_ZONE1_WIDTH : ZONE1_WIDTH;
  // The right cluster sits over the rightmost pane in the grid — mirror its
  // focus dim so the Context button area matches that pane's color.
  const rightmostPaneId = openPanes[openPanes.length - 1];
  const rightmostUnfocused =
    !!rightmostPaneId && focusedPane != null && focusedPane !== rightmostPaneId;

  // On dashboard, zone 2 hosts per-pane caption cells aligned to Dashboard's
  // column template. Mirrors Dashboard.tsx logic so the cell strip resizes in
  // lockstep with the pane grid below.
  const showPaneCells = page === 'dashboard' && openPanes.length > 0;
  const overflowPanes = openPanes.length > 2;
  const cellsTemplateColumns = overflowPanes
    ? openPanes.map((_, i) => {
        const w = paneWidths[i];
        return w !== undefined ? `${w}px` : `minmax(${prefs.defaultPaneWidth}px, 1fr)`;
      }).join(' ')
    : openPanes.map((_, i) => {
        const w = paneWidths[i];
        return w !== undefined ? `minmax(0, ${w}px)` : '1fr';
      }).join(' ');

  return (
    <div
      className="terminal-topbar"
      style={{
        height: TOPBAR_HEIGHT,
        flexShrink: 0,
        background: topbarBg,
        display: 'flex',
        alignItems: 'stretch',
        position: 'relative',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Zone 1: chrome region. The icon strip (toggle, new-chat, search) is
          always absolutely positioned over the topbar's left edge so it can
          stay visually fixed regardless of sidebar state. A separate in-flow
          spacer below it carries the sidebar's surface background + right
          border and animates its width in lockstep with the sidebar — that
          way captions don't snap left when the sidebar collapses; they slide
          along with it. */}
      <div
        aria-hidden
        style={{
          width: sidebarCollapsed ? 0 : 'var(--term-sidebar-width, 280px)',
          flexShrink: 0,
          background: 'var(--term-sidebar-bg, var(--term-surface))',
          borderRight: sidebarCollapsed ? 'none' : '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)',
          // Mirror the Sidebar's right-edge glow so the soft shadow line runs
          // continuously from the topbar through the sidebar. clipPath clips
          // the bottom so this shadow meets the Sidebar's shadow exactly at
          // y=topbar_bottom without overlap (the Sidebar already clips its
          // top edge to match). zIndex pairs with the Sidebar's z-index so
          // the two stack consistently above adjacent pane content.
          boxShadow: sidebarCollapsed
            ? undefined
            : 'var(--term-sidebar-shadow, 2px 0 6px rgba(0,0,0,0.05))',
          clipPath: sidebarCollapsed ? undefined : 'inset(-8px -8px 0 0)',
          position: 'relative',
          zIndex: sidebarCollapsed ? undefined : 1,
          overflow: 'hidden',
          transition: sidebarResizing ? 'none' : 'width 150ms cubic-bezier(.4,0,.2,1)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 2,
          width: zone1Width,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          background: 'transparent',
          boxSizing: 'border-box',
          paddingLeft: showBrowserBrand ? 10 : TRAFFIC_LIGHT_PAD,
          paddingRight: ZONE1_RIGHT_PAD,
          gap: ZONE1_BUTTON_GAP,
          minWidth: 0,
          // Pixel-snap match with traffic-light center: screenshot diff at 2x
          // DPR was 2px (icons rendered 1 logical px above the dots). A 1px
          // bottom pad pushes the centered cluster down to y=22 exactly.
          paddingTop: 1,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {showBrowserBrand && (
          <BrandHomeButton onClick={() => _onNav('home')} />
        )}
        <SidebarToggleButton collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
        {onNewThread && (
          <Zone1IconButton onClick={onNewThread} tooltip="new chat" tooltipKbd={kbd('mod', 'T')} aria-label="New chat">
            <PlusIcon />
          </Zone1IconButton>
        )}
        {onOpenPalette && (
          <Zone1IconButton onClick={onOpenPalette} tooltip="search" tooltipKbd={kbd('mod', 'K')} aria-label="Search" className="t-search-trigger">
            <SearchGlyph />
          </Zone1IconButton>
        )}
        <Zone1IconButton
          onClick={onUnreadClick}
          tooltip={unreadFilterOn ? 'Filter: unread only — click to clear' : `${unreadTotal} unread threads — click to filter`}
          aria-label={unreadFilterOn ? 'Filter: unread only — click to clear' : `${unreadTotal} unread`}
          active={unreadFilterOn}
        >
          <UnreadIcon />
          {unreadDisplay && (
            <span style={{ marginLeft: 3, fontSize: 10, fontWeight: 600, lineHeight: 1 }}>
              {unreadDisplay}
            </span>
          )}
        </Zone1IconButton>
        <Zone1IconButton
          onClick={navBack}
          disabled={!canNavBack}
          tooltip="Back"
          tooltipKbd={kbd('mod', '[')}
          aria-label="Navigate back"
        >
          <NavBackIcon />
        </Zone1IconButton>
        <Zone1IconButton
          onClick={navForward}
          disabled={!canNavForward}
          tooltip="Forward"
          tooltipKbd={kbd('mod', ']')}
          aria-label="Navigate forward"
        >
          <NavForwardIcon />
        </Zone1IconButton>
      </div>

      {/* Zone 2: main surface. When collapsed, this zone owns the traffic-light
          pad plus space for the absolutely-positioned sidebar toggle button. */}
      <div
        style={{
          flex: 1,
          background: topbarBg,
          display: 'flex',
          alignItems: 'stretch',
          minWidth: 0,
          paddingLeft: sidebarCollapsed ? COLLAPSED_LEFT_PAD : 0,
          transition: 'padding-left 200ms cubic-bezier(.4,0,.2,1)',
        }}
      >
        {showPaneCells && (
          <div
            ref={cellsStripRef}
            onScroll={(e) => {
              if (programmaticScrollRef.current) return;
              window.dispatchEvent(
                new CustomEvent('michi:caption-scroll', {
                  detail: { scrollLeft: e.currentTarget.scrollLeft },
                }),
              );
            }}
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: cellsTemplateColumns,
              minWidth: 0,
              overflowX: overflowPanes ? 'auto' : 'hidden',
              // Match Dashboard's overflow-mode right padding so the caption
              // strip has the same scrollWidth as the pane strip — required
              // for the scroll-sync to stay aligned at the right edge.
              paddingRight: overflowPanes ? 'calc(50vw - 240px)' : 0,
              // Strip itself stays draggable — only the inline chip overrides
              // to no-drag. Empty cell space is window-drag region.
            }}
            className={overflowPanes ? 'hide-sb' : undefined}
          >
            {openPanes.map((id, i) => {
              const isFirst = i === 0;
              const isLast = i === openPanes.length - 1;
              const status = paneStatuses[i] ?? 'idle';
              const isCellFocused = focusedPane === id;
              // First cell needs to clear the floating Zone 1 (traffic lights
              // + 3 icons) when sidebar is collapsed; otherwise the title would
              // sit under it.
              const firstCellLeftPad = isFirst && sidebarCollapsed
                ? zone1Width
                : 0;
              return (
                <div
                  key={id}
                  onClick={() => focusPane(id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    minWidth: 0,
                    // 12px baseline so the chip never hugs the cell's left
                    // edge; first cell when sidebar is collapsed adds the
                    // traffic-light + zone-1 icon clearance on top.
                    paddingLeft: firstCellLeftPad + 12,
                    // First cell's left pad shrinks/grows opposite the sidebar
                    // spacer (zone1Width → 0 as spacer goes 0 → sidebar_width).
                    // Without a matching transition, padding flips instantly
                    // while spacer eases, so the title snaps to ~12px and then
                    // slides right — visible as a flicker on toggle.
                    // Dim/bright transition must match TPane's pane body
                    // (same --t-soft + --t-ease) so the caption cell fades in
                    // lockstep with the pane below — otherwise the title
                    // strip snaps while the pane crossfades, which reads as
                    // jank on focus changes. First cell additionally eases
                    // its left-pad to match the sidebar spacer animation.
                    transition: [
                      (isFirst && !sidebarResizing)
                        ? 'padding-left 150ms cubic-bezier(.4,0,.2,1)'
                        : null,
                      'opacity var(--t-soft) var(--t-ease)',
                      'filter var(--t-soft) var(--t-ease)',
                    ].filter(Boolean).join(', '),
                    borderRight: isLast || !prefs.paneRules ? 'none' : '1px solid var(--term-line)',
                    // Match TPane's dimming formula so the caption cell mirrors
                    // its pane below — unfocused panes get a dim title strip.
                    background: 'var(--term-pane-bg, var(--term-surface))',
                    opacity: focusedPane == null || isCellFocused ? 1 : 1 - prefs.focusDim / 100 * 0.5,
                    filter: focusedPane == null || isCellFocused ? 'none' : `brightness(${1 - prefs.focusDim / 100 * 0.6})`,
                  }}
                >
                  <PaneCaption
                    nodeId={id}
                    title={paneTitles[i] || 'thread'}
                    focused={focusedPane === id}
                    streaming={status === 'streaming'}
                    error={status === 'error'}
                    kind={paneKinds[i] === 'digest' ? 'digest' : paneKinds[i] === 'artifact' ? 'artifact' : 'chat'}
                    onFocus={focusPane}
                    onClose={closePane}
                    onCloseOthers={closeOtherPanes}
                    canCloseOthers={openPanes.length > 1}
                    onReorder={reorderPane}
                  />
                </div>
              );
            })}
          </div>
        )}
        {showWorkspaceTitle && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              // When the sidebar is collapsed, the floating Zone 1 (traffic
              // lights / brand + toggle + new + search) is absolutely
              // positioned over zone 2's left edge. Mirror the dashboard's
              // firstCellLeftPad so MAP/DIGEST · name doesn't slide under it.
              paddingLeft: (sidebarCollapsed ? zone1Width : 0) + 14,
              paddingRight: 14,
              minWidth: 0,
              flex: 1,
              fontFamily: 'var(--ui-font)',
              // Inherit the topbar's drag region so the empty space to the
              // right of the breadcrumb stays window-draggable. Interactive
              // children (BreadcrumbBackButton) opt out individually.
              WebkitAppRegion: 'drag',
              transition: sidebarResizing
                ? undefined
                : 'padding-left 150ms cubic-bezier(.4,0,.2,1)',
            } as React.CSSProperties}
          >
            {page !== 'workspace-manage' && (
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: '.14em',
                  color: 'var(--term-muted)',
                }}
              >
                {pageLabel}
              </span>
            )}
            {page !== 'workspace-manage' && page !== 'workspaces' && (
              <span style={{ color: 'var(--term-faint)', fontSize: 11 }}>·</span>
            )}
            {page === 'workspace-manage' ? (
              <BreadcrumbBackButton onClick={() => _onNav('workspaces')}>
                ‹ all workspaces
              </BreadcrumbBackButton>
            ) : page === 'workspaces' ? null : page === 'trash' ? (
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--term-mid)',
                  whiteSpace: 'nowrap',
                }}
              >
                {trashCount} deletion{trashCount === 1 ? '' : 's'}
              </span>
            ) : page === 'archived' ? (
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--term-mid)',
                  whiteSpace: 'nowrap',
                }}
              >
                {archivedCount} archived
              </span>
            ) : (
              <span
                title={activeProject!.name}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--term-fg)',
                  letterSpacing: '-.01em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {activeProject!.name}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Right cluster: Update banner (when available) + Contexts popover
          trigger. Absolutely positioned so it doesn't shrink zone-2 — that
          would make the caption grid narrower than the Dashboard grid below
          and dividers would no longer line up. Solid bg masks any caption
          text that scrolls under it in overflow mode. */}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 14px',
          background: topbarBg,
          opacity: rightmostUnfocused ? 1 - prefs.focusDim / 100 * 0.5 : 1,
          filter: rightmostUnfocused ? `brightness(${1 - prefs.focusDim / 100 * 0.6})` : 'none',
          // Match the pane caption + TPane body dim/bright transition so the
          // right-side floating strip (update chip / actions) fades in sync
          // with the rest when the rightmost pane focuses/blurs.
          transition: 'opacity var(--t-soft) var(--t-ease), filter var(--t-soft) var(--t-ease)',
        } as React.CSSProperties}
      >
        {updateAvailable && !updateDismissed && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                background: 'var(--term-accent)',
                color: 'var(--term-bg)',
                fontWeight: 700,
                borderRadius: 3,
                fontSize: 11,
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties}
            >
              <span
                onClick={handleUpdate}
                style={{ cursor: updating ? 'wait' : 'pointer' }}
              >
                {updating ? '⟳ Updating…' : '↑ Update & Restart'}
              </span>
              {!updating && (
                <IconBtn
                  onClick={() => setUpdateDismissed(true)}
                  style={{ opacity: 0.7, marginLeft: 4 }}
                >
                  ×
                </IconBtn>
              )}
            </span>
          )}
          <ArtifactsToggleButton onClick={toggleArtifacts} active={artifactsOpen} />
      </div>

      {popoverOpen && anchorRect && (
        <ContextsPopover
          anchorRect={anchorRect}
          anchorEl={contextsBtnRef.current}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  );
}

function Zone1IconButton({
  onClick,
  tooltip,
  tooltipKbd,
  'aria-label': ariaLabel,
  className,
  active,
  disabled,
  children,
}: {
  onClick: () => void;
  tooltip: string;
  tooltipKbd?: string;
  'aria-label': string;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const showHover = hover && !disabled;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        className={className}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: ZONE1_BUTTON_W,
          height: ZONE1_BUTTON_W,
          padding: '0 6px',
          background: active
            ? 'var(--term-select-f)'
            : showHover
            ? 'var(--term-hover-bg, var(--term-alt))'
            : 'transparent',
          border: 'none',
          borderRadius: 4,
          color: active ? 'var(--term-select)' : showHover ? 'var(--term-mid)' : 'var(--term-faint)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.3 : 1,
          transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease), opacity var(--t-quick) var(--t-ease)',
          flexShrink: 0,
        }}
      >
        {children}
      </button>
      {showHover && (
        <HeaderTooltip anchorRef={btnRef} label={tooltip} kbd={tooltipKbd} />
      )}
    </>
  );
}

function BrandHomeButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Go home"
      title="Home"
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        border: 'none',
        background: 'transparent',
        padding: 0,
        cursor: 'pointer',
        color: 'var(--term-fg)',
        fontFamily: 'inherit',
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: '-.01em',
        opacity: hover ? 1 : 0.85,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        transition: 'opacity var(--t-quick) var(--t-ease)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <img
        src="/michi-icon.png"
        alt=""
        width={26}
        height={26}
        style={{ display: 'block', flexShrink: 0, borderRadius: 6 }}
      />
      Michi
    </button>
  );
}

function BreadcrumbBackButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none',
        background: hover ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
        cursor: 'pointer',
        color: hover ? 'var(--term-fg)' : 'var(--term-muted)',
        fontFamily: 'var(--font-mono, var(--ui-font))',
        fontSize: 12,
        padding: '2px 6px',
        borderRadius: 4,
        transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

function ArtifactsToggleButton({ onClick, active }: { onClick: () => void; active?: boolean }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Artifacts"
      title={`Artifacts (${kbd('shift', 'mod', 'A')})`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: ZONE1_BUTTON_W,
        height: ZONE1_BUTTON_W,
        padding: '0 6px',
        background: active
          ? 'var(--term-select-f)'
          : hover
          ? 'var(--term-hover-bg, var(--term-alt))'
          : 'transparent',
        border: 'none',
        borderRadius: 4,
        color: active ? 'var(--term-select)' : hover ? 'var(--term-mid)' : 'var(--term-faint)',
        cursor: 'pointer',
        transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease)',
        flexShrink: 0,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <ArtifactsIcon size={14} />
    </button>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 2v12M2 8h12" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" />
    </svg>
  );
}

function UnreadIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

function NavBackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3 L5 8 L10 13" />
    </svg>
  );
}

function NavForwardIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3 L11 8 L6 13" />
    </svg>
  );
}
