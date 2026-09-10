import React, { useEffect, useState } from 'react';
import { useChatActions, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { useTerminalColors } from './useTerminalColors';
import TerminalSidebar from './Sidebar';
import TerminalTopbar from './Topbar';
import WarmFailedBanner from './WarmFailedBanner';
import AskUserAlertBar from './AskUserAlertBar';
import TerminalDashboard from './pages/Dashboard';
import TerminalHome from './pages/Home';
import NewWorkspaceDialog from '../NewWorkspaceDialog';
import { DrawerShell } from '../ui/DrawerShell';
import type { SettingsSection } from './pages/Settings';
import { usePrefs } from '../../state/prefs';
import type { PageId } from '../../state/commands';
import { PROFILE_PAGE_ENABLED } from '../../state/featureFlags';
import { setManageWorkspaceId, useManageWorkspaceId } from '../../state/manageRoute';
import { setManageAgentRoute, useManageAgentRoute } from '../../state/manageRoute';
import { useAgentDomain } from '../../state/agentDomain';
import { agentResourceKey, backendConnectionIdFromApiBase } from '../../state/agentIdentity';
import { activeBackendApiBase, backendConnectionIdForWorkspace, getKnownBackendConnections } from '../../config/backendConnections';
import { AgentEnableBlockedError, createAgentDefinition, deleteAgentDefinition, disableAgentDefinition, duplicateAgentDefinition, enableAgentDefinition, getAgentDefinition, updateAgentDefinition } from '../../services/api';
import type { AgentDefinitionDtoV1, AgentEnableBlockerV1, CreateAgentDefinitionRequestV1, RuntimeProfileV1 } from 'michi-shared';
import { AgentDefinitionStatus } from 'michi-shared';
import type { AgentDefinitionFormValue } from './agents/AgentDefinitionForm';
import type { ChatNodeState } from '../../state/chatTypes';
import { PanePresentationProvider } from './PanePresentation';

const NARROW_THRESHOLD = 700;
const TerminalMap = React.lazy(() => import('./pages/Map'));
const TerminalBranches = React.lazy(() => import('./pages/Branches'));
const TerminalDigest = React.lazy(() => import('./pages/Digest'));
const TerminalSettings = React.lazy(() => import('./pages/Settings'));
const ArtifactsDrawer = React.lazy(() => import('./ArtifactsDrawer'));
const TerminalWorkspaces = React.lazy(() => import('./pages/Workspaces'));
const TerminalWorkspaceManage = React.lazy(() => import('./pages/WorkspaceManage'));
const TerminalTrash = React.lazy(() => import('./pages/Trash'));
const TerminalArchived = React.lazy(() => import('./pages/Archived'));
const TerminalProfile = React.lazy(() => import('./pages/Profile'));
const AgentLibraryPage = React.lazy(() => import('./agents/AgentLibraryPage'));
const AgentEditorPage = React.lazy(() => import('./agents/AgentEditorPage'));
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
  const manageAgentRoute = useManageAgentRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [settingsPresent, setSettingsPresent] = useState(false);
  const [artifactsPresent, setArtifactsPresent] = useState(false);
  const [settingsMotion, setSettingsMotion] = useState<'standard' | 'instant'>('standard');
  const [artifactsMotion, setArtifactsMotion] = useState<'standard' | 'instant'>('standard');
  const inputMotion = React.useRef<'standard' | 'instant'>('standard');
  useEffect(() => {
    const keyboard = () => { inputMotion.current = 'instant'; };
    const pointer = () => { inputMotion.current = 'standard'; };
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => {
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('pointerdown', pointer, true);
    };
  }, []);
  // Branches/Map/Digest are thread-scoped views (and Workspaces a picker): a
  // second click on the same nav target — or a second ⌘M/⌘D/⌘O — drops back to
  // the conversation. Fixed destination on purpose: "back" means "back to the
  // thread", not browser-style history.
  const handleNav = React.useCallback((p: PageId) => {
    if (p === 'settings') { setSettingsMotion(inputMotion.current); setSettingsOpen((v) => !v); return; }
    const TOGGLE_PAGES: PageId[] = ['branches', 'map', 'digest', 'workspaces'];
    setPage((current) => (TOGGLE_PAGES.includes(p) && current === p ? 'dashboard' : p));
  }, []);
  const [newWsOpen, setNewWsOpen] = useState(false);

  useEffect(() => {
    const visible = page === 'dashboard' && !paletteOpen && !settingsOpen && !settingsPresent && !artifactsOpen && !artifactsPresent && !newWsOpen;
    window.dispatchEvent(new CustomEvent('michi:native-surfaces-visible', { detail: { visible } }));
  }, [page, paletteOpen, settingsOpen, settingsPresent, artifactsOpen, artifactsPresent, newWsOpen]);
  const {
    activeProject, selection,
    treeSelection,
    projects, hydrated,
    agentStatus,
    canNavBack, canNavForward,
  } = useChatProjects();
  const { openPanes, focusedPane, paneItems } = useChatPanes();
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
    navBack,
    navForward,
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

  // Pause all CSS animations when the tab is hidden (GPU idle).
  useEffect(() => {
    const sync = () => {
      if (document.hidden) document.documentElement.setAttribute('data-page-hidden', '');
      else document.documentElement.removeAttribute('data-page-hidden');
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      document.documentElement.removeAttribute('data-page-hidden');
    };
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
      // ⇧⌘A → Artifacts drawer (right side, same mechanism as Settings).
      // Routes through michi:toggle-artifacts so the shortcut, the topbar
      // button, and the sidebar row all share one toggle path.
      if (meta && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('michi:toggle-artifacts'));
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
      // ⌘; → toggle the Artifacts drawer (legacy Contexts shortcut; Contexts
      // are now artifacts). Goes through the same michi:toggle-artifacts event
      // as the topbar / sidebar buttons so there's a single toggle path. Works
      // inside inputs (the modifier means the user isn't typing a `;`).
      if (meta && !e.shiftKey && !e.altKey && e.key === ';') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('michi:toggle-artifacts'));
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
      // ⌘[ / ⌘] step back / forward through focused-chat history (browser-style;
      // crosses trees + workspaces). Placed before the isEditable gate — like
      // ⌘K/⌘W — so it works while a pane's composer is auto-focused. Guarded by
      // the store: no-op when the respective stack is empty.
      if (meta && !e.shiftKey && !e.altKey && e.key === '[') {
        e.preventDefault();
        if (canNavBack) {
          navBack();
          setPage('dashboard');
        }
        return;
      }
      if (meta && !e.shiftKey && !e.altKey && e.key === ']') {
        e.preventDefault();
        if (canNavForward) {
          navForward();
          setPage('dashboard');
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
      // Escape exits the thread-scoped fullscreen pages back to the
      // conversation — same destination as the topbar's ‹ back crumb. Runs
      // after the selection branch so a first Esc on the Map clears the
      // selection and a second one leaves the page.
      if (e.key === 'Escape' && (page === 'branches' || page === 'map' || page === 'digest')) {
        e.preventDefault();
        setPage('dashboard');
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
      // ⌥⌘U toggle sidebar Activity/Structure lens
      if (e.altKey && !e.shiftKey && (e.key === 'u' || e.key === 'U' || e.key === '¨')) {
        e.preventDefault();
        setPref('sidebarView', prefs.sidebarView === 'activity' ? 'structure' : 'activity');
        // Ensure sidebar is visible when toggling the lens
        if (prefs.sidebarCollapsed) setPref('sidebarCollapsed', false);
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
          void createBlankChild(focusedPane, { anchorMessageId: focusedLastMessageId })
            .then(() => setPage('dashboard'))
            .catch(() => {});
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
          setSettingsMotion('instant');
          setSettingsOpen((v) => !v);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, openPanes, focusedPane, focusedLastMessageId, reopenCandidate, focusPane, closePane, openPane, createBlankChild, restoreLastDeletion, selection, clearSelection, treeSelection, clearTreeSelection, selectAllTrees, prefs.sidebarCollapsed, setPref, handleNav, navBack, navForward, canNavBack, canNavForward]);

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
    const onEvt = () => { setArtifactsMotion(inputMotion.current); setArtifactsOpen((v) => !v); };
    window.addEventListener('michi:toggle-artifacts', onEvt as EventListener);
    return () => window.removeEventListener('michi:toggle-artifacts', onEvt as EventListener);
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

  // Auto-open new workspace dialog on first mount when there are no workspaces.
  // Held back until first-run setup is done AND the chosen runtime is usable
  // (no required key still missing) so the folder picker never stacks over the
  // FirstRunSetup card or the ApiKeyGate key window.
  const autoOpenedRef = React.useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!hydrated || projects.length !== 0) return;
    if (prefs.onboardingCompletedAt == null) return;
    if (agentStatus && agentStatus.capabilities.apiKeys && !agentStatus.hasRequiredKey) return;
    autoOpenedRef.current = true;
    setNewWsOpen(true);
  }, [hydrated, projects.length, prefs.onboardingCompletedAt, agentStatus]);

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

  // Hydration gate. Until the store finishes loading from the backend,
  // `projects` is empty — rendering the full shell here would paint a bogus
  // "no workspace" empty state (and race the auto-open dialog) during the
  // cold-start window where the backend isn't listening yet. Hold on a minimal
  // splash that reuses the shell's own background so there is no flash when the
  // real content lands. This is the view-layer half of the hydration barrier:
  // `hydrated` stays false until the backend actually answered, so an
  // unreachable backend keeps us here rather than flashing empty.
  if (!hydrated) {
    return (
      <div
        className="terminal-shell"
        style={{
          ...cssVars,
          width: '100%',
          height: '100%',
          background: 'var(--term-shell-bg, var(--term-bg))',
          color: 'var(--term-faint)',
          fontFamily: 'var(--ui-font)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          letterSpacing: '.04em',
        }}
      >
        <span className="term-hydrating">loading workspaces…</span>
      </div>
    );
  }

  return (
    <PanePresentationProvider ids={openPanes} items={paneItems} focusedPane={focusedPane} scope={`${activeProject?.id ?? ''}::${activeProject?.activeTreeId ?? ''}`} enabled={page === 'dashboard'}>
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
        artifactsOpen={artifactsOpen}
      />
      <WarmFailedBanner />
      <AskUserAlertBar onNav={handleNav} />
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
          {page === 'branches' && <LazyPage><TerminalBranches onNav={handleNav} /></LazyPage>}
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
          {page === 'agents' && <LazyPage><AgentManagementLibrary onNav={handleNav} /></LazyPage>}
          {page === 'agent-manage' && <LazyPage><AgentManagementEditor route={manageAgentRoute} onNav={handleNav} /></LazyPage>}
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
        onCreate={(name, cwd, folders, backendConnectionId) => {
          void createProject(name, cwd, folders, backendConnectionId);
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
        motion={settingsMotion}
        onPresenceChange={setSettingsPresent}
        onClose={() => { setSettingsMotion(inputMotion.current); setSettingsOpen(false); }}
        onNav={handleNav}
      />
      {(artifactsOpen || artifactsPresent) && (
        <React.Suspense fallback={null}>
          <ArtifactsDrawer key={activeProject?.id ?? 'none'} open={artifactsOpen} motion={artifactsMotion} onPresenceChange={setArtifactsPresent} onClose={() => { setArtifactsMotion(inputMotion.current); setArtifactsOpen(false); }} />
        </React.Suspense>
      )}
    </div>
    </PanePresentationProvider>
  );
}

function activeControlPlaneId(activeProject: ReturnType<typeof useChatProjects>['activeProject']): string {
  return activeProject
    ? backendConnectionIdForWorkspace(activeProject.id)
    : backendConnectionIdFromApiBase(activeBackendApiBase());
}

function AgentManagementLibrary({ onNav }: { onNav: (page: PageId) => void }) {
  const { activeProject, agentStatus } = useChatProjects();
  const { state, loadDefinitions, dispatch } = useAgentDomain();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [featureUnavailable, setFeatureUnavailable] = React.useState(false);
  const backendConnectionId = activeControlPlaneId(activeProject);
  const backendName = getKnownBackendConnections().find((connection) => connection.id === backendConnectionId)?.name ?? backendConnectionId;
  const customAgentsEnabled = agentStatus == null ? null : agentStatus.customAgentsEnabled === true;
  React.useEffect(() => {
    let cancelled = false;
    if (customAgentsEnabled === null) {
      setLoading(true);
      return;
    }
    if (!customAgentsEnabled) {
      setFeatureUnavailable(true);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    void loadDefinitions(activeProject?.id ?? null).then(() => {
      if (!cancelled) { setError(null); setFeatureUnavailable(false); }
    }).catch((reason) => {
      if (!cancelled) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const unavailable = message.includes('404');
        setFeatureUnavailable(unavailable);
        setError(unavailable ? null : message);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeProject?.id, backendConnectionId, customAgentsEnabled, loadDefinitions]);
  if (featureUnavailable && !loading) {
    return <div role="status" style={{ padding: 24, color: 'var(--term-muted)' }}>Custom Agents are not enabled on {backendName}.</div>;
  }
  const definitions = featureUnavailable ? [] : Object.values(state.definitions).filter((resource) => resource.backendConnectionId === backendConnectionId && (resource.value.scope === 'global' || resource.value.workspaceId === activeProject?.id));
  const runs = Object.values(state.runs).filter((resource) => resource.backendConnectionId === backendConnectionId && resource.value.workspaceId === activeProject?.id);
  const create = (scope: 'workspace' | 'global') => {
    setManageAgentRoute({ mode: 'create', scope, workspaceId: scope === 'workspace' ? activeProject?.id ?? null : null, backendConnectionId, definitionId: null });
    onNav('agent-manage');
  };
  const edit = (resource: (typeof definitions)[number]) => {
    setManageAgentRoute({ mode: 'edit', scope: resource.value.scope, workspaceId: resource.value.workspaceId, backendConnectionId: resource.backendConnectionId, definitionId: resource.value.id });
    onNav('agent-manage');
  };
  const update = async (identity: { backendConnectionId: string; id: string }, action: typeof enableAgentDefinition | typeof disableAgentDefinition | typeof duplicateAgentDefinition) => {
    try { dispatch({ type: 'upsert-definitions', resources: [await action(identity)] }); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><div style={{ padding: '7px 56px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>CONTROL PLANE · {backendName} ({backendConnectionId}){activeProject ? ` · WORKSPACE ${activeProject.name}` : ' · NO WORKSPACE SELECTED'}</div><AgentLibraryPage definitions={definitions} runs={runs} workspaceId={activeProject?.id ?? null} loading={loading} error={error} onCreate={create} onEdit={edit} onEnable={(identity) => { void update(identity, enableAgentDefinition); }} onDisable={(identity) => { void update(identity, disableAgentDefinition); }} onDuplicate={(identity) => { void update(identity, duplicateAgentDefinition); }} onDelete={(identity) => { void deleteAgentDefinition(identity).then(() => dispatch({ type: 'remove-definition', identity })).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }} /></div>;
}

function profileFromForm(value: AgentDefinitionFormValue['runtimeProfile']): RuntimeProfileV1 {
  return { version: 1, runtimeId: value.runtimeId.trim(), ...(value.providerId.trim() ? { providerId: value.providerId.trim() } : {}), ...(value.modelId.trim() ? { modelId: value.modelId.trim() } : {}), ...(value.reasoning ? { reasoning: value.reasoning } : {}), ...(value.modeId.trim() ? { modeId: value.modeId.trim() } : {}) };
}

function refs(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function requestFromForm(value: AgentDefinitionFormValue): CreateAgentDefinitionRequestV1 {
  return {
    version: 1, scope: value.scope, workspaceId: value.scope === 'workspace' ? value.workspaceId : null,
    name: value.name.trim(), description: value.description.trim(), instructions: value.instructions,
    runtimeProfile: profileFromForm(value.runtimeProfile), fallbackChain: value.fallbackChain.map(profileFromForm),
    toolRefs: refs(value.toolRefs), skillRefs: refs(value.skillRefs), mcpServerRefs: refs(value.mcpServerRefs),
    permissionPolicy: { version: 1, preset: value.permissionPolicy.preset, categories: value.permissionPolicy.categories, maxDelegationDepth: Number(value.permissionPolicy.maxDelegationDepth), maxConcurrentRuns: Number(value.permissionPolicy.maxConcurrentRuns), maxWallTimeMs: Number(value.permissionPolicy.maxWallTimeMinutes) * 60_000, maxAttempts: Number(value.permissionPolicy.maxAttempts) },
    contextPolicy: { version: 1, includeWorkspaceInstructions: value.includeWorkspaceInstructions, allowMessageContext: value.allowMessageContext, allowFileContext: value.allowFileContext, allowArtifactContext: value.allowArtifactContext, maxEstimatedChars: Number(value.maxContextChars) },
    defaultRunTtlMs: value.retention === 'indefinite' ? null : Number(value.defaultRunTtlMs),
  };
}

function AgentManagementEditor({ route, onNav }: { route: ReturnType<typeof useManageAgentRoute>; onNav: (page: PageId) => void }) {
  const { activeProject } = useChatProjects();
  const { state, dispatch } = useAgentDomain();
  const [error, setError] = React.useState<string | null>(null);
  const [blockers, setBlockers] = React.useState<AgentEnableBlockerV1[] | null>(null);
  const key = route?.definitionId ? agentResourceKey({ backendConnectionId: route.backendConnectionId, id: route.definitionId }) : '';
  const definition = key ? state.definitions[key] ?? null : null;
  React.useEffect(() => {
    if (!route || route.mode !== 'edit' || definition) return;
    void getAgentDefinition({ backendConnectionId: route.backendConnectionId, id: route.definitionId! })
      .then((resource) => dispatch({ type: 'upsert-definitions', resources: [resource] }))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [route, definition, dispatch]);
  if (!route) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--term-muted)' }}>Agent editor link is missing.</div>;
  if (route.mode === 'edit' && !definition && !error) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--term-muted)' }}>loading Agent…</div>;
  const persist = async (value: AgentDefinitionFormValue, enable: boolean) => {
    const currentBackend = activeControlPlaneId(activeProject);
    if (route.mode === 'create' && currentBackend !== route.backendConnectionId) throw new Error(`Control plane changed from ${route.backendConnectionId} to ${currentBackend}. Return to the Library before saving.`);
    const request = requestFromForm(value);
    let saved;
    if (definition) saved = await updateAgentDefinition({ backendConnectionId: definition.backendConnectionId, id: definition.value.id }, { ...request, expectedRevision: definition.value.revision });
    else saved = await createAgentDefinition(request, undefined, route.backendConnectionId);
    if (enable && saved.value.status !== AgentDefinitionStatus.Enabled) saved = await enableAgentDefinition({ backendConnectionId: saved.backendConnectionId, id: saved.value.id });
    dispatch({ type: 'upsert-definitions', resources: [saved] });
    setManageAgentRoute({ mode: 'edit', scope: saved.value.scope, workspaceId: saved.value.workspaceId, backendConnectionId: saved.backendConnectionId, definitionId: saved.value.id });
  };
  const identity = definition ? { backendConnectionId: definition.backendConnectionId, id: definition.value.id } : null;
  const execute = async (action: () => Promise<void>) => {
    try { await action(); setError(null); setBlockers(null); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBlockers(reason instanceof AgentEnableBlockedError ? reason.blockers : null);
    }
  };
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><div style={{ padding: '7px 56px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>CONTROL PLANE · {route.backendConnectionId}{route.workspaceId ? ` · WORKSPACE ${route.workspaceId}` : ' · GLOBAL'}</div><AgentEditorPage definition={definition} initialScope={route.scope} workspaceId={route.workspaceId} error={error} blockers={blockers} onCancel={() => onNav('agents')} onSaveDraft={(value) => execute(() => persist(value, false))} onEnable={(value) => execute(() => persist(value, true))} onDisable={identity ? () => execute(async () => { dispatch({ type: 'upsert-definitions', resources: [await disableAgentDefinition(identity)] }); }) : undefined} onDuplicate={identity ? () => execute(async () => { const copied = await duplicateAgentDefinition(identity); dispatch({ type: 'upsert-definitions', resources: [copied] }); setManageAgentRoute({ mode: 'edit', scope: copied.value.scope, workspaceId: copied.value.workspaceId, backendConnectionId: copied.backendConnectionId, definitionId: copied.value.id }); }) : undefined} onDelete={identity ? () => execute(async () => { await deleteAgentDefinition(identity); dispatch({ type: 'remove-definition', identity }); setManageAgentRoute(null); onNav('agents'); }) : undefined} /></div>;
}

function SettingsDrawer({ open, onClose, onNav, motion, onPresenceChange }: { open: boolean; onClose: () => void; onNav: (p: PageId) => void; motion: 'standard' | 'instant'; onPresenceChange: (present: boolean) => void }) {
  const [section, setSection] = useState<SettingsSection>('appearance');
  return (
    <DrawerShell open={open} onClose={onClose} title="Settings" width={620} motion={motion} onPresenceChange={onPresenceChange}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <LazyPage>
          <TerminalSettings section={section} onSectionChange={setSection} onNav={onNav} onClose={onClose} />
        </LazyPage>
      </div>
    </DrawerShell>
  );
}
