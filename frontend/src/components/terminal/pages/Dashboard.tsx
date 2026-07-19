import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatActions, useChatProjects, useStructuralSelector, shallowArrayEqual } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { usePrefs } from '../../../state/prefs';
import EmptyThreads from '../../EmptyThreads';
import ResizeHandle from '../../ResizeHandle';
import TPane from '../TPane';
import DigestPane from '../DigestPane';
import ArtifactPane from '../ArtifactPane';
import PaneErrorBoundary from '../PaneErrorBoundary';
import TerminalHome from './Home';
import { getElectron } from '../../../lib/electronBridge';
import { getWebUploadCwd, importWorkspaceFileUpload, type UploadProgress } from '../../../services/api';
import { toast } from 'sonner';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';

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
  const { activeProject, openPanes, focusedPane } = useChatProjects();
  const { setPaneWidth } = useChatActions();
  const { prefs } = usePrefs();
  const selectPaneWidths = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      openPanes.map((id) => nodesMap[id]?.paneWidth),
    [openPanes],
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
  // Scroll sync with Topbar's caption strip — see Topbar.tsx comment for the
  // event protocol. The guard suppresses echo when WE got moved.
  const programmaticScrollRef = useRef(false);
  // Overlay scrollbar — native scrollbar is hidden via .hide-sb on the
  // strip; we render our own thumb as a sibling and reposition it from the
  // strip's onScroll. Idle thumb is opacity 0; we set opacity 1 while the
  // user is actively scrolling, then fade out 600ms after the last event.
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);

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
  }, [updateThumbGeometry, openPanes.length]);

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const onCaptionScroll = (e: Event) => {
      const detail = (e as CustomEvent<{ scrollLeft: number }>).detail;
      const el = stripRef.current;
      if (!el) return;
      if (Math.abs(el.scrollLeft - detail.scrollLeft) < 0.5) return;
      programmaticScrollRef.current = true;
      el.scrollLeft = detail.scrollLeft;
      requestAnimationFrame(() => { programmaticScrollRef.current = false; });
    };
    window.addEventListener('michi:caption-scroll', onCaptionScroll as EventListener);
    return () => window.removeEventListener('michi:caption-scroll', onCaptionScroll as EventListener);
  }, []);
  // Map of pane id → stagger index for the spawn-in animation. Cleared after
  // the keyframe duration so re-renders don't replay the flash.
  const [spawnStagger, setSpawnStagger] = useState<Map<string, number>>(new Map());

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
        if (path) {
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

  const scrollToPane = (id: string, behavior: ScrollBehavior = 'smooth') => {
    const strip = stripRef.current;
    if (!strip) return;
    const el = strip.querySelector<HTMLDivElement>(`[data-node-id="${id}"]`);
    if (!el) return;
    // Horizontal-only: don't use scrollIntoView, which can scroll inner pane
    // scrollers vertically as a side-effect.
    const stripRect = strip.getBoundingClientRect();
    const paneRect = el.getBoundingClientRect();
    // Allow scrolling past the natural end so the last pane can be centered
    // instead of stuck at the right edge. The extra scrollable room comes from
    // paddingRight on the grid container (see below).
    const clamped = centeredPaneScrollLeft({
      paneLeft: paneRect.left,
      paneWidth: paneRect.width,
      stripLeft: stripRect.left,
      stripWidth: strip.clientWidth,
      currentScrollLeft: strip.scrollLeft,
      maxScrollLeft: strip.scrollWidth - strip.clientWidth,
    });
    strip.scrollTo({ left: clamped, behavior });
  };

  // This runs before the Dashboard paints after Overview navigation, so the
  // newly focused node is already in view instead of showing a stale pane for
  // one frame (or waiting through a smooth-scroll animation).
  useLayoutEffect(() => {
    if (!focusedPane) return;
    scrollToPane(focusedPane, 'auto');
  }, [focusedPane]);

  // When new panes are appended (agent spawn_branches, fanout, manual open),
  // scroll the newly-added one into view even if focus didn't move. Closing a
  // pane shrinks openPanes — we skip that case so we don't yank the viewport.
  // Also flag the new IDs for the spawn-in animation, with a stagger index so
  // multiple branches "fan out" rather than appearing simultaneously.
  // A freshly mounted Dashboard already receives a focused pane (for example
  // when Branches opens a node). Treating that whole restored list as
  // "new" would schedule a second scroll to its last pane and overwrite the
  // focused-node landing position.
  const prevOpenPanesRef = useRef<string[]>(openPanes);
  useEffect(() => {
    const prev = prevOpenPanesRef.current;
    const added = openPanes.filter((id) => !prev.includes(id));
    prevOpenPanesRef.current = openPanes;
    if (added.length === 0) return;
    setSpawnStagger((cur) => {
      const next = new Map(cur);
      added.forEach((id, i) => next.set(id, i));
      return next;
    });
    // Clear stagger entries after the keyframe duration so subsequent
    // re-renders don't trigger the flash again on settled panes.
    const clearAt = window.setTimeout(() => {
      setSpawnStagger((cur) => {
        const next = new Map(cur);
        added.forEach((id) => next.delete(id));
        return next;
      });
    }, 600 + added.length * 80);
    // Wait one frame so the new pane is laid out before we measure offsetLeft.
    const target = added[added.length - 1];
    requestAnimationFrame(() => scrollToPane(target));
    return () => window.clearTimeout(clearAt);
  }, [openPanes]);

  if (!activeProject) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 13,
        }}
      >
        — no workspace —
      </div>
    );
  }
  if (activeProject.activeTreeId === null) {
    return <EmptyThreads />;
  }
  if (openPanes.length === 0) {
    return <TerminalHome onSubmitted={() => {}} />;
  }
  const effContentWidth =
    openPanes.length === 1 && prefs.singlePaneContentWidth !== null
      ? prefs.singlePaneContentWidth
      : null;
  const overflow = openPanes.length > 2;
  const gridTemplateColumns = overflow
    ? openPanes.map((_, i) => {
        const w = widths[i];
        return w !== undefined ? `${w}px` : `minmax(${prefs.defaultPaneWidth}px, 1fr)`;
      }).join(' ')
    : openPanes.map((_, i) => {
        const w = widths[i];
        // minmax(0, ${w}px) lets the column shrink when the viewport is
        // narrower than the user-set width — without this, a fixed `${w}px`
        // track stays put and the pane gets clipped (overflowX is hidden in
        // non-overflow mode).
        return w !== undefined ? `minmax(0, ${w}px)` : '1fr';
      }).join(' ');
  return (
    <div
      style={{ flex: 1, position: 'relative', display: 'flex', minHeight: 0 }}
    >
    <div
      ref={stripRef}
      className={['terminal-dashboard', 'hide-sb'].join(' ')}
      onScroll={(e) => {
        const el = e.currentTarget;
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
        if (programmaticScrollRef.current) return;
        window.dispatchEvent(
          new CustomEvent('michi:dashboard-scroll', {
            detail: { scrollLeft: el.scrollLeft },
          }),
        );
      }}
      onDragEnter={handleDashDragEnter}
      onDragOver={handleDashDragOver}
      onDragLeave={handleDashDragLeave}
      onDrop={(e) => { void handleDashDrop(e); }}
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns,
        gap: 'var(--term-dashboard-gap, 0px)',
        minHeight: 0,
        height: '100%',
        overflowX: overflow ? 'auto' : 'hidden',
        overflowY: 'hidden',
        position: 'relative', /* anchor offsetLeft for scrollToPane */
        padding: 'var(--term-dashboard-padding, 0px)',
        boxSizing: 'border-box',
        // Extra right padding so the last pane can be scrolled to center
        // rather than stuck at the viewport's right edge.
        paddingRight: overflow ? 'calc(50vw - 240px)' : 'var(--term-dashboard-padding, 0px)',
      }}
    >
      {openPanes.map((id, i) => {
        const stagger = spawnStagger.get(id);
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
        };
        if (stagger !== undefined) {
          wrapStyle.animation = 'tSpawn 360ms ease-out both';
          wrapStyle.animationDelay = `${stagger * 80}ms`;
        }
        return (
          <div
            key={id}
            ref={(el) => { paneRefs.current[id] = el; }}
            data-node-id={id}
            style={wrapStyle}
          >
            <PaneErrorBoundary paneId={id}>
              {paneKinds[i] === 'digest' ? (
                <DigestPane nodeId={id} contentMaxWidth={effContentWidth} />
              ) : paneKinds[i] === 'artifact' ? (
                <ArtifactPane nodeId={id} contentMaxWidth={effContentWidth} />
              ) : (
                <TPane nodeId={id} contentMaxWidth={effContentWidth} />
              )}
            </PaneErrorBoundary>
            <ResizeHandle
                paneRef={{ current: paneRefs.current[id] } as React.RefObject<HTMLDivElement>}
                onResize={(w) => setPaneWidth(id, w)}
                onReset={() => setPaneWidth(id, undefined)}
              />
          </div>
        );
      })}
      {dashDropzoneVisible && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: '2px dashed var(--term-accent)',
            background: 'rgba(47, 143, 115, .15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: 'var(--term-bg)',
              border: '1px solid var(--term-accent)',
              color: 'var(--term-accent)',
              padding: '8px 18px',
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              borderRadius: 3,
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
            boxShadow: 'var(--term-popover-shadow, 0 8px 24px rgba(0,0,0,0.16))',
            zIndex: 101,
            pointerEvents: 'none',
          }}
        >
          <UploadProgressBar progress={dashUploadProgress} compact />
        </div>
      )}
    </div>
      {overflow && (
        <div
          ref={thumbRef}
          className="dashboard-hscroll-thumb"
          style={{ opacity: 0 }}
          aria-hidden
        />
      )}
    </div>
  );
}
