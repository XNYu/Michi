import React, { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import TerminalShell from './components/terminal/TerminalShell';
const MobileShell = React.lazy(() => import('./components/mobile/MobileShell'));
import { useMediaQuery, MOBILE_QUERY } from './components/mobile/hooks/useMediaQuery';
import ApiKeyGate from './components/ApiKeyGate';
import { ConfirmDialogHost } from './components/ui/ConfirmDialog';
import { LandingPage } from './components/LandingPage';
import { authClient, fetchAuthConfig } from './services/auth';
import DigestPromptDialog from './components/DigestPromptDialog';
import type { ExportPanelState } from './components/ExportPanel';
import { ChatProvider, useChatStore, useChatNodesSnapshot, activeTreeRootNodeId, chatLabel } from './state/chatStore';
import { PrefsProvider, usePrefs } from './state/prefs';
import { DARK_PALETTES } from './components/terminal/tokens';
import {
  runTranscript,
  runSelectionTranscript,
  saveMarkdown,
  defaultExportFilename,
} from './lib/exportWorkspace';
import { stripSentinelsStreamingSafe } from './state/assistantParsing';
import { startupMarkOnce } from './services/startupTrace';
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
  const abortRef = React.useRef<AbortController | null>(null);
  const activeProjectRef = React.useRef(activeProject);
  const projectsRef = React.useRef(projects);
  const nodesRef = React.useRef(nodesSnapshot);
  const selectionRef = React.useRef(selection);
  const exportStateRef = React.useRef(exportState);

  activeProjectRef.current = activeProject;
  projectsRef.current = projects;
  nodesRef.current = nodesSnapshot;
  selectionRef.current = selection;
  exportStateRef.current = exportState;

  const close = React.useCallback(() => setOpen(false), []);
  const abort = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setExportState({ kind: 'idle' });
    setOpen(false);
  }, []);

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

      abortRef.current?.abort();
      abortRef.current = null;
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
        onAbort={abort}
        onSave={save}
      />
    </React.Suspense>
  );
}

/** Theme-aware toast container. Reads prefs to sync sonner's theme with the app. */
function AppToaster() {
  const { prefs } = usePrefs();
  const isDark = DARK_PALETTES.has(prefs.terminalPalette);
  return <Toaster position="bottom-right" theme={isDark ? 'dark' : 'light'} richColors />;
}

function ShellSwitcher() {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  if (!isMobile) return <TerminalShell />;
  return (
    <React.Suspense fallback={null}>
      <MobileShell />
    </React.Suspense>
  );
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
function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'no-auth' | 'gated'>('loading');
  const session = authClient.useSession();

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
    <ChatProvider key={userId} userId={userId}>
      <StartupInteractiveMark surface="shell" />
      {children}
    </ChatProvider>
  );
}

function App() {
  return (
    <PrefsProvider>
      <AppToaster />
      <AuthGate>
        <ShellSwitcher />
        <ApiKeyGate />
        <DigestPromptListener />
        <ExportPanelManager />
        <ConfirmDialogHost />
      </AuthGate>
    </PrefsProvider>
  );
}

export default App;
