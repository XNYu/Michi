import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import { prefersReducedMotion } from '../../../hooks/useReducedMotion';
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { serverEntityId } from '../../../config/backendIdentity';
import { useChatActions, useChatPanes, useChatProjects, useStructuralSelector, shallowArrayEqual } from '../../../state/chatStore';
import { paneScopeKey } from '../../../state/paneState';
import type { ChatNodeState } from '../../../state/chatTypes';
import type { AgentRunPaneItem } from '../../../state/paneItems';
import type { PagePaneItem } from '../../../state/paneItems';
import { agentResourceKey, identityOf } from '../../../state/agentIdentity';
import type { WorkflowRunPaneItem } from '../../../state/paneItems';
import { useOptionalWorkflowDomain, useWorkflowRunDetail } from '../../../state/workflowDomain';
import { useAgentDomain } from '../../../state/agentDomain';
import { createAgentRunNotificationTracker } from '../../../state/agentRunNotifications';
import { usePrefs } from '../../../state/prefs';
import EmptyThreads from '../../EmptyThreads';
import ResizeHandle from '../../ResizeHandle';
import TPane from '../TPane';
import { AssistantPaneScope } from '../assistant/AssistantLinks';
import DigestPane from '../DigestPane';
import ArtifactPane from '../ArtifactPane';
import PaneErrorBoundary from '../PaneErrorBoundary';
import BrowserDock from '../BrowserDock';
import TerminalHome from './Home';
import { getElectron } from '../../../lib/electronBridge';
import { getWebUploadCwd, importWorkspaceFileUpload, type UploadProgress } from '../../../services/api';
import { notify } from '../../../services/notifications';
import { toast } from 'sonner';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';
import { usePaneLayout } from '../usePaneLayout';
import { bindPaneCaptionScroll } from '../paneCaptionScroll';
import { afterPaneMotion, scrollWithPaneLayout } from '../paneReveal';
import { paneEntrance, PANE_EASE } from '../paneMotion';
import { isFreshBranch, playBranchPush } from '../branchMotion';
import { PaneArrivalTabs, usePaneArrivals } from '../PaneArrivals';
import { RetainedPaneContent, usePresentedPanes, usePresentedPaneFocus } from '../PanePresentation';

const FilePane = lazy(() => import('../FilePane'));
const DiffPane = lazy(() => import('../DiffPane'));
const TerminalPane = lazy(() => import('../TerminalPane'));
const PaneChooser = lazy(() => import('../PaneChooser'));
const FilesPane = lazy(() => import('../FilesPane'));
const ReviewPane = lazy(() => import('../ReviewPane'));
const PagePane = lazy(() => import('../spaces/PagePane'));
const AgentRunPaneSurface = lazy(() => import('../agentRuns/AgentRunPaneSurface'));
const WorkflowRunPane = lazy(() => import('../workflows/WorkflowRunPane').then((module) => ({ default: module.WorkflowRunPane })));
const notificationTracker = createAgentRunNotificationTracker();

function WorkflowRunPaneSurface({ item }: { item: WorkflowRunPaneItem }) {
  const { closePane, openPane } = useChatActions();
  const workflows = useOptionalWorkflowDomain();
  const identity = useMemo(() => ({ backendConnectionId: item.backendConnectionId, id: item.runId }), [item.backendConnectionId, item.runId]);
  const { resource, pending, error, missing } = useWorkflowRunDetail(identity);
  if (!workflows || !resource) {
    return <div style={{ padding: 16, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>{missing ? 'This workflow is no longer available.' : 'loading workflow…'}</div>;
  }
  const parentNodeId = resource.value.nodeId;
  return (
    <WorkflowRunPane
      run={resource.value}
      pending={pending}
      error={error}
      onClose={() => closePane(item.id)}
      onAction={(action) => { void workflows.act(identity, action); }}
      onAnswer={(approvalId, optionId) => { void workflows.answer(identity, approvalId, optionId); }}
      onOpenParent={parentNodeId ? () => openPane(parentNodeId) : undefined}
    />
  );
}

/**
 * Center a pane using the coordinates that are actually painted in the
 * dashboard strip. `offsetLeft` is relative to an offset parent and can drift
 * when the shell changes pages; viewport-relative rectangles do not.
 */
export function centeredPaneScrollLeft({
  paneLeft,
  paneWidth,
  stripLeft,
  stripWidth,
  currentScrollLeft,
  maxScrollLeft,
}: {
  paneLeft: number;
  paneWidth: number;
  stripLeft: number;
  stripWidth: number;
  currentScrollLeft: number;
  maxScrollLeft: number;
}): number {
  const paneDocumentLeft = paneLeft - stripLeft + currentScrollLeft;
  const desired = paneDocumentLeft + paneWidth / 2 - stripWidth / 2;
  return Math.max(0, Math.min(desired, maxScrollLeft));
}

export default function TerminalDashboard() {
  const { activeProject, agentStatus } = useChatProjects();
  const { openPanes: activePanes, pagePane, focusedPane, paneItems: activeItems = {} } = useChatPanes();
  const phone = usePhoneLayout();
  const visiblePhonePane = activePanes.includes(focusedPane ?? '') && activeItems[focusedPane ?? '']?.kind !== 'browser' ? focusedPane : activePanes.find(id => activeItems[id]?.kind !== 'browser');
  const paneScope = paneScopeKey(activeProject, pagePane);
  const { settleFocus } = usePresentedPaneFocus(focusedPane);
  const { paneIds: presentedPanes, paneItems, exitingIds: allExitingIds, holdExits, finishExit } = usePresentedPanes(activePanes, activeItems);
  const openPanes = useMemo(() => presentedPanes.filter(id => paneItems[id]?.kind !== 'browser'), [presentedPanes, paneItems]);
  const exitingIds = useMemo(() => new Set([...allExitingIds].filter(id => openPanes.includes(id))), [allExitingIds, openPanes]);
  const browserItems = activePanes.flatMap(id => { const item = activeItems[id]; return item?.kind === 'browser' ? [item] : []; });
  const { setPaneWidth, openAgentRunPane, focusPane } = useChatActions();
  const agentDomain = useAgentDomain();
  const workflowDomain = useOptionalWorkflowDomain();
  const subscribeWorkflows = workflowDomain?.subscribeWorkspace;
  const { prefs } = usePrefs();

  useEffect(() => {
    let retryTimer: number | null = null;
    let deadline = 0;
    const revealTarget = (event: Event) => {
      const detail = (event as CustomEvent<{
        pageId: string; workspaceId: string; backendConnectionId: string;
        resourceKind: 'page' | 'database'; resourceId: string; targetId: string;
      }>).detail;
      if (!detail) return;
      deadline = Date.now() + 1200;
      if (retryTimer !== null) window.clearInterval(retryTimer);
      const attempt = () => {
        const owners = Array.from(document.querySelectorAll<HTMLElement>('[data-native-page-pane]'))
          .filter((element) => element.dataset.pageId === detail.pageId
            && element.dataset.workspaceId === detail.workspaceId
            && element.dataset.backendConnectionId === detail.backendConnectionId);
        for (const owner of owners) {
          const selector = detail.resourceKind === 'page' ? '[data-block-id]' : '[data-row-id]';
          const target = Array.from(owner.querySelectorAll<HTMLElement>(selector))
            .find((element) => {
              if (detail.resourceKind === 'page') return element.dataset.blockId === detail.targetId;
              return element.dataset.rowId === detail.targetId
                && element.closest<HTMLElement>('[data-native-database]')?.dataset.databaseId === detail.resourceId;
            }) ?? (detail.resourceKind === 'database'
              && detail.targetId === serverEntityId(detail.resourceId, detail.backendConnectionId)
              ? Array.from(owner.querySelectorAll<HTMLElement>('[data-native-database]'))
                .find((element) => element.dataset.databaseId === detail.resourceId)
              : undefined);
          if (target) {
            target.scrollIntoView({ behavior: prefersReducedMotion(prefs.reduceMotion) ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
            if (retryTimer !== null) window.clearInterval(retryTimer);
            retryTimer = null;
            return;
          }
        }
        if (Date.now() >= deadline && retryTimer !== null) {
          window.clearInterval(retryTimer);
          retryTimer = null;
        }
      };
      attempt();
      if (Date.now() < deadline) retryTimer = window.setInterval(attempt, 50);
    };
    window.addEventListener('michi:scroll-to-page-target', revealTarget);
    return () => {
      window.removeEventListener('michi:scroll-to-page-target', revealTarget);
      if (retryTimer !== null) window.clearInterval(retryTimer);
    };
  }, [prefs.reduceMotion]);
  const selectPaneWidths = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      openPanes.map((id) => paneItems[id]?.width ?? nodesMap[id]?.paneWidth),
    [openPanes, paneItems],
  );
  const selectPaneKinds = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      openPanes.map((id) => nodesMap[id]?.kind ?? 'chat'),
    [openPanes],
  );
  const widths = useStructuralSelector(selectPaneWidths, shallowArrayEqual);
  const paneKinds = useStructuralSelector(selectPaneKinds, shallowArrayEqual);
  const stripRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const layout = usePaneLayout(stripRef, {
    paneIds: openPanes, customWidths: phone ? [] : widths, mode: phone ? 'fixed' : prefs.paneWidthMode, exitingIds,
    defaultPaneWidth: phone ? 100_000 : prefs.defaultPaneWidth,
    enabled: !!activeProject && openPanes.length > 0,
    scope: paneScope,
    appReduceMotion: phone || prefs.reduceMotion,
    onExitStart: holdExits,
    onExitComplete: finishExit,
  });
  const paneOnScreen = (id: string) => {
    const strip = stripRef.current;
    const index = openPanes.indexOf(id);
    if (!strip || index < 0 || !layout.ready) return true;
    const left = layout.positions[index] - strip.scrollLeft;
    const width = layout.widths[index];
    return Math.min(left + width, strip.clientWidth) - Math.max(left, 0) >= width * 0.6;
  };
  const chatPanes = useMemo(() => activePanes.filter(id => activeItems[id]?.kind !== 'browser'), [activePanes, activeItems]);
  const { arrivals, recheck: recheckArrivals } = usePaneArrivals({
    scope: paneScope, panes: chatPanes, focusedPane, edges: activeProject?.edges, enabled: !phone, isOnScreen: paneOnScreen,
  });
  // Overlay scrollbar — native scrollbar is hidden via .hide-sb on the
  // strip; we render our own thumb as a sibling and reposition it from the
  // strip's onScroll. Idle thumb is opacity 0; we set opacity 1 while the
  // user is actively scrolling, then fade out 600ms after the last event.
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  // Pane-scoped selection isolation. On mousedown inside a pane we mark the
  // strip `.selecting` and that pane's wrapper `.sel-source`; CSS then makes
  // every OTHER pane `user-select: none` so a drag can't sweep the native
  // selection across DOM order into a neighbor pane / follow-up row (the
  // flash the user reported). Toggled through classList — never React state —
  // so it stays off the streaming render path. See index.css `.selecting`.
  const selectionSourceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!activeProject?.id || !agentStatus?.customAgentsEnabled) return;
    void agentDomain.loadRuns({ version: 1, workspaceId: activeProject.id }).catch(() => {});
    return agentDomain.subscribeWorkspace(activeProject.id);
  }, [activeProject?.id, agentStatus?.customAgentsEnabled, agentDomain.loadRuns, agentDomain.subscribeWorkspace]);

  // Workflow runs are independent of custom agents: any Claude or Kiro chat
  // can launch one.
  useEffect(() => {
    if (!activeProject?.id || !subscribeWorkflows) return;
    return subscribeWorkflows(activeProject.id);
  }, [activeProject?.id, subscribeWorkflows]);

  useEffect(() => {
    const runs = Object.values(agentDomain.state.runs).filter((resource) => resource.value.workspaceId === activeProject?.id);
    for (const item of notificationTracker.collect({ runs, focusedPaneId: focusedPane })) {
      notify({
        title: item.title,
        body: item.body,
        onClick: () => openAgentRunPane(identityOf(item.run), item.run.value.workspaceId, item.run.value.effectiveDefinition.name),
      });
    }
  }, [activeProject?.id, agentDomain.state.runs, focusedPane, openAgentRunPane]);

  const clearPaneSelectionIsolation = useCallback(() => {
    stripRef.current?.classList.remove('selecting');
    const src = selectionSourceRef.current;
    if (src) {
      src.classList.remove('sel-source');
      selectionSourceRef.current = null;
    }
  }, []);

  const handlePaneSelectionMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return; // primary button only — ignore right/middle
      const strip = stripRef.current;
      if (!strip) return;
      // Resolve the strip's DIRECT child — the pane wrapper the CSS `> *` rule
      // targets. NOT closest('[data-node-id]'): TPane's own root (TPane.tsx)
      // and mention-chip spans (MessageBlock.tsx) also carry data-node-id, so
      // closest matched a nested element. The real wrapper then stayed
      // un-exempted, its inherited user-select:none cascaded through the whole
      // pane, and selection died in every pane — the regression being fixed.
      let n = e.target as HTMLElement | null;
      while (n && n.parentElement !== strip) n = n.parentElement;
      const paneEl = n && n.parentElement === strip ? n : null;
      if (!paneEl || !paneEl.hasAttribute('data-node-id')) return;
      clearPaneSelectionIsolation(); // drop any stale source before re-marking
      strip.classList.add('selecting');
      paneEl.classList.add('sel-source');
      selectionSourceRef.current = paneEl;
      // Release on the next mouseup anywhere (pointer may leave the pane).
      window.addEventListener('mouseup', clearPaneSelectionIsolation, { once: true });
    },
    [clearPaneSelectionIsolation],
  );

  useEffect(
    () => () => {
      window.removeEventListener('mouseup', clearPaneSelectionIsolation);
      clearPaneSelectionIsolation();
    },
    [clearPaneSelectionIsolation],
  );

  const updateThumbGeometry = useCallback(() => {
    const strip = stripRef.current;
    const thumb = thumbRef.current;
    if (!strip || !thumb) return;
    const { clientWidth, scrollWidth, scrollLeft } = strip;
    if (scrollWidth <= clientWidth) {
      thumb.style.opacity = '0';
      return;
    }
    const trackInset = 8; // matches paddingLeft/Right of the thumb track region
    const trackSize = clientWidth - trackInset * 2;
    const thumbSize = Math.max(24, Math.floor((clientWidth / scrollWidth) * trackSize));
    const maxScroll = scrollWidth - clientWidth;
    const thumbPos = trackInset + (scrollLeft / maxScroll) * (trackSize - thumbSize);
    thumb.style.width = `${thumbSize}px`;
    thumb.style.transform = `translateX(${thumbPos}px)`;
  }, []);

  useEffect(() => {
    updateThumbGeometry();
    const onResize = () => updateThumbGeometry();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateThumbGeometry, openPanes.length, layout.gridTemplateColumns, layout.settledVersion]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const captions = strip?.closest('.terminal-shell')?.querySelector<HTMLElement>('[data-pane-captions]');
    if (!strip || !captions) return;
    // Translated wrappers can temporarily extend scrollWidth. Clamp to the
    // final extent once so closing at the right edge cannot drift each frame.
    const finalExtent = layout.padding + layout.contentWidth + layout.paddingRight;
    const maxScroll = Math.max(0, finalExtent - strip.clientWidth);
    if (exitingIds.size === 0 && strip.scrollLeft > maxScroll) strip.scrollLeft = maxScroll;
    return bindPaneCaptionScroll(strip, captions, !!layout.animationRef.current);
  }, [openPanes, exitingIds, activeProject?.id, activeProject?.activeTreeId, layout.gridTemplateColumns, layout.paddingRight, layout.settledVersion, layout.animationRef, layout.contentWidth, layout.padding]);

  const dashDragDepthRef = useRef(0);
  const [dashDropzoneVisible, setDashDropzoneVisible] = useState(false);
  const [dashDroppedFileCount, setDashDroppedFileCount] = useState(0);
  const [dashUploadProgress, setDashUploadProgress] = useState<UploadProgressViewState | null>(null);

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleDashDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    // Don't activate the dashboard overlay if the drag is over a pane —
    // pane events bubble up too. We rely on react's synthetic events: when a
    // pane handles dragenter and calls preventDefault, the bubbling parent
    // still sees the event, but we want to NOT show our overlay if the
    // drag's actual target is inside a pane. Use composedPath / target to
    // check.
    const targetIsPane = (e.target as HTMLElement | null)?.closest?.('.terminal-pane');
    if (targetIsPane) return;
    e.preventDefault();
    dashDragDepthRef.current += 1;
    if (dashDragDepthRef.current === 1) {
      setDashDropzoneVisible(true);
      setDashDroppedFileCount(e.dataTransfer.items.length);
    }
  }, []);

  const handleDashDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    const targetIsPane = (e.target as HTMLElement | null)?.closest?.('.terminal-pane');
    if (targetIsPane) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDashDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dashDragDepthRef.current = Math.max(0, dashDragDepthRef.current - 1);
    if (dashDragDepthRef.current === 0) setDashDropzoneVisible(false);
  }, []);

  const progressForFile = useCallback(
    (fileName: string, fileIndex: number, fileCount: number) =>
      (progress: UploadProgress) => {
        setDashUploadProgress({
          fileName,
          fileIndex,
          fileCount,
          phase: progress.phase,
          percent: progress.percent,
        });
      },
    [],
  );

  const handleDashDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    // If the drop landed inside a pane, let the pane handle it.
    const targetIsPane = (e.target as HTMLElement | null)?.closest?.('.terminal-pane');
    if (targetIsPane) return;
    e.preventDefault();
    dashDragDepthRef.current = 0;
    setDashDropzoneVisible(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const electron = getElectron();
    const absPaths: string[] = [];
    const errors: string[] = [];

    for (const [fileIndex, file] of files.entries()) {
      const path = electron?.getPathForFile?.(file) ?? null;
      try {
        if (path && !activeProject?.backendConnectionId) {
          absPaths.push(path);
          continue;
        }
        const cwd = activeProject?.cwd
          ?? (activeProject?.id ? await getWebUploadCwd(activeProject.id) : null);
        if (!cwd || !activeProject?.id) {
          errors.push(`${file.name}: no workspace folder`);
          continue;
        }
        const result = await importWorkspaceFileUpload(activeProject.id, cwd, file, {
          onProgress: progressForFile(file.name, fileIndex, files.length),
          subdir: '.attachments',
        });
        const abs = result.filePath.startsWith('/')
          ? result.filePath
          : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
        absPaths.push(abs);
      } catch (err) {
        errors.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setDashUploadProgress(null);

    if (absPaths.length > 0) {
      // Forward to the focused pane (or first pane) so the chip lands on its
      // composer just like clicking the pane's + button would.
      window.dispatchEvent(new CustomEvent('michi:attach-paths', {
        detail: { paths: absPaths },
      }));
    }

    if (errors.length > 0) {
      toast.error(
        `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
        { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
      );
    }
  }, [activeProject, progressForFile]);

  const revealRef = useRef<(() => void) | null>(null);
  const lastReveal = useRef<{ scope: string; focused: string | null; mode: string; ready: boolean; ids: string[]; width: number } | null>(null);
  useLayoutEffect(() => {
    if (layout.waitingForExit) {
      revealRef.current?.();
      return;
    }
    const scope = paneScope;
    const previous = lastReveal.current;
    lastReveal.current = { scope, focused: focusedPane, mode: phone ? 'phone' : prefs.paneWidthMode, ready: layout.ready, ids: activePanes, width: stripRef.current?.clientWidth ?? 0 };
    const strip = stripRef.current;
    const revealPane = phone ? visiblePhonePane : focusedPane;
    const index = revealPane ? openPanes.indexOf(revealPane) : -1;
    if (!strip || index < 0 || !layout.ready) return;
    const requested = !previous || previous.scope !== scope || previous.focused !== focusedPane
      || previous.mode !== (phone ? 'phone' : prefs.paneWidthMode) || !previous.ready
      || (phone && previous.width !== strip.clientWidth);
    // Closing the focused pane reveals its predecessor on the same clock as
    // the covering boundaries. Background closes preserve the current view.
    const closing = previous?.scope === scope && previous.ids.some(id => !activePanes.includes(id));
    if (!requested && !closing) return;
    revealRef.current?.();
    const left = layout.positions[index];
    const total = layout.padding + layout.contentWidth + layout.paddingRight;
    const keepPosition = closing && previous?.focused === focusedPane;
    const target = Math.max(0, Math.min(keepPosition ? strip.scrollLeft : left + layout.widths[index] / 2 - strip.clientWidth / 2, total - strip.clientWidth));
    const captions = strip.closest('.terminal-shell')?.querySelector<HTMLElement>('[data-pane-captions]');
    const mirror = (left: number) => { if (captions) captions.style.transform = `translateX(${-left}px)`; };
    if (layout.animationRef.current) {
      const stop = scrollWithPaneLayout(strip, layout.animationRef.current, target, mirror);
      const viewport = captions?.parentElement;
      viewport?.addEventListener('wheel', stop, { passive: true });
      revealRef.current = () => { stop(); viewport?.removeEventListener('wheel', stop); };
    } else {
      strip.scrollTo({ left: target, behavior: 'instant' });
      mirror(strip.scrollLeft);
    }
  }, [paneScope, focusedPane, openPanes, activePanes, prefs.paneWidthMode, phone, visiblePhonePane, layout]);

  useLayoutEffect(() => () => { revealRef.current?.(); }, []);

  useLayoutEffect(() => {
    if (!layout.ready || layout.waitingForExit) return;
    return afterPaneMotion(layout.animationRef.current, settleFocus);
  }, [layout, settleFocus]);

  const previousEntrance = useRef({ scope: '', ids: openPanes });
  const entrances = useRef(new Map<string, Animation>());
  const previousExits = useRef<ReadonlySet<string>>(new Set());
  const focusBeforeRef = useRef(focusedPane);
  useLayoutEffect(() => {
    const scope = paneScope;
    const previous = previousEntrance.current;
    previousEntrance.current = { scope, ids: openPanes };
    const reduced = phone || prefs.reduceMotion || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    for (const [id, animation] of entrances.current) {
      if (!openPanes.includes(id) || previous.scope !== scope || reduced) {
        animation.cancel(); entrances.current.delete(id);
      }
    }
    if (previous.scope !== scope || reduced) {
      previousExits.current = exitingIds;
      return;
    }
    for (const id of openPanes) {
      const exiting = exitingIds.has(id);
      const reopening = previousExits.current.has(id) && !exiting;
      if (exiting === previousExits.current.has(id) && previous.ids.includes(id)) continue;
      const surface = paneRefs.current[id]?.querySelector<HTMLElement>('.pane-entry-surface');
      if (!surface || typeof surface.animate !== 'function') continue;
      if (exiting) {
        // Freeze an interrupted entrance. Closing is only the outer covering
        // motion, never an independent fade with a separate removal callback.
        const entrance = entrances.current.get(id);
        entrance?.pause();
        continue;
      }
      // A branch just made from a pane here is pulled out of its parent; the
      // content comes in from the side of the pane the user was on.
      const branch = !reopening && isFreshBranch(activeProject?.edges, id);
      const anchor = focusBeforeRef.current ? openPanes.indexOf(focusBeforeRef.current) : -1;
      const side = anchor >= 0 && openPanes.indexOf(id) < anchor ? 'left' : 'right';
      const { frames, duration } = paneEntrance(prefs.paneSpawnAnimation, { branch, from: side });
      const current = reopening ? getComputedStyle(surface) : null;
      const from = current ? { opacity: current.opacity, transform: current.transform } : frames[0];
      entrances.current.get(id)?.cancel();
      const animation = surface.animate([from, frames[1]], {
        duration, easing: PANE_EASE, fill: 'both',
      });
      entrances.current.set(id, animation);
      animation.onfinish = () => {
        if (entrances.current.get(id) !== animation) return;
        animation.cancel(); entrances.current.delete(id);
      };
    }
    previousExits.current = exitingIds;
  }, [openPanes, exitingIds, paneScope, prefs.paneSpawnAnimation, phone, prefs.reduceMotion, activeProject?.edges]);
  // After the entrance above: it reads the focus of the commit before.
  useLayoutEffect(() => { focusBeforeRef.current = focusedPane; });
  useLayoutEffect(() => {
    const running = entrances.current;
    return () => { for (const animation of running.values()) animation.cancel(); running.clear(); };
  }, []);

  // A resize or settled layout can bring an off-screen branch into view.
  useLayoutEffect(() => { recheckArrivals(); }, [layout.settledVersion, layout.contentWidth, recheckArrivals]);

  // Runs after the reveal above has scrolled the strip to the new pane.
  const previousPhonePane = useRef({ scope: paneScope, id: visiblePhonePane, ids: activePanes });
  const stopBranchPush = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = previousPhonePane.current;
    previousPhonePane.current = { scope: paneScope, id: visiblePhonePane, ids: activePanes };
    if (phone && previous.scope === paneScope && previous.id === visiblePhonePane) return;
    stopBranchPush.current?.();
    stopBranchPush.current = null;
    if (!phone || !layout.ready || previous.scope !== paneScope || !previous.id || !visiblePhonePane) return;
    if (previous.ids.includes(visiblePhonePane) || !isFreshBranch(activeProject?.edges, visiblePhonePane)) return;
    // A launcher becomes the new chat in place; there is no parent to leave.
    if (activeItems[previous.id]?.kind === 'launcher') return;
    const incoming = paneRefs.current[visiblePhonePane];
    const outgoing = paneRefs.current[previous.id];
    if (!incoming || !outgoing) return;
    const title = incoming.closest('.terminal-shell')?.querySelector('.mobile-pane-title');
    stopBranchPush.current = playBranchPush(incoming, outgoing, title);
  }, [paneScope, visiblePhonePane, activePanes, phone, layout.ready, activeProject?.edges, activeItems]);
  useLayoutEffect(() => () => { stopBranchPush.current?.(); }, []);

  if (!activeProject) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 'var(--fs-lg)',
        }}
      >
        — no workspace —
      </div>
    );
  }
  if (activeProject.activeTreeId === null && openPanes.length === 0 && browserItems.length === 0) {
    return <EmptyThreads />;
  }
  if (openPanes.length === 0 && browserItems.length === 0) {
    return <TerminalHome onSubmitted={() => {}} />;
  }
  const effContentWidth =
    activePanes.length - browserItems.length === 1 && !layout.waitingForExit && prefs.singlePaneContentWidth !== null
      ? prefs.singlePaneContentWidth
      : null;
  const { overflow, gridTemplateColumns } = layout;
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
    <div
      style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0, minWidth: 0 }}
    >
    <div
      ref={stripRef}
      data-pane-width-mode={prefs.paneWidthMode}
      data-phone-panes={phone || undefined}
      className={['terminal-dashboard', 'hide-sb'].join(' ')}
      onScroll={() => {
        const thumb = thumbRef.current;
        updateThumbGeometry();
        if (thumb) thumb.style.opacity = '1';
        if (scrollIdleTimerRef.current !== null) {
          window.clearTimeout(scrollIdleTimerRef.current);
        }
        scrollIdleTimerRef.current = window.setTimeout(() => {
          if (thumb) thumb.style.opacity = '0';
          scrollIdleTimerRef.current = null;
        }, 600);
        // Notify native overlay surfaces (BrowserPane) that the strip
        // scrolled so they can re-sync their bounds. The DOM scroll event
        // on this container does not bubble to `window`.
        window.dispatchEvent(new Event('michi:dashboard-scroll'));
        recheckArrivals();
      }}
      onMouseDown={handlePaneSelectionMouseDown}
      onDragEnter={handleDashDragEnter}
      onDragOver={handleDashDragOver}
      onDragLeave={handleDashDragLeave}
      onDrop={(e) => { void handleDashDrop(e); }}
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns,
        gap: 'var(--term-dashboard-gap, 0px)',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflowX: !phone && (overflow || exitingIds.size > 0) ? 'auto' : 'hidden',
        overflowY: 'hidden',
        position: 'relative', /* anchor offsetLeft for scrollToPane */
        padding: 'var(--term-dashboard-padding, 0px)',
        boxSizing: 'border-box',
        // Extra right padding so the last pane can be scrolled to center
        // rather than stuck at the viewport's right edge.
        paddingRight: layout.paddingRight,
      }}
    >
      {openPanes.map((id, i) => {
        const wrapStyle: React.CSSProperties = {
          position: 'relative',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // Pane wrapper needs pane bg so TPane's opacity-dim composites against
          // the same color the caption cell composites against (Topbar zone 2
          // is also pane-bg). Without this, unfocused TPane shows through to
          // shell-bg while the caption shows through to pane-bg — same dim
          // formula yields visibly different colors.
          background: 'var(--term-pane-bg)',
          overflow: 'clip',
          ...layout.paneStyles[i],
          visibility: phone && id !== visiblePhonePane ? 'hidden' : undefined,
        };
        return (
          <div
            key={id}
            ref={(el) => { paneRefs.current[id] = el; }}
            data-node-id={id}
            data-pane-exiting={exitingIds.has(id) ? '' : undefined}
            aria-hidden={exitingIds.has(id) || (phone && id !== visiblePhonePane) || undefined}
            inert={exitingIds.has(id) || (phone && id !== visiblePhonePane)}
            style={wrapStyle}
          >
            <div className="pane-entry-surface" style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
            <RetainedPaneContent exiting={exitingIds.has(id)}>
            <PaneErrorBoundary paneId={id}>
              {paneItems[id] ? (
                <Suspense fallback={<div style={{ padding: 16, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>loading {paneItems[id].kind}…</div>}>
                  {paneItems[id].kind === 'launcher' ? <PaneChooser item={paneItems[id]} />
                    : paneItems[id].kind === 'files' ? <FilesPane item={paneItems[id]} />
                    : paneItems[id].kind === 'review' ? <ReviewPane item={paneItems[id]} />
                    : paneItems[id].kind === 'file' ? <FilePane item={paneItems[id]} />
                    : paneItems[id].kind === 'diff' ? <DiffPane item={paneItems[id]} />
                    : paneItems[id].kind === 'terminal' ? <TerminalPane item={paneItems[id]} />
                    : paneItems[id].kind === 'agent-run' ? <AgentRunPaneSurface item={paneItems[id]} />
                    : paneItems[id].kind === 'page' ? <PagePane item={paneItems[id] as PagePaneItem} />
                    : paneItems[id].kind === 'workflow-run' ? <WorkflowRunPaneSurface item={paneItems[id]} />
                    : null}
                </Suspense>
              ) : paneKinds[i] === 'digest' ? (
                <DigestPane nodeId={id} contentMaxWidth={effContentWidth} />
              ) : paneKinds[i] === 'artifact' ? (
                <ArtifactPane nodeId={id} contentMaxWidth={effContentWidth} />
              ) : (
                <AssistantPaneScope nodeId={id}>
                  <TPane nodeId={id} contentMaxWidth={effContentWidth} />
                </AssistantPaneScope>
              )}
            </PaneErrorBoundary>
            </RetainedPaneContent>
            </div>
            {!phone && <ResizeHandle
                paneRef={{ current: paneRefs.current[id] ?? null }}
                onResize={(w) => setPaneWidth(id, w)}
                onReset={() => setPaneWidth(id, undefined)}
              />}
          </div>
        );
      })}
      {exitingIds.size > 0 && (
        <div aria-hidden data-pane-scroll-extent style={{ position: 'absolute', left: Math.max(0, layout.scrollExtent - 1), top: 0, width: 1, height: 1, pointerEvents: 'none' }} />
      )}
      {dashDropzoneVisible && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: '2px dashed var(--term-accent)',
            background: 'color-mix(in srgb, var(--term-accent) 12%, transparent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 'var(--z-pane-overlay)',
          }}
        >
          <div
            style={{
              background: 'var(--term-bg)',
              border: '1px solid var(--term-accent)',
              color: 'var(--term-accent)',
              padding: '8px 18px',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--fs-md)',
              borderRadius: 'var(--ui-radius-sm)',
            }}
          >
            drop {dashDroppedFileCount} file{dashDroppedFileCount === 1 ? '' : 's'} · attach to message
          </div>
        </div>
      )}
      {dashUploadProgress && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 24,
            transform: 'translateX(-50%)',
            width: 'min(420px, calc(100% - 48px))',
            background: 'var(--term-bg)',
            border: '1px solid var(--term-line)',
            boxShadow: 'var(--ui-popover-shadow)',
            zIndex: 'calc(var(--z-pane-overlay) + 1)',
            pointerEvents: 'none',
          }}
        >
          <UploadProgressBar progress={dashUploadProgress} compact />
        </div>
      )}
    </div>
      {!phone && <PaneArrivalTabs ids={arrivals} onOpen={focusPane} />}
      {!phone && overflow && (
        <div
          ref={thumbRef}
          className="dashboard-hscroll-thumb"
          style={{ opacity: 0 }}
          aria-hidden
        />
      )}
    </div>
    {browserItems.length > 0 && <BrowserDock key={`${activeProject.id}::${activeProject.activeTreeId ?? ''}`} items={browserItems} focusedPane={focusedPane} />}
    </div>
  );
}
