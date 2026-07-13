import React, { useEffect, useState } from 'react';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { useTerminalColors } from './useTerminalColors';
import TerminalSidebar from './Sidebar';
import TerminalTopbar from './Topbar';
import WarmFailedBanner from './WarmFailedBanner';
import TerminalDashboard from './pages/Dashboard';
import TerminalHome from './pages/Home';
import NewWorkspaceDialog from '../NewWorkspaceDialog';
import { usePrefs } from '../../state/prefs';
import type { PageId } from '../../state/commands';
import { PROFILE_PAGE_ENABLED } from '../../state/featureFlags';
import { setManageWorkspaceId, useManageWorkspaceId } from '../../state/manageRoute';
import type { ChatNodeState } from '../../state/chatTypes';

const NARROW_THRESHOLD = 700;
const TerminalMap = React.lazy(() => import('./pages/Map'));
const TerminalDigest = React.lazy(() => import('./pages/Digest'));
const TerminalSettings = React.lazy(() => import('./pages/Settings'));
const TerminalWorkspaces = React.lazy(() => import('./pages/Workspaces'));
const TerminalWorkspaceManage = React.lazy(() => import('./pages/WorkspaceManage'));
const TerminalTrash = React.lazy(() => import('./pages/Trash'));
const TerminalArchived = React.lazy(() => import('./pages/Archived'));
const TerminalProfile = React.lazy(() => import('./pages/Profile'));
const CommandPalette = React.lazy(() => import('./CommandPalette'));

function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense
      fallback={
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--term-muted)',
            fontSize: 12,
          }}
        >
          loading…
        </div>
      }
    >
      {children}
    </React.Suspense>
  );
}

export default function TerminalShell() {
  const cssVars = useTerminalColors();
  const [width, setWidth] = useState<number>(
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const [page, setPage] = useState<PageId>('home');
  const manageWorkspaceId = useManageWorkspaceId();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Remembers the page the user was on before opening Map/Digest/Workspaces,
  // so clicking the same nav button toggles back.
  const previousPageRef = React.useRef<PageId>('dashboard');
  const handleNav = React.useCallback((p: PageId) => {
    if (p === 'settings') { setSettingsOpen((v) => !v); return; }
    const TOGGLE_PAGES: PageId[] = ['map', 'digest', 'workspaces'];
    setPage((current) => {
      if (TOGGLE_PAGES.includes(p)) {
        if (current === p) {
          // Second click: return to the page we came from.
          return previousPageRef.current;
        }
        // First click: remember where we were and switch.
        previousPageRef.current = current;
        return p;
      }
      return p;
    });
  }, []);
  const [newWsOpen, setNewWsOpen] = useState(false);
  const {
    activeProject, openPanes, selection,
    focusedPane,
    treeSelection,
    projects, hydrated,
  } = useChatProjects();
  const {
    createProject,
    enterChatsWorkspace,
    focusPane,
    closePane,
    openPane,
    createBlankChild,
    restoreLastDeletion,
    clearSelection,
    clearTreeSelection,
    selectAllTrees,
  } = useChatActions();
  const { prefs, setPref } = usePrefs();

  const focusedLastMessageId = useStructuralSelector(
    React.useCallback((nodesMap: Record<string, ChatNodeState>) => {
      if (!focusedPane) return undefined;
      const messages = nodesMap[focusedPane]?.messages;
      return messages?.[messages.length - 1]?.id;
    }, [focusedPane]),
  );
  const reopenCandidate = useStructuralSelector(
    React.useCallback((nodesMap: Record<string, ChatNodeState>) => {
      if (!activeProject) return null;
      for (let i = activeProject.chatIds.length - 1; i >= 0; i -= 1) {
        const id = activeProject.chatIds[i];
        if (!openPanes.includes(id) && !nodesMap[id]?.deletedAt) return id;
      }
      return null;
    }, [activeProject, openPanes]),
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Mirror palette vars onto <html> so portal-rendered popups (SelectionActions
  // renders into document.body) can still resolve var(--term-*).
  useEffect(() => {
    const root = document.documentElement;
    const keys = Object.keys(cssVars);
    for (const k of keys) root.style.setProperty(k, cssVars[k]);
    return () => {
      for (const k of keys) root.style.removeProperty(k);
    };
  }, [cssVars]);

  // Keyboard shortcuts. Input-focus gated (except Ctrl+Tab for browser-style cycling).
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const t = el.tagName;
      return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // Ctrl+Tab cycles panes even while typing.
      if (e.ctrlKey && e.key === 'Tab' && openPanes.length > 1) {
        e.preventDefault();
        const cur = focusedPane ? openPanes.indexOf(focusedPane) : 0;
        const next = e.shiftKey
          ? (cur - 1 + openPanes.length) % openPanes.length
          : (cur + 1) % openPanes.length;
        focusPane(openPanes[next]);
        return;
      }
      // ⇧⌘F → unified command palette (same surface as ⌘K). Works inside inputs.
      if (meta && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘K toggles the palette. Works inside inputs so a second ⌘K dismisses
      // the open palette (whose own search input has focus).
      if (meta && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // ⌘F → dispatch per-pane find for the focused pane (works inside inputs).
      if (meta && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (focusedPane) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('michi:open-pane-find', { detail: { nodeId: focusedPane } }));
        }
        return;
      }
      // ⌘; → toggle Contexts popover. Works inside inputs (the modifier means
      // the user isn't typing a `;` into a field).
      if (meta && !e.shiftKey && !e.altKey && e.key === ';') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('michi:toggle-contexts'));
        return;
      }
      // ⌘W close focused pane. Must run before the isEditable gate: TPane
      // auto-focuses its composer textarea when becoming focused, so without
      // this the shortcut would be swallowed whenever the user click-switched
      // into a pane.
      if (meta && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        if (focusedPane) {
          e.preventDefault();
          closePane(focusedPane);
        }
        return;
      }
      if (isEditable(document.activeElement)) return;
      // Escape clears both node- and tree-level selection. They can coexist
      // (for example after selecting in Map, then entering manage mode), so
      // clear both in one pass instead of returning after the first set.
      if (e.key === 'Escape' && (selection.size > 0 || treeSelection.size > 0)) {
        e.preventDefault();
        if (selection.size > 0) clearSelection();
        if (treeSelection.size > 0) clearTreeSelection();
        return;
      }
      if (!meta) return;
      // ⌘A: select all trees (when not editing)
      if (!e.shiftKey && (e.key === 'a' || e.key === 'A') && treeSelection.size > 0) {
        e.preventDefault();
        selectAllTrees();
        return;
      }
      // ⌘Z restore last deletion (trash / undo).
      if (!e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        const restoredRoot = restoreLastDeletion();
        if (restoredRoot) {
          openPane(restoredRoot);
          setPage('dashboard');
        }
        return;
      }
      // ⌘B toggle sidebar
      if (!e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setPref('sidebarCollapsed', !prefs.sidebarCollapsed);
        return;
      }
      // ⌘P → open profile page (gated by VITE_MICHI_PROFILE_PAGE).
      if (PROFILE_PAGE_ENABLED && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setPage('profile');
        return;
      }
      // ⌘T new thread → open home (thread is created on first send)
      if (!e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        setPage('home');
        return;
      }
      // ⌘⌥T new blank branch (legacy ⌘T)
      if (e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T' || e.key === '†')) {
        if (focusedPane) {
          e.preventDefault();
          createBlankChild(focusedPane, { anchorMessageId: focusedLastMessageId });
          setPage('dashboard');
        }
        return;
      }
      // ⌘\ open the most-recent chat not already in a pane
      if (!e.shiftKey && e.key === '\\') {
        if (reopenCandidate) {
          e.preventDefault();
          openPane(reopenCandidate);
          setPage('dashboard');
        }
        return;
      }
      if (e.shiftKey) return;
      switch (e.key) {
        case '0':
          e.preventDefault();
          setPage('home');
          break;
        case '1':
          e.preventDefault();
          setPage('dashboard');
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          handleNav('map');
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          handleNav('digest');
          break;
        case 'o':
        case 'O':
          e.preventDefault();
          handleNav('workspaces');
          break;
        case ',':
          e.preventDefault();
          setSettingsOpen((v) => !v);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, openPanes, focusedPane, focusedLastMessageId, reopenCandidate, focusPane, closePane, openPane, createBlankChild, restoreLastDeletion, selection, clearSelection, treeSelection, clearTreeSelection, selectAllTrees, prefs.sidebarCollapsed, setPref, handleNav]);

  useEffect(() => {
    const onEvt = () => setNewWsOpen(true);
    window.addEventListener('michi:open-new-workspace', onEvt as EventListener);
    return () => window.removeEventListener('michi:open-new-workspace', onEvt as EventListener);
  }, []);

  useEffect(() => {
    const onEvt = () => setPage('home');
    window.addEventListener('michi:goto-home', onEvt as EventListener);
    return () => window.removeEventListener('michi:goto-home', onEvt as EventListener);
  }, []);

  useEffect(() => {
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent<{ page?: PageId }>).detail;
      if (detail?.page) handleNav(detail.page);
    };
    window.addEventListener('michi:nav-page', onEvt as EventListener);
    return () => window.removeEventListener('michi:nav-page', onEvt as EventListener);
  }, [handleNav]);

  useEffect(() => {
    const onOpenManage = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId) return;
      setManageWorkspaceId(detail.projectId);
      handleNav('workspace-manage');
    };
    window.addEventListener('michi:open-workspace-manage', onOpenManage as EventListener);
    return () => window.removeEventListener('michi:open-workspace-manage', onOpenManage as EventListener);
  }, [handleNav]);

  // Auto-open new workspace dialog on first mount when there are no workspaces
  const autoOpenedRef = React.useRef(false);
  useEffect(() => {
    if (!autoOpenedRef.current && hydrated && projects.length === 0) {
      autoOpenedRef.current = true;
      setNewWsOpen(true);
    }
  }, [hydrated, projects.length]);

  const narrowMode = width < NARROW_THRESHOLD;
  const [narrowOverlayOpen, setNarrowOverlayOpen] = useState(false);
  // Closing the overlay when the window grows back to wide.
  useEffect(() => {
    if (!narrowMode && narrowOverlayOpen) setNarrowOverlayOpen(false);
  }, [narrowMode, narrowOverlayOpen]);
  // Esc closes the overlay too.
  useEffect(() => {
    if (!narrowOverlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNarrowOverlayOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrowOverlayOpen]);

  // In narrow mode: the toggle controls the overlay rather than the persisted
  // pref. Going wide again restores the user's pref.
  const sidebarCollapsedEffective = narrowMode ? !narrowOverlayOpen : prefs.sidebarCollapsed;
  const handleToggleSidebarEffective = React.useCallback(() => {
    if (narrowMode) setNarrowOverlayOpen((v) => !v);
    else setPref('sidebarCollapsed', !prefs.sidebarCollapsed);
  }, [narrowMode, prefs.sidebarCollapsed, setPref]);
  // Auto-close overlay after navigation in narrow mode.
  const handleNavWithClose = React.useCallback((p: PageId) => {
    handleNav(p);
    if (narrowMode) setNarrowOverlayOpen(false);
  }, [handleNav, narrowMode]);

  return (
    <div
      className="terminal-shell"
      style={{
        ...cssVars,
        width: '100%',
        height: '100%',
        background: 'var(--term-shell-bg, var(--term-bg))',
        color: 'var(--term-fg)',
        fontFamily: 'var(--ui-font)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        padding: 'var(--term-shell-padding, 0px)',
        gap: 'var(--term-shell-gap, 0px)',
        boxSizing: 'border-box',
        // Clip drawer/overlay slide-in animations (e.g. SettingsDrawer's
        // slideInRight starts at translateX(100%), which would otherwise
        // overshoot the viewport right edge and flash a horizontal scrollbar
        // on Windows where scrollbars take up space.
        overflow: 'hidden',
      }}
    >
      <TerminalTopbar
        page={page}
        onNav={handleNav}
        sidebarCollapsed={sidebarCollapsedEffective}
        onToggleSidebar={handleToggleSidebarEffective}
        onNewThread={() => { setPage('home'); if (narrowMode) setNarrowOverlayOpen(false); }}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <WarmFailedBanner />
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 'var(--term-content-gap, 0px)', position: 'relative' }}>
        <TerminalSidebar
          activePage={page}
          onNav={narrowMode ? handleNavWithClose : handleNav}
          onOpenPalette={() => setPaletteOpen(true)}
          onNewThread={() => { setPage('home'); if (narrowMode) setNarrowOverlayOpen(false); }}
          narrowMode={narrowMode}
          narrowOverlayOpen={narrowOverlayOpen}
          onCloseOverlay={() => setNarrowOverlayOpen(false)}
        />
        <div className="terminal-content-col" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          {page === 'home' && <TerminalHome onSubmitted={() => setPage('dashboard')} />}
          {page === 'dashboard' && <TerminalDashboard />}
          {page === 'map' && <LazyPage><TerminalMap onNav={handleNav} /></LazyPage>}
          {page === 'digest' && <LazyPage><TerminalDigest onNav={handleNav} /></LazyPage>}
          {page === 'workspaces' && <LazyPage><TerminalWorkspaces onNav={handleNav} /></LazyPage>}
          {page === 'workspace-manage' && (
            <LazyPage>
              <TerminalWorkspaceManage workspaceId={manageWorkspaceId} onNav={handleNav} />
            </LazyPage>
          )}
          {page === 'trash' && <LazyPage><TerminalTrash onNav={handleNav} /></LazyPage>}
          {page === 'archived' && <LazyPage><TerminalArchived onNav={handleNav} /></LazyPage>}
          {page === 'profile' && PROFILE_PAGE_ENABLED && <LazyPage><TerminalProfile onNav={handleNav} /></LazyPage>}
        </div>
      </div>
      {paletteOpen && (
        <React.Suspense fallback={null}>
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            setPage={handleNav}
            activePage={page}
          />
        </React.Suspense>
      )}
      <NewWorkspaceDialog
        open={newWsOpen}
        onClose={() => setNewWsOpen(false)}
        onCreate={(name, cwd) => {
          void createProject(name, cwd);
          setNewWsOpen(false);
          setPage('home');
        }}
        onSkip={() => {
          void enterChatsWorkspace();
          setNewWsOpen(false);
          setPage('home');
        }}
      />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onNav={handleNav}
      />
    </div>
  );
}

function SettingsDrawer({ open, onClose, onNav }: { open: boolean; onClose: () => void; onNav: (p: PageId) => void }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          /* Faint dim so the frosted drawer reads as elevated above the panes. */
          background: 'color-mix(in srgb, var(--term-bg) 22%, transparent)',
          zIndex: 39,
        }}
      />
      <div
        className="terminal-settings-drawer term-glass"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '50vw',
          /* background comes from .term-glass (frosted); no opaque fill here. */
          borderLeft: 'var(--term-pane-divider, 1px solid var(--term-line))',
          borderTopLeftRadius: 'var(--term-pane-radius, 0px)',
          borderBottomLeftRadius: 'var(--term-pane-radius, 0px)',
          /* elevation (cast + inner highlight) comes from .term-glass box-shadow */
          display: 'flex',
          flexDirection: 'column',
          zIndex: 40,
          animation: 'slideInRight 200ms ease-out both',
        }}
      >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--term-line)',
          /* Transparent so the drawer frost runs continuously under the header;
             only the hairline divider marks the header band. */
          background: 'transparent',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 11,
            letterSpacing: '.14em',
            color: 'var(--term-muted)',
          }}
        >
          ▸ SETTINGS
        </span>
        <span
          onClick={onClose}
          title="Close (esc)"
          style={{
            cursor: 'pointer',
            fontFamily: 'var(--ui-font)',
            fontSize: 14,
            color: 'var(--term-mid)',
            padding: '0 4px',
          }}
        >
          ×
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <LazyPage>
          <TerminalSettings onNav={onNav} onClose={onClose} />
        </LazyPage>
      </div>
      </div>
    </>
  );
}
