import TerminalSettingsArea from './rail/SettingsMain';
import { deferredComponent } from '../deferredComponent';
import { useShellNavigation, type ShellLocation } from './useShellNavigation';
import { useLinkOpening } from './useLinkOpening';
import { useScheduledRunOpening } from './scheduled/useScheduledRunOpening';
import React, { useEffect, useState } from 'react';
import { useChatActions, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { paneScopeKey } from '../../state/paneState';
import { useTerminalColors } from './useTerminalColors';
import { useEdgeSwipe, useSwipeLeft } from '../../hooks/useEdgeSwipe';
import TerminalSidebar from './Sidebar';
import TerminalTopbar from './Topbar';
import { RemoteRecoveryDrawer, RemoteRecoveryIndicator } from '../RemoteRecoveryBanner';
import { RemoteAuthenticationDialog } from '../RemoteAuthenticationDialog';
import { RemoteServiceRecoveryMonitor } from '../RemoteServiceRecoveryMonitor';
import { useRemoteAuthentication } from '../../state/remoteAuthentication';
import WarmFailedBanner from './WarmFailedBanner';
import AskUserAlertBar from './AskUserAlertBar';
import TerminalDashboard from './pages/Dashboard';
import TerminalHome from './pages/Home';
import NewWorkspaceDialog from '../NewWorkspaceDialog';
import { NewWorkspaceAutoOpen } from './NewWorkspaceAutoOpen';
import { usePrefs } from '../../state/prefs';
import { DrawerShell } from '../ui/DrawerShell';
import { ModalShell } from '../ui/ModalShell';
import type { PageId } from '../../state/commands';
import { PROFILE_PAGE_ENABLED } from '../../state/featureFlags';
import { IS_MAC } from '../../lib/platform';
import { setManageWorkspaceId, useManageWorkspaceId } from '../../state/manageRoute';
import { setManageAgentRoute, useManageAgentRoute } from '../../state/manageRoute';
import { useAgentDomain } from '../../state/agentDomain';
import { agentResourceKey, backendConnectionIdFromApiBase } from '../../state/agentIdentity';
import { activeBackendApiBase, backendConnectionIdForWorkspace, getKnownBackendConnections } from '../../config/backendConnections';
import { AgentEnableBlockedError, createAgentDefinition, deleteAgentDefinition, disableAgentDefinition, duplicateAgentDefinition, enableAgentDefinition, getAgentDefinition, updateAgentDefinition } from '../../services/api';
import type { AgentEnableBlockerV1, CreateAgentDefinitionRequestV1, RuntimeProfileV1 } from 'michi-shared';
import { AgentDefinitionStatus } from 'michi-shared';
import type { AgentDefinitionFormValue } from './agents/AgentDefinitionForm';
import type { ChatNodeState } from '../../state/chatTypes';
import { PanePresentationProvider } from './PanePresentation';
import { PaneViewStateProvider } from './PaneViewState';
import { setPanePresenceDashboardVisible } from '../../state/panePresenceVisibility';
import { onOpenBackgroundWork, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';

import { REMOTE_DIAGNOSTIC_AGENT_EVENT, type DiagnosticAgentRequest } from '../../services/remoteDiagnosticAgent';
import { AssistantPanelHost, assistantPanelTakesEscape } from './assistant/AssistantPanel';
import { escapeIsForPage, isInAssistantPanel } from './escapeLayers';
import {
  closeAssistantPanel,
  getAssistantSnapshot,
  openAssistantPanel,
  toggleAssistantPanel,
} from '../../state/assistant/assistantStore';
import { isSystemWorkspace, withoutSystemWorkspaces } from '../../state/assistant/systemWorkspace';
import { useReturnFromSystemWorkspace } from '../../state/assistant/userWorkspace';
import { CreateSpaceDialog, OPEN_NATIVE_PAGE_EVENT, type NativePageRoute, type OpenNativePageRoute } from './spaces/SpacesPage';
import { SpacesSidebar, type SpacesSidebarCurrent } from './spaces/SpacesSidebar';
import { SpacesSettings } from './spaces/SpacesSettings';
import { SpaceConversationWatcher } from './spaces/conversation/SpaceConversationWatcher';
import { AreaRail, AreaTabs } from './rail/AreaRail';
import { useRailBadges } from './rail/useRailBadges';
import { ScheduledSidebar } from './rail/AreaSidebars';
import type { SettingsLevel } from './rail/SettingsMain';
import { openScheduledHome, requestScheduledJobDetail, setScheduledRoute, useScheduledRoute } from './scheduled/scheduledNav';
import { META_AGENT_PAGE_TITLE, OPEN_SETTINGS_SECTION_EVENT } from './scheduled/metaAgent/metaAgentNav';
import { useMetaAgentOverviewSnapshot } from './scheduled/metaAgent/useMetaAgentOverview';
import { SpacesMetaChat, useMetaChatWindow, type SpacesChatView } from './spaces/metaChat';
import { ALL_TASKS, SPACES_HOME, areaForPage, entryPageForArea, type ShellArea, type SpacesHomeTarget } from '../../state/shellArea';
import { settingsPageForRequest, type SettingsPage } from './rail/settingsPages';
import { SourcePopoverHost } from './source';
import { dismissSourceBack, openExactSourcePopover, registerSourceNavigator, type SourceOrigin } from '../../state/sourceNav/sourceNav';
import { useSpaceTopbar } from '../../state/pages/spaceTopbar';
import { OPEN_WORKSPACE_HOME_EVENT, isWorkspaceHomeTarget, type WorkspaceHomeTarget } from '../../state/pages/workspaceHomeNav';
import { OPEN_ALL_TASKS_EVENT } from '../../state/pages/allTasksNav';

function readSavedSpaceRoute(): NativePageRoute {
  try {
    const value = sessionStorage.getItem('michi.native-page-route');
    if (value) {
      const parsed = JSON.parse(value) as Partial<Extract<NativePageRoute, { type: 'space' }>>;
      if (typeof parsed.pageId === 'string' && typeof parsed.workspaceId === 'string' && typeof parsed.backendConnectionId === 'string') {
        return { type: 'space', pageId: parsed.pageId, workspaceId: parsed.workspaceId, backendConnectionId: parsed.backendConnectionId };
      }
    }
  } catch { /* session storage may be unavailable */ }
  return { type: 'spaces' };
}

const TerminalSpaces = React.lazy(() => import('./spaces/SpacesPage'));
const TerminalSpaceView = React.lazy(() => import('./spaces/SpaceView'));

const NARROW_THRESHOLD = 700;
const TerminalMap = deferredComponent<{ onNav: (page: PageId) => void }>(() => import('./pages/Map'), <PageLoading />);
const TerminalBranches = React.lazy(() => import('./pages/Branches'));
const TerminalDigest = React.lazy(() => import('./pages/Digest'));
const ArtifactsDrawer = React.lazy(() => import('./ArtifactsDrawer'));
const BackgroundWorkDrawer = React.lazy(() => import('./backgroundWork/BackgroundWorkDrawer'));
const TerminalWorkspaces = deferredComponent<{ onNav: (page: PageId) => void }>(() => import('./pages/Workspaces'), <PageLoading />);
const TerminalWorkspaceManage = React.lazy(() => import('./pages/WorkspaceManage'));
const TerminalTrash = React.lazy(() => import('./pages/Trash'));
const TerminalArchived = React.lazy(() => import('./pages/Archived'));
const TerminalProfile = React.lazy(() => import('./pages/Profile'));
const TerminalScheduled = React.lazy(() => import('./pages/Scheduled'));
const TerminalMetaAgentScheduled = React.lazy(() => import('./scheduled/metaAgent/MetaAgentDetail'));
const AgentLibraryPage = React.lazy(() => import('./agents/AgentLibraryPage'));
const AgentEditorPage = React.lazy(() => import('./agents/AgentEditorPage'));
const CommandPalette = React.lazy(() => import('./CommandPalette'));

function PageLoading() {
  return <div role="status" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--term-muted)', fontSize: 'var(--fs-md)' }}>loading…</div>;
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<PageLoading />}>{children}</React.Suspense>;
}

export default function TerminalShell() {
  const cssVars = useTerminalColors();
  const [width, setWidth] = useState<number>(
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const [spaceRoute, setSpaceRoute] = useState<NativePageRoute>(readSavedSpaceRoute);
  const [page, setPage] = useState<PageId>(() => {
    const saved = readSavedSpaceRoute();
    return saved.type === 'space' ? 'space' : 'home';
  });
  const area = areaForPage(page);
  const [spacesHome, setSpacesHome] = useState<SpacesHomeTarget>(SPACES_HOME);
  const [spacesSettingsOpen, setSpacesSettingsOpen] = useState(false);
  const spacesSettingsReturnPage = React.useRef<PageId>('spaces');
  // Settings reopens on the page it was left on (rail/settingsPages.ts).
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('appearance');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPresent, setSettingsPresent] = useState(false);
  // A phone's Settings drawer shows one level at a time: the page list, then
  // one page. Opening it plainly starts on the list; a request for one page
  // opens on that page. Back to the list once the drawer is gone.
  const [settingsView, setSettingsView] = useState<SettingsLevel>('menu');
  useEffect(() => {
    if (!settingsOpen && !settingsPresent) setSettingsView('menu');
  }, [settingsOpen, settingsPresent]);
  const scheduledRoute = useScheduledRoute();
  const scheduledJobId = scheduledRoute.kind === 'job' ? scheduledRoute.jobId : null;
  const metaAgentOpen = scheduledRoute.kind === 'meta-agent';
  const metaAgentOverview = useMetaAgentOverviewSnapshot();
  // Managed jobs redirect to the system detail; their intermediate route is
  // not a destination to revisit with Back, even if opened before data loaded.
  const isScheduledJobLive = React.useCallback((jobId: string) =>
    metaAgentOverview.kind !== 'ready' || !metaAgentOverview.overview.managedJobIds?.includes(jobId), [metaAgentOverview]);
  useEffect(() => {
    const onSection = (event: Event) => {
      const requested = settingsPageForRequest((event as CustomEvent<{ section?: unknown }>).detail?.section);
      if (requested) {
        setSettingsPage(requested);
        setSettingsView('section');
        setSettingsOpen(true);
      }
    };
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
  }, []);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  // Above everything that unmounts when leaving Spaces: the window keeps its form and box.
  const chat = useMetaChatWindow();
  const lastConversationPageRef = React.useRef<PageId>(page);
  useEffect(() => { if (areaForPage(page) === 'conversations') lastConversationPageRef.current = page; }, [page]);
  React.useLayoutEffect(() => {
    setPanePresenceDashboardVisible(page === 'dashboard');
    return () => setPanePresenceDashboardVisible(false);
  }, [page]);
  const manageWorkspaceId = useManageWorkspaceId();
  const manageAgentRoute = useManageAgentRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsPresent, setArtifactsPresent] = useState(false);
  // Background work drawer: opened only by a user click (pane-title badge,
  // in-chat subagent/workflow card) through michi:open-background-work.
  const [backgroundWork, setBackgroundWork] = useState<{ request: OpenBackgroundWorkDetail; seq: number } | null>(null);
  const [backgroundWorkOpen, setBackgroundWorkOpen] = useState(false);
  const [backgroundWorkPresent, setBackgroundWorkPresent] = useState(false);
  const remoteAuthenticationOpen = !!useRemoteAuthentication();
  const [remoteRecoveryOpen, setRemoteRecoveryOpen] = useState(false);
  const [remoteRecoveryPresent, setRemoteRecoveryPresent] = useState(false);
  const openRemoteRecovery = React.useCallback(() => setRemoteRecoveryOpen(true), []);
  const closeRemoteRecovery = React.useCallback(() => setRemoteRecoveryOpen(false), []);
  // Branches/Map/Digest are thread-scoped views (and Workspaces a picker): a
  // second click on the same nav target — or a second ⌘M/⌘D/⌘O — drops back to
  // the conversation. Fixed destination on purpose: "back" means "back to the
  // thread", not browser-style history.
  const handleNav = React.useCallback((p: PageId) => {
    // Old navigation events may still refer to the removed All threads page.
    if (p === 'threads') p = 'home';
    if (p === 'settings') { setSettingsOpen(open => !open); return; }
    setSpacesSettingsOpen(false);
    setSettingsOpen(false);
    const TOGGLE_PAGES: PageId[] = ['branches', 'map', 'digest', 'workspaces'];
    if (p === 'spaces') {
      const route: NativePageRoute = { type: 'spaces' };
      setSpacesHome(SPACES_HOME);
      setSpaceRoute(route);
      try { sessionStorage.setItem('michi.native-page-route', JSON.stringify(route)); } catch { /* optional session restore */ }
    }
    setPage((current) => (TOGGLE_PAGES.includes(p) && current === p ? 'dashboard' : p));
  }, []);
  const openSpaceRoute = React.useCallback((route: NativePageRoute) => {
    setSpacesSettingsOpen(false);
    setSpaceRoute(route);
    setPage(route.type === 'space' ? 'space' : 'spaces');
    try { sessionStorage.setItem('michi.native-page-route', JSON.stringify(route)); } catch { /* optional session restore */ }
  }, []);
  const selectArea = React.useCallback((next: ShellArea) => {
    if (next === 'settings') { handleNav('settings'); return; }
    setSettingsOpen(false);
    setSpacesSettingsOpen(false);
    if (next === 'spaces') { handleNav('spaces'); return; }
    if (next === 'scheduled') openScheduledHome();
    setPage(entryPageForArea(next, lastConversationPageRef.current));
  }, [handleNav]);
  React.useEffect(() => {
    const onOpenPage = (event: Event) => {
      const detail = (event as CustomEvent<OpenNativePageRoute>).detail;
      if (!detail || typeof detail.pageId !== 'string' || typeof detail.workspaceId !== 'string' || typeof detail.backendConnectionId !== 'string') return;
      openSpaceRoute({ type: 'space', ...detail });
    };
    window.addEventListener(OPEN_NATIVE_PAGE_EVENT, onOpenPage);
    return () => window.removeEventListener(OPEN_NATIVE_PAGE_EVENT, onOpenPage);
  }, [openSpaceRoute]);
  const openWorkspaceHome = React.useCallback((target: WorkspaceHomeTarget) => {
    setSpacesSettingsOpen(false);
    setSpacesHome({ kind: 'workspace', workspaceId: target.workspaceId, backendConnectionId: target.backendConnectionId });
    setPage('spaces');
  }, []);
  React.useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isWorkspaceHomeTarget(detail)) return;
      event.preventDefault();
      openWorkspaceHome(detail);
    };
    window.addEventListener(OPEN_WORKSPACE_HOME_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_WORKSPACE_HOME_EVENT, onRequest);
  }, [openWorkspaceHome]);
  const openAllTasks = React.useCallback(() => {
    setSpacesSettingsOpen(false);
    setSpacesHome(ALL_TASKS);
    setPage('spaces');
  }, []);
  React.useEffect(() => {
    window.addEventListener(OPEN_ALL_TASKS_EVENT, openAllTasks);
    return () => window.removeEventListener(OPEN_ALL_TASKS_EVENT, openAllTasks);
  }, [openAllTasks]);
  const [newWsOpen, setNewWsOpen] = useState(false);

  useEffect(() => {
    const visible = page === 'dashboard' && !paletteOpen && !settingsOpen && !settingsPresent && !artifactsOpen && !artifactsPresent
      && !backgroundWorkOpen && !backgroundWorkPresent && !newWsOpen && !remoteAuthenticationOpen && !remoteRecoveryOpen && !remoteRecoveryPresent;
    document.documentElement.dataset.nativeSurfacesVisible = String(visible);
    window.dispatchEvent(new CustomEvent('michi:native-surfaces-visible', { detail: { visible } }));
  }, [page, paletteOpen, settingsOpen, settingsPresent, artifactsOpen, artifactsPresent, backgroundWorkOpen, backgroundWorkPresent, newWsOpen, remoteAuthenticationOpen, remoteRecoveryOpen, remoteRecoveryPresent]);
  const {
    activeProject, selection,
    treeSelection,
    projects, hydrated,
    agentStatus,
  } = useChatProjects();
  const { openPanes, tabPanes, pagePane, focusedPane, paneItems } = useChatPanes();
  const spacesChatView = React.useMemo<SpacesChatView>(() => {
    if (page === 'space' && spaceRoute.type === 'space') {
      return { kind: 'page', backendConnectionId: spaceRoute.backendConnectionId, workspaceId: spaceRoute.workspaceId, pageId: spaceRoute.pageId };
    }
    if (spacesHome.kind === 'workspace') {
      return { kind: 'workspace', workspaceId: spacesHome.workspaceId, name: projects.find((p) => p.id === spacesHome.workspaceId)?.name ?? 'Workspace' };
    }
    return { kind: 'home' };
  }, [page, spaceRoute, spacesHome, projects]);
  // Single-page mode hides every tab but the page; cycling and reopening
  // still treat all of them as open.
  const slotPanes = tabPanes ?? openPanes;
  const {
    createProject,
    enterChatsWorkspace,
    createThread,
    sendMessage,
    focusPane,
    closePane,
    openPane,
    createBlankChild,
    restoreLastDeletion,
    clearSelection,
    clearTreeSelection,
    selectAllTrees,
    openPaneInTree,
    activateTree,
    setFocusedNodeId,
    selectProject,
    revealBackendNode,
  } = useChatActions();
  const location = React.useMemo<ShellLocation>(() => ({
    page, spaceRoute, spacesHome, scheduledRoute,
    chat: page === 'dashboard' && focusedPane && activeProject?.activeTreeId && activeProject.chatIds.includes(focusedPane)
      ? { nodeId: focusedPane, projectId: activeProject.id, treeId: activeProject.activeTreeId } : null,
  }), [page, spaceRoute, spacesHome, scheduledRoute, focusedPane, activeProject]);
  const restoreLocation = React.useCallback((target: ShellLocation) => {
    setSettingsOpen(false);
    setSpacesSettingsOpen(false);
    setSpaceRoute(target.spaceRoute);
    setSpacesHome(target.spacesHome);
    if (target.page === 'scheduled') setScheduledRoute(target.scheduledRoute);
    setPage(target.page);
    if (target.page === 'space' || target.page === 'spaces') {
      try { sessionStorage.setItem('michi.native-page-route', JSON.stringify(target.page === 'space' ? target.spaceRoute : { type: 'spaces' })); } catch { /* optional session restore */ }
    }
  }, []);
  const deletedNodeIdsKey = useStructuralSelector(React.useCallback((nodes: Record<string, ChatNodeState>) =>
    Object.entries(nodes).filter(([, node]) => node.deletedAt).map(([id]) => id).sort().join('\0'), []));
  const isChatLive = React.useCallback((entry: { nodeId: string; projectId: string }) => {
    const project = projects.find(item => item.id === entry.projectId);
    return !!project && !project.deletedAt && project.chatIds.includes(entry.nodeId) && !deletedNodeIdsKey.split('\0').includes(entry.nodeId);
  }, [projects, deletedNodeIdsKey]);
  const navigation = useShellNavigation({
    location, hydrated, restore: restoreLocation, isChatLive, isScheduledJobLive,
    deps: { projects, activeProjectId: activeProject?.id ?? null, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId },
  });
  const { canBack: canNavBack, canForward: canNavForward, onBack: navBack, onForward: navForward } = navigation;
  // Overview, Map and Digest show the active workspace's thread: with the
  // assistant's hidden workspace active they return to the user's (as Home does).
  useReturnFromSystemWorkspace(page === 'branches' || page === 'map' || page === 'digest', activeProject, projects, selectProject);
  useLinkOpening();
  // Source links jump from Spaces to a conversation; the shell knows what Spaces
  // shows (for "Back to <page>") and how to return to it.
  const spaceTopbar = useSpaceTopbar();
  const sourceOriginRef = React.useRef<SourceOrigin | null>(null);
  sourceOriginRef.current = page === 'space' && spaceRoute.type === 'space'
    ? { kind: 'page', backendConnectionId: spaceRoute.backendConnectionId, workspaceId: spaceRoute.workspaceId, pageId: spaceRoute.pageId, title: spaceTopbar?.title ?? 'page' }
    : page === 'spaces' && spacesHome.kind === 'workspace'
      ? { kind: 'workspace', backendConnectionId: spacesHome.backendConnectionId, workspaceId: spacesHome.workspaceId, title: projects.find((p) => p.id === spacesHome.workspaceId)?.name ?? 'Workspace' }
      : page === 'spaces' && spacesHome.kind === 'all-tasks' ? { kind: 'all-tasks', title: 'All tasks' }
      : page === 'spaces' ? { kind: 'home', title: 'Home' } : null;
  const returnToOriginRef = React.useRef<(origin: SourceOrigin) => void>(() => {});
  returnToOriginRef.current = (origin) => {
    if (origin.kind === 'page') openSpaceRoute({ type: 'space', backendConnectionId: origin.backendConnectionId, workspaceId: origin.workspaceId, pageId: origin.pageId });
    else if (origin.kind === 'workspace') { setSpacesHome({ kind: 'workspace', backendConnectionId: origin.backendConnectionId, workspaceId: origin.workspaceId }); setPage('spaces'); }
    else if (origin.kind === 'all-tasks') openAllTasks();
    else handleNav('spaces');
  };
  React.useEffect(() => registerSourceNavigator({
    currentOrigin: () => sourceOriginRef.current,
    reveal: revealBackendNode,
    returnTo: (origin) => returnToOriginRef.current(origin),
  }), [revealBackendNode]);
  React.useEffect(() => { if (area === 'spaces') dismissSourceBack(); }, [area]);
  const openSpaceSource = React.useCallback((source: { nodeId: string; turnId: string; assistantId: string }) => {
    if (spaceRoute.type !== 'space') return false;
    return openExactSourcePopover(spaceRoute, source, { page: { ...spaceRoute, title: spaceTopbar?.title ?? 'page' } });
  }, [spaceRoute, spaceTopbar?.title]);
  const [diagnosticRequest, setDiagnosticRequest] = useState<{ projectId: string; request: DiagnosticAgentRequest } | null>(null);
  const diagnosticPending = React.useRef(false);
  useEffect(() => {
    const handle = (event: Event) => {
      const request = (event as CustomEvent<DiagnosticAgentRequest>).detail;
      event.preventDefault();
      if (diagnosticPending.current) { request.reject(new Error('A diagnostic conversation is already opening.')); return; }
      diagnosticPending.current = true;
      void enterChatsWorkspace().then(projectId => setDiagnosticRequest({ projectId, request })).catch(error => {
        diagnosticPending.current = false; request.reject(error instanceof Error ? error : new Error(String(error)));
      });
    };
    window.addEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle);
    return () => window.removeEventListener(REMOTE_DIAGNOSTIC_AGENT_EVENT, handle);
  }, [enterChatsWorkspace]);
  useEffect(() => {
    if (!diagnosticRequest || !diagnosticPending.current || activeProject?.id !== diagnosticRequest.projectId) return;
    diagnosticPending.current = false;
    setDiagnosticRequest(null);
    const { request } = diagnosticRequest;
    try {
      if (request.cancelled) return;
      if (activeProject.backendConnectionId && activeProject.backendConnectionId !== 'local') throw new Error('Diagnostics require a local workspace.');
      const nodeId = createThread();
      if (!nodeId) throw new Error('Could not create a local diagnostic conversation.');
      sendMessage(nodeId, request.prompt, request.binding);
      setSettingsOpen(false); setNewWsOpen(false); setRemoteRecoveryOpen(false); setPage('dashboard');
      request.resolve();
    } catch (error) { request.reject(error instanceof Error ? error : new Error(String(error))); }
  }, [diagnosticRequest, activeProject, createThread, sendMessage]);
  useScheduledRunOpening({ hydrated, onNav: handleNav });
  const { prefs, setPref } = usePrefs();
  const drawerMotion = prefs.reduceMotion ? 'instant' as const : 'standard' as const;

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
        if (!slotPanes.includes(id) && !nodesMap[id]?.deletedAt) return id;
      }
      return null;
    }, [activeProject, slotPanes]),
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
      if (remoteAuthenticationOpen) return;
      // The recovery drawer owns keyboard interaction, including Escape.
      if (remoteRecoveryOpen) return;
      const meta = e.metaKey || e.ctrlKey;
      // Settings is an overlay: toggling it never navigates the page below it.
      if (meta && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(open => !open);
        return;
      }
      if (settingsOpen) return;
      // Shell preferences are safe before hydration; workspace commands are not.
      if (!hydrated) {
        if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          setPref('sidebarCollapsed', !prefs.sidebarCollapsed);
        }
        return;
      }
      // Ctrl+Tab cycles panes even while typing.
      if (e.ctrlKey && e.key === 'Tab' && slotPanes.length > 1) {
        e.preventDefault();
        const cur = focusedPane ? slotPanes.indexOf(focusedPane) : 0;
        const next = e.shiftKey
          ? (cur - 1 + slotPanes.length) % slotPanes.length
          : (cur + 1) % slotPanes.length;
        focusPane(slotPanes[next]);
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
      // ⌘J toggles the assistant panel — inside inputs too, like ⌘K. Without
      // an assistant on this backend it does nothing. In Spaces it minimizes
      // or restores the Meta agent window instead.
      if (meta && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        if (areaForPage(page) === 'spaces') {
          chat.toggleMinimized();
          return;
        }
        // The assistant open as a pane on screen goes back to the floating
        // panel: the pane closes (back to the user's workspace) and the panel
        // opens on the same conversation.
        const assistantNodeId = getAssistantSnapshot().info?.nodeId;
        if (page === 'dashboard' && assistantNodeId && openPanes.includes(assistantNodeId)) {
          closePane(assistantNodeId);
          openAssistantPanel();
          return;
        }
        toggleAssistantPanel();
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
        // Typing in the assistant panel: ⌘W closes the panel, not a pane.
        if (isInAssistantPanel(document.activeElement)) {
          e.preventDefault();
          closeAssistantPanel();
          return;
        }
        if (focusedPane) {
          e.preventDefault();
          closePane(focusedPane);
        }
        return;
      }
      // ⌘[ / ⌘] step back / forward through visible page/chat history (browser-style;
      // crosses trees + workspaces). Placed before the isEditable gate — like
      // ⌘K/⌘W — so it works while a pane's composer is auto-focused. Guarded by
      // the store: no-op when the respective stack is empty.
      if (meta && !e.shiftKey && !e.altKey && e.key === '[') {
        e.preventDefault();
        if (canNavBack) {
          navBack();
        }
        return;
      }
      if (meta && !e.shiftKey && !e.altKey && e.key === ']') {
        e.preventDefault();
        if (canNavForward) {
          navForward();
        }
        return;
      }
      const typing = isEditable(document.activeElement);
      // ⌘T / ⌘⌥T also run before the isEditable gate, like ⌘W: TPane
      // refocuses its composer when a reply finishes, which is exactly when
      // users reach for them. While typing on macOS only ⌘ counts, because
      // Ctrl+T is the system "transpose characters" binding in text fields.
      const tMod = typing && IS_MAC ? e.metaKey : meta;
      // ⌘T new thread → open home (thread is created on first send)
      if (tMod && !e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        setPage('home');
        return;
      }
      // ⌘⌥T new blank branch (legacy ⌘T)
      if (tMod && e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T' || e.key === '†')) {
        // Never a branch of the assistant: it would land in its hidden workspace.
        const assistantPane = !!focusedPane && projects.some((p) => isSystemWorkspace(p) && p.chatIds.includes(focusedPane));
        if (focusedPane && !assistantPane) {
          e.preventDefault();
          // The new pane mounts already focused, so TPane won't pull focus
          // into it. Blur so typing doesn't land in the parent's composer.
          if (typing) (document.activeElement as HTMLElement).blur();
          void createBlankChild(focusedPane, { anchorMessageId: focusedLastMessageId })
            .then(() => setPage('dashboard'))
            .catch(() => {});
        }
        return;
      }
      if (typing) return;
      // Escape on the page closes the ⌘J panel floating over it first (the
      // panel handles Escape inside itself; an open menu or dialog keeps it).
      if (assistantPanelTakesEscape(e)) {
        e.preventDefault();
        closeAssistantPanel();
        return;
      }
      // What follows (clearing the selection, leaving the page) is for an Esc
      // on the page itself: not one pressed in the ⌘J panel or that another
      // layer took, nor while a menu, a dialog or another Esc layer is open,
      // whose own listener may run after this one.
      if (e.key === 'Escape' && !escapeIsForPage(e, 'all')) return;
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
      // conversation — same destination as the topbar's
      // ‹ back crumb. Runs after the selection branch so a first Esc on the
      // Map clears the selection and a second one leaves the page.
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
      // ⌘B toggle sidebar (Profile owns a fullscreen navigation rail).
      if (page !== 'profile' && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setPref('sidebarCollapsed', !prefs.sidebarCollapsed);
        return;
      }
      // ⌥⌘U toggle sidebar Activity/Structure lens
      if (page !== 'profile' && e.altKey && !e.shiftKey && (e.key === 'u' || e.key === 'U' || e.key === '¨')) {
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hydrated, page, openPanes, slotPanes, focusedPane, focusedLastMessageId, reopenCandidate, focusPane, closePane, openPane, createBlankChild, restoreLastDeletion, selection, clearSelection, treeSelection, clearTreeSelection, selectAllTrees, prefs.sidebarCollapsed, setPref, handleNav, navBack, navForward, canNavBack, canNavForward, remoteAuthenticationOpen, remoteRecoveryOpen, settingsOpen, projects, chat.toggleMinimized]);

  useEffect(() => {
    const onEvt = () => { if (hydrated) setNewWsOpen(true); };
    window.addEventListener('michi:open-new-workspace', onEvt as EventListener);
    return () => window.removeEventListener('michi:open-new-workspace', onEvt as EventListener);
  }, [hydrated]);

  useEffect(() => {
    const onEvt = () => { if (hydrated) setArtifactsOpen((v) => !v); };
    window.addEventListener('michi:toggle-artifacts', onEvt as EventListener);
    return () => window.removeEventListener('michi:toggle-artifacts', onEvt as EventListener);
  }, [hydrated]);

  useEffect(() => onOpenBackgroundWork((request) => {
    if (!hydrated) return;
    setBackgroundWork((current) => ({ request, seq: (current?.seq ?? 0) + 1 }));
    setBackgroundWorkOpen(true);
  }), [hydrated]);
  // The drawer shows one conversation of the active workspace. Once the
  // active workspace changes or no longer owns it (moved, removed), the
  // request no longer applies: close the drawer rather than show the old
  // conversation inside another workspace.
  const backgroundWorkOwned = !!backgroundWork && !!activeProject
    && activeProject.chatIds.includes(backgroundWork.request.nodeId);
  const backgroundWorkShown = backgroundWorkOpen && backgroundWorkOwned;
  useEffect(() => {
    if (backgroundWorkOpen && !backgroundWorkOwned) setBackgroundWorkOpen(false);
  }, [backgroundWorkOpen, backgroundWorkOwned]);

  useEffect(() => {
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent<{ page?: PageId }>).detail;
      if (detail?.page === 'settings') setSettingsOpen(true);
      else if (detail?.page) handleNav(detail.page);
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
  // (NewWorkspaceAutoOpen). Held back until first-run setup is done AND the chosen
  // runtime is usable (no required key still missing) so the folder picker
  // never stacks over the FirstRunSetup card or the ApiKeyGate key window.
  // The assistant's system workspace isn't one of the user's.
  const userProjectCount = React.useMemo(() => withoutSystemWorkspaces(projects).length, [projects]);
  const autoOpenReady = hydrated
    && userProjectCount === 0
    && prefs.onboardingCompletedAt != null
    && !(agentStatus && agentStatus.capabilities.apiKeys && !agentStatus.hasRequiredKey);
  const autoOpenNewWorkspace = React.useCallback(() => setNewWsOpen(true), []);

  const narrowMode = width < NARROW_THRESHOLD;
  const [narrowOverlayOpen, setNarrowOverlayOpen] = useState(false);
  // Closing the overlay when the window grows back to wide.
  useEffect(() => {
    if (!narrowMode && narrowOverlayOpen) setNarrowOverlayOpen(false);
  }, [narrowMode, narrowOverlayOpen]);
  // Profile suppresses the app sidebar. Clear any open narrow overlay while
  // it is hidden so it cannot reappear over the destination page on exit.
  React.useLayoutEffect(() => {
    if (page === 'profile' && narrowOverlayOpen) setNarrowOverlayOpen(false);
  }, [page, narrowOverlayOpen]);
  // Esc closes the overlay too.
  useEffect(() => {
    if (!narrowOverlayOpen || remoteAuthenticationOpen || remoteRecoveryOpen || settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNarrowOverlayOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrowOverlayOpen, remoteAuthenticationOpen, remoteRecoveryOpen, settingsOpen]);

  // Profile owns its own navigation rail, so the application sidebar stays
  // out of the layout without overwriting the user's persisted preference.
  const profileFullscreen = page === 'profile';
  // A swipe right from the left screen edge opens the narrow drawer, and a
  // swipe left anywhere closes it again.
  const openNarrowOverlay = React.useCallback(() => setNarrowOverlayOpen(true), []);
  const dismissNarrowOverlay = React.useCallback(() => setNarrowOverlayOpen(false), []);
  const drawerSwipeEnabled = narrowMode && !profileFullscreen
    && !settingsOpen && !paletteOpen && !remoteAuthenticationOpen && !remoteRecoveryOpen;
  useEdgeSwipe(drawerSwipeEnabled && !narrowOverlayOpen, openNarrowOverlay);
  useSwipeLeft(drawerSwipeEnabled && narrowOverlayOpen, dismissNarrowOverlay);
  const sidebarCollapsedEffective = profileFullscreen
    || (narrowMode ? !narrowOverlayOpen : prefs.sidebarCollapsed);
  const handleToggleSidebarEffective = React.useCallback(() => {
    if (narrowMode) setNarrowOverlayOpen((v) => !v);
    else setPref('sidebarCollapsed', !prefs.sidebarCollapsed);
  }, [narrowMode, prefs.sidebarCollapsed, setPref]);
  // Auto-close overlay after navigation in narrow mode.
  const handleNavWithClose = React.useCallback((p: PageId) => {
    handleNav(p);
    if (narrowMode) setNarrowOverlayOpen(false);
  }, [handleNav, narrowMode]);
  // Area sidebar rows that open something in the main column close it too.
  const closeNarrowOverlay = React.useCallback(() => {
    if (narrowMode) setNarrowOverlayOpen(false);
  }, [narrowMode]);
  // Home opens in the main column, so a narrow drawer would cover it
  // (e.g. a workspace row's "+"). Wide windows never hold the overlay open.
  useEffect(() => {
    const onEvt = () => {
      setPage('home');
      setNarrowOverlayOpen(false);
    };
    window.addEventListener('michi:goto-home', onEvt as EventListener);
    return () => window.removeEventListener('michi:goto-home', onEvt as EventListener);
  }, []);

  return (
    <>
    <PaneViewStateProvider items={paneItems}>
    <PanePresentationProvider ids={openPanes} items={paneItems} focusedPane={focusedPane} scope={paneScopeKey(activeProject, pagePane)} enabled={hydrated && page === 'dashboard'}>
    <div
      className="terminal-shell"
      data-sidebar-layout={profileFullscreen ? 'hidden' : narrowMode ? 'overlay' : 'docked'}
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
        // Clip drawer/overlay slide-ins (a drawer panel starts at
        // translateX(100%), which would otherwise overshoot the viewport
        // right edge and flash a horizontal scrollbar on Windows where
        // scrollbars take up space). clip, unlike hidden,
        // cannot be scrolled by focus or scrollIntoView, which on a phone
        // shifted the whole shell sideways behind an overflowing topbar.
        overflow: 'clip',
      }}
    >
      <TerminalTopbar
        workspaceReady={hydrated}
        navigation={navigation}
        page={page}
        onNav={handleNav}
        sidebarCollapsed={sidebarCollapsedEffective}
        // The area rail stays in the layout whenever the sidebar is closed.
        // Narrow windows have none: their drawer carries the areas instead.
        sidebarRail={!profileFullscreen && !narrowMode && sidebarCollapsedEffective}
        onToggleSidebar={handleToggleSidebarEffective}
        onNewThread={() => { setPage('home'); if (narrowMode) setNarrowOverlayOpen(false); }}
        onOpenPalette={() => { if (hydrated) setPaletteOpen(true); }}
        artifactsOpen={artifactsOpen}
        remoteRecoveryControl={<RemoteRecoveryIndicator onOpenDetails={openRemoteRecovery} />}
        spacesCrumb={spacesSettingsOpen ? 'Settings' : page === 'spaces' ? (spacesHome.kind === 'all-tasks' ? 'All tasks' : spacesChatView.kind === 'workspace' ? spacesChatView.name : 'Home') : undefined}
        onAreaHome={page === 'scheduled' ? openScheduledHome : undefined}
        areaCrumb={page === 'scheduled' && metaAgentOpen ? META_AGENT_PAGE_TITLE : undefined}
        spacesAssistant={area === 'spaces' ? { open: !chat.state.minimized, onToggle: chat.toggleMinimized } : undefined}
      />
      <RemoteServiceRecoveryMonitor />
      <RemoteAuthenticationDialog />
      {hydrated && <WarmFailedBanner />}
      {hydrated && <AskUserAlertBar onNav={handleNav} />}
      <div className="terminal-body" style={{ flex: 1, display: 'flex', minHeight: 0, gap: 'var(--term-content-gap, 0px)', position: 'relative' }}>
        {!profileFullscreen && !narrowMode && <ShellRail area={area} onSelect={selectArea} settingsOpen={settingsOpen} />}
        {!profileFullscreen && (
          <TerminalSidebar
            areaContent={area === 'spaces' ? (
              <SpacesAreaSidebar
                current={spacesSettingsOpen ? SPACES_HOME : page === 'space' && spaceRoute.type === 'space' ? { kind: 'page', pageId: spaceRoute.pageId, workspaceId: spaceRoute.workspaceId, backendConnectionId: spaceRoute.backendConnectionId } : spacesHome}
                onOpenHome={() => { handleNav('spaces'); closeNarrowOverlay(); }}
                onOpenWorkspace={(target) => { openWorkspaceHome(target); closeNarrowOverlay(); }}
                onOpenPage={(target) => { openSpaceRoute({ type: 'space', ...target }); closeNarrowOverlay(); }}
                onOpenAssistant={() => { chat.restore(); closeNarrowOverlay(); }}
                onOpenAllTasks={() => { openAllTasks(); closeNarrowOverlay(); }}
                onOpenSettings={() => { if (!spacesSettingsOpen) spacesSettingsReturnPage.current = page; setPage('spaces'); setSpacesSettingsOpen(true); chat.minimize(); closeNarrowOverlay(); }}
                settingsOpen={spacesSettingsOpen}
                assistantOpen={!chat.state.minimized}
                onNewSpace={() => setCreateSpaceOpen(true)}
              />
            ) : area === 'scheduled' ? (
              <ScheduledSidebar selectedJobId={scheduledJobId} onSelectJob={requestScheduledJobDetail} onNavigate={closeNarrowOverlay} />
            ) : undefined}
            workspaceReady={hydrated}
            activePage={page}
            customAgentsEnabled={agentStatus?.customAgentsEnabled === true}
            onNav={narrowMode ? handleNavWithClose : handleNav}
            onOpenPalette={() => { if (hydrated) setPaletteOpen(true); }}
            onNewThread={() => { setPage('home'); if (narrowMode) setNarrowOverlayOpen(false); }}
            narrowMode={narrowMode}
            narrowOverlayOpen={narrowOverlayOpen}
            onCloseOverlay={() => setNarrowOverlayOpen(false)}
            overlayHeader={<ShellAreaTabs area={area} settingsOpen={settingsOpen} onSelect={(next) => {
              selectArea(next);
              // Settings opens its own drawer; other areas swap this drawer's list.
              if (next === 'settings') setNarrowOverlayOpen(false);
            }} />}
          />
        )}
        <div className="terminal-content-col" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          {/* Keep the data barrier, not a root-level rendering barrier. */}
          {!hydrated ? (
            <div role="status" aria-label="Loading workspaces" style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--term-muted)', fontSize: 'var(--fs-md)' }}>
              <span className="term-hydrating">loading workspaces…</span>
            </div>
          ) : <>
          {page === 'home' && <TerminalHome onSubmitted={() => setPage('dashboard')} />}
          <SpacesMetaChat controller={chat} active={area === 'spaces'} view={spacesChatView}>
            {spacesSettingsOpen ? <SpacesSettings onBack={() => { setSpacesSettingsOpen(false); setPage(spacesSettingsReturnPage.current); }} /> : <>
              {page === 'spaces' && <LazyPage><TerminalSpaces target={spacesHome} onOpenPage={(target) => openSpaceRoute({ type: 'space', ...target })} /></LazyPage>}
              {page === 'space' && spaceRoute.type === 'space' && <LazyPage><TerminalSpaceView route={spaceRoute} onBack={() => handleNav('spaces')} onOpenPage={(target) => openSpaceRoute({ type: 'space', ...target })} onOpenSource={openSpaceSource} /></LazyPage>}
            </>}
          </SpacesMetaChat>
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
          {page === 'scheduled' && (metaAgentOpen ? <LazyPage><TerminalMetaAgentScheduled /></LazyPage> : <LazyPage><TerminalScheduled onNav={handleNav} /></LazyPage>)}
          {page === 'archived' && <LazyPage><TerminalArchived onNav={handleNav} /></LazyPage>}
          {page === 'profile' && PROFILE_PAGE_ENABLED && <LazyPage><TerminalProfile onNav={handleNav} /></LazyPage>}
          {page === 'agents' && <LazyPage><AgentManagementLibrary onNav={handleNav} /></LazyPage>}
          {page === 'agent-manage' && <LazyPage><AgentManagementEditor route={manageAgentRoute} onNav={handleNav} /></LazyPage>}
          </>}
        </div>
      </div>
      {hydrated && paletteOpen && (
        <React.Suspense fallback={null}>
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            setPage={handleNav}
            activePage={page}
          />
        </React.Suspense>
      )}
      <NewWorkspaceAutoOpen ready={autoOpenReady} onOpen={autoOpenNewWorkspace} />
      {hydrated && createSpaceOpen && (
        <CreateSpaceDialog
          activeWorkspaceId={activeProject?.id}
          onClose={() => setCreateSpaceOpen(false)}
          onCreated={(target) => { setCreateSpaceOpen(false); openSpaceRoute({ type: 'space', ...target }); }}
        />
      )}
      {hydrated && <NewWorkspaceDialog
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
      />}
      {/* A phone's Settings fills the screen; Back (and Esc) first returns from a
          page to the list. A wider window shows Settings as a window over the app. */}
      {narrowMode ? (
        <DrawerShell open={settingsOpen} title="Settings" width={720} motion={drawerMotion} onPresenceChange={setSettingsPresent}
          onClose={() => { if (settingsView === 'section') setSettingsView('menu'); else setSettingsOpen(false); }}
          closeControl="back">
          <TerminalSettingsArea page={settingsPage} onPageChange={setSettingsPage} view={settingsView} onViewChange={setSettingsView} stacked workspaceReady={hydrated} onNav={handleNav} />
        </DrawerShell>
      ) : (
        <ModalShell open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings" width={1080} maxHeight="calc(100vh - 48px)" layer="window">
          <TerminalSettingsArea page={settingsPage} onPageChange={setSettingsPage} onViewChange={setSettingsView} workspaceReady={hydrated} onNav={handleNav} />
        </ModalShell>
      )}
      <RemoteRecoveryDrawer open={remoteRecoveryOpen} onClose={closeRemoteRecovery} motion={drawerMotion} onPresenceChange={setRemoteRecoveryPresent} />
      {hydrated && area !== 'spaces' && <AssistantPanelHost page={page} />}
      {hydrated && (artifactsOpen || artifactsPresent) && (
        <React.Suspense fallback={null}>
          <ArtifactsDrawer key={activeProject?.id ?? 'none'} open={artifactsOpen} motion={drawerMotion} onPresenceChange={setArtifactsPresent} onClose={() => { setArtifactsOpen(false); }} />
        </React.Suspense>
      )}
      {hydrated && <SourcePopoverHost />}
      {hydrated && <SpaceConversationWatcher page={page} />}
      {hydrated && backgroundWork && (backgroundWorkShown || backgroundWorkPresent) && (
        <React.Suspense fallback={null}>
          <BackgroundWorkDrawer
            key={activeProject?.id ?? 'none'}
            open={backgroundWorkShown}
            motion={drawerMotion}
            onPresenceChange={setBackgroundWorkPresent}
            onClose={() => { setBackgroundWorkOpen(false); }}
            request={backgroundWork.request}
            requestSeq={backgroundWork.seq}
          />
        </React.Suspense>
      )}
    </div>
    </PanePresentationProvider>
    </PaneViewStateProvider>
    </>
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
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><div style={{ padding: '7px 56px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>CONTROL PLANE · {backendName} ({backendConnectionId}){activeProject ? ` · WORKSPACE ${activeProject.name}` : ' · NO WORKSPACE SELECTED'}</div><AgentLibraryPage definitions={definitions} runs={runs} workspaceId={activeProject?.id ?? null} loading={loading} error={error} onCreate={create} onEdit={edit} onEnable={(identity) => { void update(identity, enableAgentDefinition); }} onDisable={(identity) => { void update(identity, disableAgentDefinition); }} onDuplicate={(identity) => { void update(identity, duplicateAgentDefinition); }} onDelete={(identity) => { void deleteAgentDefinition(identity).then(() => dispatch({ type: 'remove-definition', identity })).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }} /></div>;
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
  return <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><div style={{ padding: '7px 56px', borderBottom: '1px solid var(--term-line)', color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>CONTROL PLANE · {route.backendConnectionId}{route.workspaceId ? ` · WORKSPACE ${route.workspaceId}` : ' · GLOBAL'}</div><AgentEditorPage definition={definition} backendConnectionId={route.backendConnectionId} initialScope={route.scope} workspaceId={route.workspaceId} error={error} blockers={blockers} onCancel={() => onNav('agents')} onSaveDraft={(value) => execute(() => persist(value, false))} onEnable={(value) => execute(() => persist(value, true))} onDisable={identity ? () => execute(async () => { dispatch({ type: 'upsert-definitions', resources: [await disableAgentDefinition(identity)] }); }) : undefined} onDuplicate={identity ? () => execute(async () => { const copied = await duplicateAgentDefinition(identity); dispatch({ type: 'upsert-definitions', resources: [copied] }); setManageAgentRoute({ mode: 'edit', scope: copied.value.scope, workspaceId: copied.value.workspaceId, backendConnectionId: copied.backendConnectionId, definitionId: copied.value.id }); }) : undefined} onDelete={identity ? () => execute(async () => { await deleteAgentDefinition(identity); dispatch({ type: 'remove-definition', identity }); setManageAgentRoute(null); onNav('agents'); }) : undefined} /></div>;
}

/** The area rail and its native workspace badges. */
function ShellRail({ area, onSelect, settingsOpen }: { area: ShellArea; onSelect: (area: ShellArea) => void; settingsOpen: boolean }) {
  const badges = useRailBadges();
  return <AreaRail area={area} onSelect={onSelect} badges={badges} settingsOpen={settingsOpen} />;
}

/** The areas as the phone drawer's first row, with the same badges. */
function ShellAreaTabs({ area, onSelect, settingsOpen }: { area: ShellArea; onSelect: (area: ShellArea) => void; settingsOpen: boolean }) {
  const badges = useRailBadges();
  return <AreaTabs area={area} onSelect={onSelect} badges={badges} settingsOpen={settingsOpen} />;
}

function SpacesAreaSidebar(props: Omit<React.ComponentProps<typeof SpacesSidebar>, 'waitingCount'> & { current: SpacesSidebarCurrent }) {
  return <SpacesSidebar {...props} />;
}
