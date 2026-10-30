import React, { useCallback, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import TerminalShell from './components/terminal/TerminalShell';
import { TOPBAR_HEIGHT } from './components/terminal/Topbar';
import ApiKeyGate from './components/ApiKeyGate';
import FirstRunSetup from './components/FirstRunSetup';
import { ConfirmDialogHost } from './components/ui/ConfirmDialog';
import { LandingPage } from './components/LandingPage';
import { AuthSessionContext, authClient, fetchAuthConfig } from './services/auth';
import DigestPromptDialog from './components/DigestPromptDialog';
import type { ExportPanelState } from './components/ExportPanel';
import { ChatProvider, useChatActions, useChatStore, useChatNodesSnapshot, activeTreeRootNodeId, chatLabel } from './state/chatStore';
import { PrefsProvider, usePrefs } from './state/prefs';
import { AgentDomainProvider } from './state/agentDomain';
import { WorkflowDomainProvider, type EndedBackgroundSubagentsOfWorkspace } from './state/workflowDomain';
import { DARK_PALETTES } from './components/terminal/tokens';
import {
  runTranscript,
  runSelectionTranscript,
  saveMarkdown,
  defaultExportFilename,
} from './lib/exportWorkspace';
import { stripSentinelsStreamingSafe } from './state/assistantParsing';
import { startupMarkOnce } from './services/startupTrace';
import AppErrorBoundary from './components/AppErrorBoundary';
import './index.css';

const ExportPanel = React.lazy(() => import('./components/ExportPanel'));

type ExportEventDetail = {
  projectId?: string;
  treeId?: string;
  nodeIds?: string[];
  digestNodeId?: string;
};

function exportTitleForThread(
  project: NonNullable<ReturnType<typeof useChatStore>['activeProject']>,
  nodes: ReturnType<typeof useChatNodesSnapshot>,
  treeId?: string,
) {
  const tree = treeId
    ? project.trees.find((candidate) => candidate.id === treeId)
    : project.trees.find((candidate) => candidate.id === project.activeTreeId);
  const rootNode = tree ? nodes[tree.rootNodeId] : undefined;
  const threadTitle = tree?.name?.trim() || rootNode?.title?.trim() || chatLabel(rootNode);
  return threadTitle ? `${project.name} / ${threadTitle}` : project.name;
}

function DigestPromptListener() {
  const { createDigest, openPane } = useChatStore();
  const [pending, setPending] = useState<{ projectId: string; sourceIds: string[] } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, sourceIds } = (e as CustomEvent).detail;
      setPending({ projectId, sourceIds });
    };
    window.addEventListener('michi:digest-prompt', handler);
    return () => window.removeEventListener('michi:digest-prompt', handler);
  }, []);
  return (
    <DigestPromptDialog
      open={!!pending}
      onCancel={() => setPending(null)}
      onConfirm={(cp) => {
        if (!pending) return;
        const { projectId, sourceIds } = pending;
        setPending(null);
        void createDigest(projectId, sourceIds, cp || undefined).then((id) => openPane(id)).catch(() => {});
      }}
    />
  );
}

function ExportPanelManager() {
  const { activeProject, projects, selection } = useChatStore();
  const nodesSnapshot = useChatNodesSnapshot();
  const [exportState, setExportState] = useState<ExportPanelState>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const activeProjectRef = React.useRef(activeProject);
  const projectsRef = React.useRef(projects);
  const nodesRef = React.useRef(nodesSnapshot);
  const selectionRef = React.useRef(selection);

  activeProjectRef.current = activeProject;
  projectsRef.current = projects;
  nodesRef.current = nodesSnapshot;
  selectionRef.current = selection;

  const close = React.useCallback(() => setOpen(false), []);

  const save = React.useCallback(() => {
    if (exportState.kind !== 'done') return;
    void saveMarkdown(exportState.suggestedFilename, exportState.markdown);
  }, [exportState]);

  useEffect(() => {
    const onExport = (event: Event) => {
      setOpen(true);

      const detail = (event as CustomEvent<ExportEventDetail | undefined>).detail;
      const projectId =
        detail?.projectId
        ?? (detail?.digestNodeId ? nodesRef.current[detail.digestNodeId]?.projectId : undefined);
      const project = projectId
        ? projectsRef.current.find((candidate) => candidate.id === projectId && !candidate.deletedAt) ?? null
        : activeProjectRef.current;
      if (!project) return;

      // Direct-export path: caller already has the markdown (e.g. the Digest
      // page exporting the currently visible digest). Surface the content
      // immediately.
      if (detail?.digestNodeId) {
        const digestNode = nodesRef.current[detail.digestNodeId];
        const raw = digestNode?.digest?.content ?? '';
        // The digest content can carry the inline `[TITLE: ...]` and
        // `[FOLLOW-UPS: ...]` PREAMBLE sentinels that the in-app renderer
        // hides at view time. Strip them here so the exported markdown is
        // what the user actually sees on screen.
        const { visibleText } = stripSentinelsStreamingSafe(raw);
        const markdown = visibleText.trim();
        if (!markdown) {
          setExportState({
            kind: 'error',
            projectName: project.name,
            exportTitle: exportTitleForThread(project, nodesRef.current),
            error: 'Digest is empty.',
          });
          return;
        }
        const title = digestNode?.title || project.name;
        setExportState({
          kind: 'done',
          projectName: project.name,
          exportTitle: `${project.name} / ${title}`,
          markdown,
          suggestedFilename: defaultExportFilename(title),
        });
        return;
      }

      const rootId = detail?.treeId
        ? project.trees.find((tree) => tree.id === detail.treeId)?.rootNodeId
        : activeTreeRootNodeId(project) ?? project.chatIds[0];
      if (!rootId) return;

      const selectedIds =
        detail?.nodeIds
        ?? (!detail?.treeId && selectionRef.current.size >= 2
          ? Array.from(selectionRef.current)
          : undefined);

      const exportTitle = exportTitleForThread(project, nodesRef.current, detail?.treeId);

      try {
        const { markdown, suggestedFilename } = selectedIds && selectedIds.length > 0
          ? runSelectionTranscript(project, rootId, nodesRef.current, selectedIds)
          : runTranscript(project, rootId, nodesRef.current);
        setExportState({
          kind: 'done',
          projectName: project.name,
          exportTitle,
          markdown,
          suggestedFilename,
        });
      } catch (err) {
        setExportState({
          kind: 'error',
          projectName: project.name,
          exportTitle,
          error: (err as Error).message,
        });
      }
    };

    window.addEventListener('michi:toggle-export-panel', onExport);
    return () => window.removeEventListener('michi:toggle-export-panel', onExport);
  }, []);

  return (
    <React.Suspense fallback={null}>
      <ExportPanel
        open={open}
        state={exportState}
        onClose={close}
        onSave={save}
      />
    </React.Suspense>
  );
}

/** Theme-aware toast container. Reads prefs to sync sonner's theme with the app. */
function AppToaster() {
  const { prefs } = usePrefs();
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  // Top-right, just below the topbar (which carries the pane captions), so a
  // toast never covers the Composer the user is typing in. Phones use the
  // same top inset: sonner's full-width mobile layout would otherwise sit on
  // the Composer.
  const offset = { top: TOPBAR_HEIGHT + 8, right: 16 };
  return (
    <Toaster
      position="top-right"
      theme={isDark ? 'dark' : 'light'}
      richColors
      offset={offset}
      mobileOffset={{ top: offset.top }}
    />
  );
}

function ShellSwitcher() {
  return <TerminalShell />;
}

function StartupInteractiveMark({ surface }: { surface: string }) {
  useEffect(() => {
    startupMarkOnce('app_interactive', { surface });
  }, [surface]);
  return null;
}

/**
 * Probe `/api/auth-config` once on mount, then drive a 3-state machine:
 *
 *   - 'loading'        : initial probe in flight; render nothing
 *   - 'no-auth'        : backend doesn't require auth (dev / Electron) →
 *                        render shell unconditionally, like before
 *   - 'unauthenticated': backend requires auth + no session → landing page
 *   - 'authenticated'  : backend requires auth + valid session → shell
 *
 * The session check uses better-auth's useSession hook so it's reactive
 * to sign-in / sign-out happening elsewhere in the tab.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'no-auth' | 'gated'>('loading');

  useEffect(() => {
    let cancelled = false;
    void fetchAuthConfig().then((config) => {
      if (cancelled) return;
      setState(config.requireAuth ? 'gated' : 'no-auth');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') return null;

  // No-auth path: identical pre-auth behavior. No userId needed (Electron / dev).
  if (state === 'no-auth') {
    return (
      <ChatProvider>
        <StartupInteractiveMark surface="shell" />
        {children}
      </ChatProvider>
    );
  }

  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  // Local backends do not expose /api/auth/*; only subscribe after the probe.
  const session = authClient.useSession();

  // Gated path: while better-auth is still hydrating its initial session
  // request, render nothing rather than flashing the landing page.
  if (session.isPending) return null;

  if (!session.data?.user) {
    return (
      <>
        <StartupInteractiveMark surface="landing" />
        <LandingPage />
      </>
    );
  }
  const userId = session.data.user.id;
  return (
    <AuthSessionContext.Provider value={session.data}>
      <ChatProvider key={userId} userId={userId}>
        <StartupInteractiveMark surface="shell" />
        {children}
      </ChatProvider>
    </AuthSessionContext.Provider>
  );
}

/**
 * The workflow domain, with a workspace feed's ended background subagents
 * applied to the chat node they belong to (no turn, no focus change).
 */
function ChatWorkflowDomainProvider({ children }: { children: React.ReactNode }) {
  const { dispatch } = useChatActions();
  const onBackgroundSubagentsEnded = useCallback((ended: EndedBackgroundSubagentsOfWorkspace) => {
    dispatch({ type: 'background-subagents-ended', nodeId: ended.nodeId, workspaceId: ended.workspaceId, subagents: ended.subagents });
  }, [dispatch]);
  return <WorkflowDomainProvider onBackgroundSubagentsEnded={onBackgroundSubagentsEnded}>{children}</WorkflowDomainProvider>;
}

function App() {
  return (
    <PrefsProvider>
      <AppToaster />
      <AppErrorBoundary>
        <AuthGate>
          <AgentDomainProvider>
            <ChatWorkflowDomainProvider>
            <ShellSwitcher />
            <FirstRunSetup />
            <ApiKeyGate />
            <DigestPromptListener />
            <ExportPanelManager />
            <ConfirmDialogHost />
            </ChatWorkflowDomainProvider>
          </AgentDomainProvider>
        </AuthGate>
      </AppErrorBoundary>
    </PrefsProvider>
  );
}

export default App;
