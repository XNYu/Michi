import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChatActions, useChatNode, useChatProjects, useStructuralSelector, shallowArrayEqual, chatLabel } from '../../state/chatStore';
import type { ChatNodeState, ContextEntry, ProjectEdge } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { stripBranchPrefix, parseFanoutCommand, shouldBranchOnSubmit } from '../nodes/chatNodeUtils';
import SelectionActions from '../SelectionActions';
import MentionEditor, { type MentionEditorHandle } from '../MentionEditor';
import type { MentionRecord } from '../mentions';
import { expandMentions } from '../mentions';
import { findTreeIdForNode } from '../../state/tree';
import { formatQuotedMessage } from '../../lib/quoteFormat';
import { buildAnchorMap, type ChildAnchor } from '../../state/branchAnchors';
import { formatCommentsBlock, joinMessageParts } from '../../lib/commentFormat';
import { getElectron } from '../../lib/electronBridge';
import { getWebUploadCwd, importWorkspaceFile, importWorkspaceFileUpload, type UploadProgress } from '../../services/api';
import { toast } from 'sonner';
import { appendAttachmentsSentinel } from '../../lib/composerAttachments';
import { saveAgentOptions } from '../../services/api';
import { useAgentModelCatalog } from '../../hooks/useAgentModelCatalog';
import UploadProgressBar, { type UploadProgressViewState } from '../UploadProgressBar';
import PermissionBanner from './PermissionBanner';
import UserInputBanner from './UserInputBanner';
import MergeBanner from './MergeBanner';
import PaneFind from './PaneFind';
import { ComposerShell, type ComposerShellHandle } from './ComposerShell';
import { PaneMessageList } from './PaneMessageList';
import { PaneComposerPreBlocks, type PanePendingAttachment } from './PaneComposerPreBlocks';
import { PaneComposerActions, type PaneComposerSendMode } from './PaneComposerActions';
import { PaneComposerToolbarLeft } from './PaneComposerToolbarLeft';
import { PaneAgentMenus } from './PaneAgentMenus';
import { FileDropOverlay, PaneDropIndicator } from './PaneDragOverlays';
import { nextFollowScrollTop } from './scrollPinning';
import * as perf from '../../services/perf';

// Shared module-level flag flipped by the Sidebar's `michi:sidebar-animating`
// event. While true, every pane skips ResizeObserver-driven reflow work so
// the sidebar's width transition stays smooth even with many tabs open.
// Each pane registers a flush callback that runs once when the flag clears.
const sidebarAnimatingRef = { current: false };
const animationEndCallbacks = new Set<() => void>();
const PROGRAMMATIC_SCROLL_WINDOW_MS = 800;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;
// Mount-time scroll restore: the target is re-derived from the anchor's live
// rect and re-applied every time the content's size changes — the container
// sets overflow-anchor:none, so nothing else compensates when
// content-visibility inflation (72px estimates → real heights), composer
// measurement or image loads shift the content under the viewport. The
// restore holds the anchor until the layout has been quiet for QUIET_MS
// (hard cap MAX_MS), or the user scrolls.
const RESTORE_QUIET_MS = 350;
const RESTORE_MAX_MS = 3000;

// Persists per-pane scroll anchors across pane unmount/remount AND page
// refresh. Backed by localStorage with an LRU cap so it doesn't grow
// unbounded.
//
// Entries are message anchors, NOT pixel scrollTops: message frames render
// with content-visibility:auto (72px intrinsic-size estimates until they come
// near the viewport), so scrollHeight right after mount bears no relation to
// the layout a pixel offset was measured under — restoring one lands on an
// arbitrary message, usually clamped toward the top. An anchor id survives
// the estimate → real-height inflation.
const SCROLL_CACHE_LS_KEY = 'michi:paneScrollAnchors';
const SCROLL_CACHE_MAX_ENTRIES = 200;

export interface PaneScrollEntry {
  /** data-msg-id of the topmost visible message when the pane was left. */
  anchorId: string | null;
  /** anchor top − viewport top at save time, px (≤ 0 when the viewport sat partway into the anchor message). */
  offset: number;
  /** Pane was left pinned within 24px of the bottom (and not mid-stream). */
  atBottom: boolean;
  /**
   * Max message createdAt present when the pane was left. Messages newer
   * than this landed after the user last had the pane open — the unread
   * horizon. Deliberately independent of node.viewedAt, which activateTree
   * resets to Date.now() in the same click that opens the pane, before the
   * pane can read it.
   */
  lastSeen: number;
}

/**
 * Where the first unseen message sits after an unread restore, as a fraction
 * of the viewport height from the top — upper-middle, matching the 30% anchor
 * used when a freshly-sent user message is scrolled into view.
 */
const UNSEEN_TOP_FRACTION = 0.3;

export interface PaneRestoreTarget {
  /**
   * unseen — anchorId is the first message newer than the saved lastSeen
   *          horizon; park it at UNSEEN_TOP_FRACTION of the viewport height
   *          (offset is unused and 0).
   * anchor — anchorId is the message the user was looking at when they
   *          left; put it back at its saved viewport offset.
   * bottom — pin to the bottom (left-at-bottom, first visit on this
   *          device, or the saved anchor is unusable).
   */
  kind: 'unseen' | 'anchor' | 'bottom';
  anchorId?: string;
  offset: number;
}

/**
 * Decide where a freshly-mounted idle pane should land, from the anchor
 * entry saved when it was last left and the node's current messages.
 * Returns null when there is nothing to position over (no messages).
 */
export function resolvePaneRestore(
  saved: PaneScrollEntry | undefined,
  messages: readonly { id: string; createdAt?: number }[],
): PaneRestoreTarget | null {
  if (messages.length === 0) return null;
  if (saved && saved.lastSeen > 0) {
    const firstUnseen = messages.find((m) => (m.createdAt ?? 0) > saved.lastSeen);
    if (firstUnseen) return { kind: 'unseen', anchorId: firstUnseen.id, offset: 0 };
  }
  if (saved && !saved.atBottom && saved.anchorId) {
    return { kind: 'anchor', anchorId: saved.anchorId, offset: saved.offset };
  }
  return { kind: 'bottom', offset: 0 };
}

const paneScrollCache = (() => {
  const map = new Map<string, PaneScrollEntry>();

  // Hydrate from localStorage on startup
  try {
    // Drop the pre-anchor pixel cache from earlier builds.
    window.localStorage.removeItem('michi:paneScrollPositions');
    const raw = window.localStorage.getItem(SCROLL_CACHE_LS_KEY);
    if (raw) {
      const entries: [string, PaneScrollEntry][] = JSON.parse(raw);
      for (const [k, v] of entries) {
        if (v && typeof v === 'object' && typeof v.lastSeen === 'number') map.set(k, v);
      }
    }
  } catch { /* corrupt or missing — start fresh */ }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    flushTimer = null;
    // Keep only the most recent entries (Map iteration = insertion order)
    const entries = [...map.entries()];
    const trimmed = entries.slice(-SCROLL_CACHE_MAX_ENTRIES);
    try {
      window.localStorage.setItem(SCROLL_CACHE_LS_KEY, JSON.stringify(trimmed));
    } catch { /* quota — non-critical */ }
  }

  function scheduleFlush() {
    if (flushTimer == null) flushTimer = setTimeout(flush, 1000);
  }

  // pagehide rather than beforeunload: panes write their final anchor on
  // beforeunload, which fires first — flushing here catches those writes.
  window.addEventListener('pagehide', () => {
    if (flushTimer != null) { clearTimeout(flushTimer); flush(); }
  });

  return {
    get(key: string) { return map.get(key); },
    set(key: string, value: PaneScrollEntry) {
      map.delete(key); // reinsert at end for LRU ordering
      map.set(key, value);
      scheduleFlush();
    },
  };
})();
const PANE_PERF_SLOW_COMMIT_MS = 16;
const EMPTY_CONTEXTS: ContextEntry[] = [];
const EMPTY_EDGES: readonly ProjectEdge[] = [];
const EMPTY_SAME_TREE_NODES: ChatNodeState[] = [];
const EMPTY_MERGE_SOURCE_LABELS: string[] = [];
const EMPTY_CONTEXT_NAMES: ReadonlySet<string> = new Set();

function anchorEqual(a: ChildAnchor, b: ChildAnchor): boolean {
  return (
    a.childNodeId === b.childNodeId &&
    a.title === b.title &&
    (a.messageCount ?? 0) === (b.messageCount ?? 0) &&
    a.createdAt === b.createdAt &&
    a.status === b.status &&
    (a.quotedText ?? '') === (b.quotedText ?? '')
  );
}

function anchorMapEqual(a: Map<string, ChildAnchor[]>, b: Map<string, ChildAnchor[]>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [messageId, prevAnchors] of a) {
    const nextAnchors = b.get(messageId);
    if (!nextAnchors || prevAnchors.length !== nextAnchors.length) return false;
    for (let i = 0; i < prevAnchors.length; i += 1) {
      if (!anchorEqual(prevAnchors[i], nextAnchors[i])) return false;
    }
  }
  return true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('michi:sidebar-animating', (e) => {
    const animating = (e as CustomEvent<{ animating: boolean }>).detail.animating;
    sidebarAnimatingRef.current = animating;
    if (!animating) {
      // Flush queued resize-driven work after the next paint so the layout has
      // settled to its final width before observers re-measure.
      requestAnimationFrame(() => {
        for (const cb of animationEndCallbacks) cb();
      });
    }
  });
}

// Walk `el`'s text nodes and build a DOM Range for each occurrence of `q`
// (already lowercased), in document order, left-to-right.
function rangesInElement(el: Element, q: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const lower = textNode.data.toLowerCase();
    let idx = 0;
    while (idx < lower.length) {
      const found = lower.indexOf(q, idx);
      if (found === -1) break;
      const r = document.createRange();
      r.setStart(textNode, found);
      r.setEnd(textNode, found + q.length);
      ranges.push(r);
      idx = found + q.length;
    }
  }
  return ranges;
}

// Every occurrence of `q` across all messages under `root` (persistent overlay).
function collectFindRanges(root: Element, q: string): Range[] {
  const ranges: Range[] = [];
  for (const msgEl of Array.from(root.querySelectorAll('[data-msg-id]'))) {
    ranges.push(...rangesInElement(msgEl, q));
  }
  return ranges;
}

// Briefly flash a DOM Range by overlaying an absolutely-positioned, fading box
// on top of it. Uses a real stylesheet animation (index.css .t-find-flash) and a
// rAF loop to keep the box glued to the text while a smooth scroll is in flight,
// so it works regardless of CSS Custom Highlight API support. Returns a cancel fn.
function flashMatchOverlay(range: Range): () => void {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    return () => {};
  }
  const overlay = document.createElement('div');
  overlay.className = 't-find-flash';
  document.body.appendChild(overlay);
  const startedAt = performance.now();
  let raf = 0;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    overlay.remove();
  };
  const position = (now: number) => {
    const rect = range.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    if (now - startedAt < 650) {
      raf = requestAnimationFrame(position);
    } else {
      cleanup();
    }
  };
  raf = requestAnimationFrame(position);
  return cleanup;
}

type ComposerDraftState = { value: string; mentions: MentionRecord[] };

const EMPTY_COMPOSER_DRAFT: ComposerDraftState = { value: '', mentions: [] };

function messageRenderStats(node: ChatNodeState | undefined) {
  if (!node) return { messages: 0, chars: 0, codeFences: 0 };
  let chars = 0;
  let codeFences = 0;
  for (const m of node.messages) {
    chars += m.text?.length ?? 0;
    codeFences += (m.text?.match(/```/g)?.length ?? 0) / 2;
    for (const b of m.blocks ?? []) {
      if (b.kind !== 'answer' && b.kind !== 'thinking') continue;
      chars += b.rawText.length;
      codeFences += (b.rawText.match(/```/g)?.length ?? 0) / 2;
    }
  }
  return {
    messages: node.messages.length,
    chars,
    codeFences: Math.floor(codeFences),
  };
}

function TPane({ nodeId, contentMaxWidth }: { nodeId: string; contentMaxWidth?: number | null }) {
  const renderStartedAt = perf.enabled() ? perf.now() : 0;
  const {
    focusPane,
    closePane,
    sendMessage,
    retryLastTurn,
    cancelStream,
    isObserver,
    createChildChat,
    createBlankChild,
    fanoutBranches,
    setFocusedNodeId,
    switchAgent,
    resolvePermission,
    denyPermission,
    resolveUserInputRequest,
    skipUserInputRequest,
    addPendingComment,
    editPendingComment,
    removePendingComment,
    clearPendingComments,
    queueMessage,
    dequeueMessage,
    setComposerDraft,
    reorderPane,
  } = useChatActions();
  const {
    focusedPane,
    availableModes,
    agentStatus,
    refreshAgentStatus,
    activeProject,
  } = useChatProjects();
  const { prefs } = usePrefs();
  const paneShellStyle = usePaneShellStyle(nodeId);
  const n = useChatNode(nodeId);
  // Latest node state for callbacks that outlive their render closure — the
  // unmount-time scroll save reads messages through this.
  const nLatestRef = useRef(n);
  nLatestRef.current = n;
  const hasCommittedRef = useRef(false);
  useEffect(() => {
    if (!perf.enabled()) return;
    const phase = hasCommittedRef.current ? 'pane:commit' : 'pane:mount_commit';
    const durationMs = perf.now() - renderStartedAt;
    if (!hasCommittedRef.current || durationMs >= PANE_PERF_SLOW_COMMIT_MS) {
      const stats = messageRenderStats(n);
      perf.measure(phase, renderStartedAt, {
        nodeId,
        kind: n?.kind,
        status: n?.status,
        messages: stats.messages,
        chars: stats.chars,
        codeFences: stats.codeFences,
      });
    }
    hasCommittedRef.current = true;
  });
  const draft = useMemo<ComposerDraftState>(
    () => n?.composerDraft
      ? { value: n.composerDraft.value, mentions: n.composerDraft.mentions as MentionRecord[] }
      : EMPTY_COMPOSER_DRAFT,
    [n?.composerDraft],
  );
  const quotedText = n?.composerDraft?.quotedText ?? null;
  // Store writes are RAF-coalesced, so the render snapshot can trail the
  // TipTap transaction that immediately precedes Enter / a toolbar click.
  // Keep a synchronous source of truth for submit and quote composition.
  const latestDraftRef = useRef<ComposerDraftState>(draft);
  const latestQuotedTextRef = useRef<string | null>(quotedText);
  // The full draft stays RAF-coalesced, but the primary action must flip
  // immediately between disabled / Send / Send next / Stop. Updating this
  // boolean only on empty↔non-empty transitions avoids per-keystroke renders.
  const [draftHasText, setDraftHasText] = useState(() => draft.value.trim().length > 0);
  useLayoutEffect(() => {
    // Sync only when the committed store draft changes. An unrelated render
    // can happen before the RAF-coalesced draft commit; copying render-time
    // props on every render would roll the synchronous editor value back.
    latestDraftRef.current = draft;
    latestQuotedTextRef.current = quotedText;
    setDraftHasText(draft.value.trim().length > 0);
  }, [draft, quotedText]);
  const persistComposerDraft = useCallback(
    (nextDraft: ComposerDraftState, nextQuotedText: string | null) => {
      latestDraftRef.current = nextDraft;
      latestQuotedTextRef.current = nextQuotedText;
      setDraftHasText(nextDraft.value.trim().length > 0);
      setComposerDraft(nodeId, {
        value: nextDraft.value,
        mentions: nextDraft.mentions,
        quotedText: nextQuotedText ?? undefined,
      });
    },
    [nodeId, setComposerDraft],
  );
  const setDraft = useCallback(
    (nextOrUpdater: ComposerDraftState | ((prev: ComposerDraftState) => ComposerDraftState)) => {
      const next = typeof nextOrUpdater === 'function'
        ? nextOrUpdater(latestDraftRef.current)
        : nextOrUpdater;
      persistComposerDraft(next, latestQuotedTextRef.current);
    },
    [persistComposerDraft],
  );
  const setQuotedText = useCallback(
    (next: string | null) => persistComposerDraft(latestDraftRef.current, next),
    [persistComposerDraft],
  );
  const clearComposerDraft = useCallback(() => {
    latestDraftRef.current = EMPTY_COMPOSER_DRAFT;
    latestQuotedTextRef.current = null;
    setDraftHasText(false);
    setComposerDraft(nodeId, null);
  }, [nodeId, setComposerDraft]);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; anchorBottom?: number } | null>(null);
  const [modelMenu, setModelMenu] = useState<{ x: number; y: number; anchorBottom?: number } | null>(null);
  // Load only while the menu is open; the shared hook retries transient catalog failures.
  const shouldLoadModels = !!modelMenu && !!(
    agentStatus?.capabilities.providerModels || agentStatus?.capabilities.models === true
  );
  const {
    models: providerModels,
    loading: modelsLoading,
    error: modelsError,
    retry: retryModels,
  } = useAgentModelCatalog({
    enabled: shouldLoadModels,
    runtime: agentStatus?.runtime,
    provider: agentStatus?.provider,
  });
  // NB: do NOT call this `pending` — `onSubmit` already has a local
  // `const pending = n.pendingComments ?? []`.
  const [pendingAttachments, setPendingAttachments] = useState<PanePendingAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressViewState | null>(null);
  const [dragHover, setDragHover] = useState(false);

  const dragDepthRef = useRef(0);
  const [dropzoneVisible, setDropzoneVisible] = useState(false);
  const [droppedFileCount, setDroppedFileCount] = useState(0);

  // inputRef is hoisted here so insertContextMention (used by handleDrop) can
  // close over it — both are declared before handleDrop to avoid TDZ.
  const inputRef = useRef<MentionEditorHandle>(null);

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const insertContextMention = useCallback((label: string) => {
    // Insert an atomic context-mention chip at the editor caret (drop handler).
    inputRef.current?.editor
      ?.chain()
      .focus()
      .insertContent([
        { type: 'mention', attrs: { refId: label, label, kind: 'context' } },
        { type: 'text', text: ' ' },
      ])
      .run();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) {
      setDropzoneVisible(true);
      setDroppedFileCount(e.dataTransfer.items.length);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropzoneVisible(false);
  }, []);

  const addPendingPaths = useCallback((items: ReadonlyArray<string | { abs: string; displayName?: string }>) => {
    if (items.length === 0) return;
    setPendingAttachments(prev => {
      const have = new Set(prev.map(p => p.absPath));
      const next = [...prev];
      for (const item of items) {
        const abs = typeof item === 'string' ? item : item.abs;
        const override = typeof item === 'string' ? undefined : item.displayName;
        if (have.has(abs)) continue;
        const name = override || abs.split('/').pop() || abs;
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          absPath: abs,
        });
        have.add(abs);
      }
      return next;
    });
  }, []);

  // Resolve the cwd to import attachments into. Electron projects with a
  // user-picked folder use that. Web mode (no electron, or workspace
  // without a cwd) falls back to a backend-allocated upload directory
  // under /shared/michi/files/<workspaceId> (or os.tmpdir() when /shared
  // is absent). Returns null if no workspace is active.
  const resolveAttachCwd = useCallback(async (): Promise<string | null> => {
    if (activeProject?.cwd) return activeProject.cwd;
    if (!activeProject?.id) return null;
    return getWebUploadCwd(activeProject.id);
  }, [activeProject?.cwd, activeProject?.id]);

  const progressForFile = useCallback(
    (fileName: string, fileIndex: number, fileCount: number) =>
      (progress: UploadProgress) => {
        setUploadProgress({
          fileName,
          fileIndex,
          fileCount,
          phase: progress.phase,
          percent: progress.percent,
        });
      },
    [],
  );

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDropzoneVisible(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    focusPane(nodeId);

    const electron = getElectron();
    const items: Array<string | { abs: string; displayName: string }> = [];
    const errors: string[] = [];

    for (const [fileIndex, file] of files.entries()) {
      const path = electron?.getPathForFile?.(file) ?? null;
      try {
        if (path) {
          items.push(path);
          continue;
        }
        const cwd = await resolveAttachCwd();
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
        items.push({ abs, displayName: result.displayName || file.name });
      } catch (err) {
        errors.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setUploadProgress(null);

    if (items.length > 0) addPendingPaths(items);

    if (errors.length > 0) {
      toast.error(
        `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
        { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
      );
    }
  }, [activeProject, addPendingPaths, focusPane, nodeId, progressForFile, resolveAttachCwd]);

  // Paste-to-attach: scan clipboardData for file items (typically images
  // copied from screenshots / browsers) and pipe them through the same
  const PASTE_AS_FILE_THRESHOLD = 10_000;

  // import path as drag-and-drop. Text pastes fall through to the textarea.
  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;

    // Long text paste → save as .txt file attachment instead of inline.
    const plainText = dt.getData('text/plain');
    if (plainText && plainText.length >= PASTE_AS_FILE_THRESHOLD) {
      const hasFiles = Array.from(dt.items).some(i => i.kind === 'file');
      if (!hasFiles) {
        e.preventDefault();
        try {
          const cwd = await resolveAttachCwd();
          if (!cwd || !activeProject?.id) {
            toast.error('No workspace folder for text attachment');
            return;
          }
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fileName = `pasted-text-${ts}.txt`;
          const result = await importWorkspaceFile(activeProject.id, cwd, fileName, plainText, {
            subdir: '.attachments',
          });
          const abs = result.filePath.startsWith('/')
            ? result.filePath
            : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
          addPendingPaths([{ abs, displayName: fileName }]);
        } catch (err) {
          toast.error('Failed to save pasted text as file', {
            description: (err as Error).message,
          });
        }
        return;
      }
    }

    const items: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) items.push(f);
    }
    if (items.length === 0) return;
    e.preventDefault();

    const electron = getElectron();
    const pendingItems: Array<string | { abs: string; displayName: string }> = [];
    const errors: string[] = [];

    for (const [fileIndex, file] of items.entries()) {
      const path = electron?.getPathForFile?.(file) ?? null;
      try {
        if (path) {
          pendingItems.push(path);
          continue;
        }
        const cwd = await resolveAttachCwd();
        if (!cwd || !activeProject?.id) {
          errors.push(`${file.name || 'pasted file'}: no workspace folder`);
          continue;
        }
        // Pasted images often arrive with a generic name like "image.png"
        // or no extension — derive an extension from the MIME type and a
        // unique stem so multiple pastes don't collide.
        const nameExtMatch = file.name && file.name.match(/\.[a-zA-Z0-9]{1,8}$/);
        const ext = nameExtMatch
          ? nameExtMatch[0]
          : (file.type && file.type.startsWith('image/')
              ? `.${file.type.slice('image/'.length).split(';')[0] || 'png'}`
              : '');
        const stem = (file.name && file.name.replace(/\.[a-zA-Z0-9]{1,8}$/, '')) || 'pasted';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `${stem}-${ts}${ext}`;
        const result = await importWorkspaceFileUpload(activeProject.id, cwd, file, {
          originalName: fileName,
          onProgress: progressForFile(fileName, fileIndex, items.length),
          subdir: '.attachments',
        });
        const abs = result.filePath.startsWith('/')
          ? result.filePath
          : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
        pendingItems.push({ abs, displayName: result.displayName || fileName });
      } catch (err) {
        errors.push(`${file.name || 'pasted file'}: ${(err as Error).message}`);
      }
    }
    setUploadProgress(null);

    if (pendingItems.length > 0) addPendingPaths(pendingItems);
    if (errors.length > 0) {
      toast.error(
        `${errors.length} paste${errors.length === 1 ? '' : 's'} failed`,
        { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
      );
    }
  }, [activeProject, addPendingPaths, progressForFile, resolveAttachCwd]);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => prev.filter(x => x.id !== id));
  }, []);

  const webFileInputRef = useRef<HTMLInputElement | null>(null);

  const onPickFile = useCallback(async () => {
    const electron = getElectron();
    if (electron?.chooseFiles) {
      const res = await electron.chooseFiles();
      if (res.canceled || !res.paths) return;
      addPendingPaths(res.paths);
      return;
    }
    // Web: open a hidden <input type="file"> picker. Files are imported
    // through the same /workspaces/import-file pipeline as drag-and-drop.
    if (!webFileInputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length === 0) return;
        const items: Array<{ abs: string; displayName: string }> = [];
        const errors: string[] = [];
        for (const [fileIndex, file] of files.entries()) {
          try {
            const cwd = await resolveAttachCwd();
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
            items.push({ abs, displayName: result.displayName || file.name });
          } catch (err) {
            errors.push(`${file.name}: ${(err as Error).message}`);
          }
        }
        setUploadProgress(null);
        if (items.length > 0) addPendingPaths(items);
        if (errors.length > 0) {
          toast.error(
            `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
            { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
          );
        }
      });
      document.body.appendChild(input);
      webFileInputRef.current = input;
    }
    webFileInputRef.current.click();
  }, [activeProject?.id, addPendingPaths, progressForFile, resolveAttachCwd]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // "Follow mode": while true and the agent is streaming, new content
  // pins the viewport to the bottom. Toggles on/off based on the user's
  // scroll direction (see onScroll handler below). Initial value is true
  // so a freshly-opened pane tails the conversation by default.
  const followRef = useRef<boolean>(true);
  // Previous scrollTop sample — used by onScroll to detect direction.
  const prevScrollTopRef = useRef<number>(0);
  // ID of the last user message we've already auto-scrolled for. Used to
  // detect a *new* user send (vs. a re-render of the same message) so we
  // only fire the "scroll user message to top 30%" animation once per send.
  // Initialise to the current latest user message so a freshly-mounted
  // (reopened) pane doesn't mistake existing history for a new send.
  const prevSentMsgIdRef = useRef<string | null>((() => {
    const msgs = n?.messages;
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return msgs[i].id;
    }
    return null;
  })());
  // performance.now() timestamp until which follow-mode auto-pinning is
  // suppressed. Set when a user message lands so the smooth-scroll-to-30%
  // animation can complete before the assistant's first streamed token
  // would otherwise yank the viewport back to the bottom.
  const userMsgPinUntilRef = useRef<number>(0);
  // Programmatic smooth-scroll emits ordinary scroll events. Without this
  // guard, the first in-between frame can look like an upward user scroll and
  // incorrectly disable follow mode for the rest of the streaming turn.
  const programmaticScrollUntilRef = useRef<number>(0);
  // Layout reflow during a long stream can move scrollTop upward by itself
  // (markdown blocks forming, spacer removal, browser scroll anchoring). Only
  // leave follow mode when that upward scroll is tied to recent user input.
  const userScrollIntentUntilRef = useRef<number>(0);
  // Latest pin function — set inside the streaming-follow effect so the
  // ResizeObserver/animation-end pin can run the same anchor-vs-tail
  // logic without recapturing message state in its `[]` deps closure.
  const pinFnRef = useRef<(() => void) | null>(null);

  // ── Scroll persistence ─────────────────────────────────────────────────
  // True while the mount-time restore below is still positioning the
  // viewport. Saves are suppressed during that window: a save would capture
  // the half-restored position AND advance the lastSeen horizon — under
  // StrictMode's dev double-mount the first cleanup fires exactly then, and
  // without the guard it poisons the entry the second mount restores from
  // (read chats snapped to the bottom, unread chats lost their horizon).
  const restoreInFlightRef = useRef(false);
  // Capture where the user is in this pane as a message anchor plus the
  // newest message timestamp (see PaneScrollEntry). Runs on unmount,
  // debounced while scrolling, and on beforeunload so a refresh keeps it
  // fresh too.
  const savePaneScroll = useCallback(() => {
    if (restoreInFlightRef.current) return;
    const el = scrollRef.current;
    const node = nLatestRef.current;
    if (!el || !node || node.messages.length === 0) return;
    const lastSeen = node.messages.reduce((mx, m) => Math.max(mx, m.createdAt ?? 0), 0);
    // Mid-stream the tail keeps growing after the pane closes, so "at the
    // bottom now" is not "at the bottom on reopen" — save the anchor instead
    // and the user resumes at the point they stopped watching.
    const atBottom =
      node.status !== 'streaming' &&
      el.scrollTop >= el.scrollHeight - el.clientHeight - 24;
    let anchorId: string | null = null;
    let offset = 0;
    if (!atBottom) {
      const viewTop = el.getBoundingClientRect().top;
      for (const f of Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
        const r = f.getBoundingClientRect();
        if (r.bottom > viewTop + 1) { // topmost message still (partly) visible
          anchorId = f.getAttribute('data-msg-id');
          offset = r.top - viewTop;
          break;
        }
      }
    }
    paneScrollCache.set(nodeId, { anchorId, offset, atBottom, lastSeen });
  }, [nodeId]);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePaneScrollSave = useCallback(() => {
    if (scrollSaveTimerRef.current != null) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      scrollSaveTimerRef.current = null;
      savePaneScroll();
    }, 250);
  }, [savePaneScroll]);

  // Position the viewport on mount. Streaming panes are handled by follow
  // mode; idle panes land on the target picked by resolvePaneRestore()
  // (unseen message → saved anchor → bottom).
  // A single scrollTop assignment cannot work here: message frames use
  // content-visibility:auto, so heights inflate from 72px estimates to real
  // values progressively after mount — and each write moves the viewport,
  // which makes the browser render more frames near it, which shifts the
  // anchor again. With overflow-anchor:none on the container, nothing
  // compensates for that drift, so the restore keeps re-deriving the target
  // from the anchor's live rect (ResizeObserver on the content) until the
  // layout goes quiet, the hard cap elapses, or the user scrolls. The first
  // pass runs synchronously inside the layout effect so the pre-paint frame
  // is already positioned.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let finishRestore: (() => void) | null = null;
    let liveTrustRaf: number | null = null;
    const live = n?.status === 'streaming' || !!n?.followUpsGenerating;
    const restore = live
      ? null
      : resolvePaneRestore(paneScrollCache.get(nodeId), n?.messages ?? []);
    if (restore) {
      // Follow mode stays on only when we land at the bottom — otherwise the
      // streaming-follow / resize pins would yank the restored position back
      // down (this is what previously sent every followUps-bearing pane to
      // the bottom on open). The bottom case keeps follow ON, so the
      // existing follow pins take over once this restore finishes.
      followRef.current = restore.kind === 'bottom';
      const targetFor = (): number => {
        if (restore.kind !== 'bottom' && restore.anchorId) {
          const msgEl = el.querySelector<HTMLElement>(`[data-msg-id="${restore.anchorId}"]`);
          if (msgEl) {
            const wanted = restore.kind === 'unseen'
              ? el.clientHeight * UNSEEN_TOP_FRACTION
              : restore.offset;
            const delta = msgEl.getBoundingClientRect().top - el.getBoundingClientRect().top;
            return Math.max(0, el.scrollTop + delta - wanted);
          }
          // Anchor message gone (deleted/trimmed) — fall through to bottom.
        }
        return el.scrollHeight - el.clientHeight;
      };
      let done = false;
      let ro: ResizeObserver | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let capTimer: ReturnType<typeof setTimeout> | null = null;
      restoreInFlightRef.current = true;
      const finish = () => {
        if (done) return;
        done = true;
        restoreInFlightRef.current = false;
        ro?.disconnect();
        if (quietTimer != null) clearTimeout(quietTimer);
        if (capTimer != null) clearTimeout(capTimer);
        el.removeEventListener('wheel', finish);
        el.removeEventListener('touchstart', finish);
        el.removeEventListener('pointerdown', finish);
      };
      finishRestore = finish;
      const armQuiet = () => {
        if (quietTimer != null) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, RESTORE_QUIET_MS);
      };
      const apply = () => {
        if (done) return;
        const target = targetFor();
        if (Math.abs(el.scrollTop - target) > 1) {
          // Our own writes emit scroll events; keep the follow-mode
          // direction detector from reading them as user intent.
          programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
          el.scrollTop = target;
          prevScrollTopRef.current = el.scrollTop;
          armQuiet();
        }
      };
      apply();
      armQuiet();
      capTimer = setTimeout(finish, RESTORE_MAX_MS);
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => apply());
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
      }
      el.addEventListener('wheel', finish, { passive: true });
      el.addEventListener('touchstart', finish, { passive: true });
      el.addEventListener('pointerdown', finish);
    } else {
      // Live pane (streaming / follow-ups generating) or no messages yet:
      // there is no restore pass, but StrictMode's dev double-mount still
      // fires this effect's cleanup synchronously, before any frame — where
      // the layout is the unsettled content-visibility estimate. Guard that
      // window too so the cleanup save can't poison the entry; the flag
      // clears one frame after mount, once geometry is real.
      restoreInFlightRef.current = true;
      liveTrustRaf = requestAnimationFrame(() => {
        liveTrustRaf = null;
        restoreInFlightRef.current = false;
      });
    }
    window.addEventListener('beforeunload', savePaneScroll);
    return () => {
      // Unmounting mid-restore (StrictMode's dev double-mount, or an
      // open-and-close within RESTORE_QUIET_MS) skips the save: the
      // half-restored position would overwrite the entry this restore was
      // reading, and the stale entry is strictly better data.
      const restoreWasActive = restoreInFlightRef.current;
      finishRestore?.();
      if (liveTrustRaf != null) {
        cancelAnimationFrame(liveTrustRaf);
        restoreInFlightRef.current = false;
      }
      window.removeEventListener('beforeunload', savePaneScroll);
      if (scrollSaveTimerRef.current != null) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      if (!restoreWasActive) savePaneScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const composerHandle = useRef<ComposerShellHandle>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const composerToolbarRef = useRef<HTMLDivElement>(null);
  // Measured height of the floating composer card. Drives the scroll area's
  // bottom padding so the last message can scroll above the card instead of
  // being trapped behind it.
  const [composerHeight, setComposerHeight] = useState(96);
  // Measured clientHeight of the scroll viewport. Drives the tail spacer
  // size so the freshly-sent user message can sit at ~30% from the top
  // even on short replies. Falls back to 600 before first measurement so
  // we don't render a 0-height spacer on the very first paint.
  const [viewportH, setViewportH] = useState(600);
  // Width-driven compaction tier for the toolbar:
  // 0 = full labels, 1 = drop agent/model labels (keep glyph),
  // 2 = also hide agent + model chips entirely.
  const [toolbarTier, setToolbarTier] = useState<0 | 1 | 2>(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const isFocused = focusedPane === nodeId;
  // When another pane is being dragged over us, show a drop indicator on the
  // appropriate side. `null` means no pane drag is currently hovering.
  const [paneDropSide, setPaneDropSide] = useState<'left' | 'right' | null>(null);
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = performance.now() + USER_SCROLL_INTENT_WINDOW_MS;
  }, []);
  const markUserScrollIntentFromKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key === 'ArrowUp' ||
      e.key === 'PageUp' ||
      e.key === 'Home' ||
      (e.key === ' ' && e.shiftKey)
    ) {
      markUserScrollIntent();
    }
  }, [markUserScrollIntent]);

  // Listen for the global ⌘F dispatch — only act when the event targets this pane.
  // Each press: open if closed, and bump the focus nonce so PaneFind refocuses
  // its input even when already open.
  useEffect(() => {
    const onOpenFind = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId?: string };
      if (detail?.nodeId !== nodeId) return;
      setFindOpen(true);
      setFindFocusNonce((n) => n + 1);
    };
    window.addEventListener('michi:open-pane-find', onOpenFind as EventListener);
    return () => window.removeEventListener('michi:open-pane-find', onOpenFind as EventListener);
  }, [nodeId]);

  // Auto-close find when this pane loses focus (user switched panes / pages).
  useEffect(() => {
    if (!isFocused && findOpen) setFindOpen(false);
  }, [isFocused, findOpen]);

  // Forward dashboard drop events to this pane's composer when focused.
  useEffect(() => {
    if (focusedPane !== nodeId) return;
    const onAttach = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paths?: string[] };
      if (!detail?.paths || detail.paths.length === 0) return;
      addPendingPaths(detail.paths);
    };
    window.addEventListener('michi:attach-paths', onAttach as EventListener);
    return () => window.removeEventListener('michi:attach-paths', onAttach as EventListener);
  }, [focusedPane, nodeId, addPendingPaths]);

  // Scroll a specific message into view + brief flash, dispatched by GlobalSearch
  // and PaneFind navigation.
  useEffect(() => {
    let cancelFlash: (() => void) | null = null;
    let retryRaf = 0;
    const onScroll = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        nodeId?: string;
        messageId?: string;
        flash?: boolean;
        query?: string;
        occurrence?: number;
      };
      if (detail?.nodeId !== nodeId) return;
      if (!detail.messageId) return;
      const messageId = detail.messageId;
      const el = document.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
      // Opening a search result can target a tree whose message bodies are
      // still lazy-loading, so the message DOM may not exist yet. Retry across
      // a few frames (~1s), re-dispatching the same handler once it renders.
      if (!el) {
        let tries = 0;
        const retry = () => {
          if (document.querySelector(`[data-msg-id="${messageId}"]`)) { onScroll(e); return; }
          if (++tries < 60) retryRaf = window.requestAnimationFrame(retry);
        };
        retryRaf = window.requestAnimationFrame(retry);
        return;
      }

      // In-pane find (flash: false): scroll to the specific match within this
      // message and flash ONLY that match's text — not the whole message. We
      // locate the match by re-searching this message's DOM for the query and
      // picking the Nth occurrence (occurrence index supplied by PaneFind).
      const q = (detail.query ?? '').trim().toLowerCase();
      if (detail.flash === false && q && typeof detail.occurrence === 'number') {
        const ranges = rangesInElement(el, q);
        const range = ranges[detail.occurrence] ?? ranges[ranges.length - 1];
        if (range) {
          const anchor = range.startContainer.parentElement ?? el;
          anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
          cancelFlash?.();
          cancelFlash = flashMatchOverlay(range);
          return;
        }
        // No DOM match found (rare): fall through to a plain scroll, no flash.
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }

      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // Whole-message flash only for cross-context jumps (global search).
      if (detail.flash !== false) {
        el.classList.add('t-msg-flash');
        setTimeout(() => el.classList.remove('t-msg-flash'), 600);
      }
    };
    window.addEventListener('michi:scroll-to-message', onScroll as EventListener);
    return () => {
      window.removeEventListener('michi:scroll-to-message', onScroll as EventListener);
      cancelFlash?.();
      if (retryRaf) window.cancelAnimationFrame(retryRaf);
    };
  }, [nodeId]);

  // PaneFind highlights: walk DOM text nodes inside this pane's messages,
  // build Ranges for every occurrence, and apply via CSS Custom Highlight API.
  // Decouples highlighting from React render so streaming and markdown don't fight.
  // Single shared 'pane-find' highlight name — if two panes simultaneously have
  // find open, the most recent update wins. Acceptable since users rarely run
  // two finds at once.
  useEffect(() => {
    const HIGHLIGHT_NAME = 'pane-find';
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId?: string; query?: string };
      if (detail?.nodeId !== nodeId) return;
      const q = (detail.query ?? '').trim().toLowerCase();
      const css = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
      if (!css || typeof Highlight === 'undefined') return;
      if (!q) {
        css.delete(HIGHLIGHT_NAME);
        return;
      }
      const paneEl = document.querySelector(`[data-node-id="${nodeId}"]`);
      if (!paneEl) {
        css.delete(HIGHLIGHT_NAME);
        return;
      }
      const ranges = collectFindRanges(paneEl, q);
      if (ranges.length === 0) {
        css.delete(HIGHLIGHT_NAME);
      } else {
        css.set(HIGHLIGHT_NAME, new Highlight(...ranges));
      }
    };
    window.addEventListener('michi:pane-find-update', onUpdate as EventListener);
    return () => {
      window.removeEventListener('michi:pane-find-update', onUpdate as EventListener);
      const css = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
      css?.delete(HIGHLIGHT_NAME);
    };
  }, [nodeId]);

  // Auto-grow now lives inside MentionEditor (its contenteditable owns the
  // min/max-height sizing).

  // Track the floating composer's actual rendered height so the scroll area can
  // reserve matching bottom clearance. Without this, multi-line input + a quote
  // bar push the card taller than any fixed padding can cover.
  useEffect(() => {
    const el = composerHandle.current?.el;
    composerRef.current = el ?? null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setComposerHeight(Math.ceil(el.offsetHeight));
    const ro = new ResizeObserver((entries) => {
      if (sidebarAnimatingRef.current) return;
      const h = entries[0]?.contentRect.height ?? el.offsetHeight;
      setComposerHeight(Math.ceil(h));
    });
    ro.observe(el);
    animationEndCallbacks.add(measure);
    return () => {
      ro.disconnect();
      animationEndCallbacks.delete(measure);
    };
  }, [n?.pendingPermission]);

  // Width-driven compaction for the composer toolbar. Below ~360px the
  // agent / model chips drop their text labels (glyph-only); below ~260px
  // they are hidden entirely. The action buttons on the right never shrink,
  // and individual chip labels also clip with an ellipsis on the way down,
  // so the transition between tiers stays smooth.
  useEffect(() => {
    const el = composerToolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const tierFor = (w: number): 0 | 1 | 2 => (w < 260 ? 2 : w < 360 ? 1 : 0);
    const measure = () => {
      const next = tierFor(el.offsetWidth);
      setToolbarTier((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver((entries) => {
      if (sidebarAnimatingRef.current) return;
      const w = entries[0]?.contentRect.width ?? el.offsetWidth;
      const next = tierFor(w);
      setToolbarTier((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    animationEndCallbacks.add(measure);
    return () => {
      ro.disconnect();
      animationEndCallbacks.delete(measure);
    };
  }, [n?.pendingPermission]);

  const activeProjectEdges = activeProject?.edges ?? EMPTY_EDGES;
  const mentionContexts = activeProject?.contexts ?? EMPTY_CONTEXTS;

  const contextNamesSet = useMemo(() => {
    if (mentionContexts.length === 0) return EMPTY_CONTEXT_NAMES;
    return new Set(mentionContexts.map(c => c.name.toLowerCase()));
  }, [mentionContexts]);

  const parentTitle = useStructuralSelector(
    useCallback((nodesMap) => {
      const parentId = nodesMap[nodeId]?.parentNodeId;
      return parentId ? nodesMap[parentId]?.title : undefined;
    }, [nodeId]),
  );

  // Compute same-tree nodes for @mention popup at structural cadence. Streaming
  // chunks do not change titles, deletion, kind, tree placement, or message
  // count, so every open pane can skip this selector while another pane is
  // receiving tokens.
  const sameTreeNodes = useStructuralSelector(useCallback((nodesMap) => {
    if (!activeProject) return EMPTY_SAME_TREE_NODES;
    const treeId = findTreeIdForNode(nodeId, activeProject);
    if (!treeId) return EMPTY_SAME_TREE_NODES;
    const out: ChatNodeState[] = [];
    for (const nid of activeProject.chatIds) {
      const nd = nodesMap[nid];
      if (!nd || nd.deletedAt || nd.kind !== 'chat') continue;
      if (findTreeIdForNode(nid, activeProject) !== treeId) continue;
      out.push(nd);
    }
    return out.length > 0 ? out : EMPTY_SAME_TREE_NODES;
  }, [activeProject, nodeId]), shallowArrayEqual);

  const mergeSourceLabels = useStructuralSelector(useCallback((nodesMap) => {
    const node = nodesMap[nodeId];
    if (!node || (node.mergeSources?.length ?? 0) === 0) return EMPTY_MERGE_SOURCE_LABELS;
    const sourceIds = [
      ...(node.parentNodeId ? [node.parentNodeId] : []),
      ...(node.mergeSources ?? []),
    ];
    return sourceIds.map((sid) => {
      const src = nodesMap[sid];
      return src?.title || chatLabel(src) || sid;
    });
  }, [nodeId]), shallowArrayEqual);

  // Compute which child branches are anchored to which assistant message in
  // this pane. Passed to PaneMessageList so it can render BranchAnchorRow
  // turn markers after each anchored message.
  //
  // The anchor row only needs structural fields (title/status/message count
  // and anchored message ids). Keeping it on the structural channel prevents
  // a streaming child from waking every parent pane on each token.
  const anchorsByMessage = useStructuralSelector(
    useCallback(
      (nodesMap) => buildAnchorMap(nodeId, activeProjectEdges, nodesMap),
      [nodeId, activeProjectEdges],
    ),
    anchorMapEqual,
  );

  const lastMsg = n?.messages[n ? n.messages.length - 1 : 0];
  // Tool calls and thinking streams grow without touching `text`, so include
  // them in the deps — otherwise the viewport stays put while a tool chip or
  // reasoning chunk pushes content below the fold.
  const lastToolSig = lastMsg?.toolCalls
    .map((t) => `${t.id}:${t.status}:${t.title.length}:${t.kind?.length ?? 0}:${t.detail?.length ?? 0}`)
    .join('|');
  const lastPlanSig = lastMsg?.plan
    ?.map((p) => `${p.status}:${p.priority}:${p.content.length}`)
    .join('|');
  const subagentSig = n?.subagents
    ?.map((s) => `${s.sessionId}:${s.status}:${s.currentTool?.length ?? 0}:${s.statusMessage?.length ?? 0}`)
    .join('|');
  // Streaming assistant content lands in `blocks` (via appendAnswerBlockText
  // / appendThinkingBlockText), NOT in `m.text`. So the effect below has to
  // depend on a block-derived signature, not just text length, otherwise it
  // never re-runs while the agent is streaming.
  const lastBlockSig = lastMsg?.blocks
    ?.map((b) =>
      b.kind === 'tool'
        ? `t:${b.toolCallId}`
        : b.kind === 'image'
          ? `i:${b.path}`
          : b.kind === 'user-input'
            ? `u:${b.requestId}`
            : `${b.kind[0]}:${b.rawText.length}`,
    )
    .join('|');
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Two distinct behaviours:
    //   1. Just-sent user message → smooth-scroll so the bubble sits ~30%
    //      from the top of the viewport, leaving ~70% for the agent reply
    //      to grow into. Re-engages follow mode so streaming output that
    //      arrives next will keep tailing the bottom.
    //   2. Streaming assistant content → if follow mode is on, schedule a
    //      pinFollow via rAF. The ResizeObserver below handles keeping
    //      scroll pinned as content height grows (line breaks).
    // Find the most-recent user message — the reducer pairs every user
    // send with an empty assistant placeholder on the same tick, so
    // `lastMsg.role` is usually 'assistant' even right after a send.
    // Backward scan (no array copy): this effect re-runs on nearly every
    // stream chunk, so a full [...messages].reverse() per chunk is wasteful.
    let latestUser: NonNullable<typeof n>['messages'][number] | undefined;
    if (n?.messages) {
      for (let i = n.messages.length - 1; i >= 0; i--) {
        if (n.messages[i].role === 'user') { latestUser = n.messages[i]; break; }
      }
    }
    if (latestUser && latestUser.id !== prevSentMsgIdRef.current) {
      prevSentMsgIdRef.current = latestUser.id;
      followRef.current = true;
      userMsgPinUntilRef.current = performance.now() + 700;
      programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
      // Defer to next frame so the tail spacer (rendered while the agent
      // hasn't produced content yet) has a chance to land in the DOM and
      // bump scrollHeight — otherwise scrollTop is clamped to
      // (scrollHeight - clientHeight) and the message lands lower than 30%.
      requestAnimationFrame(() => {
        const msgEl = el.querySelector(`[data-msg-id="${latestUser.id}"]`) as HTMLElement | null;
        const targetTop = msgEl
          ? Math.max(0, msgEl.offsetTop - el.clientHeight * 0.30)
          : el.scrollHeight;
        programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
        el.scrollTo({ top: targetTop, behavior: 'smooth' });
      });
      return;
    }
    // Two-stage follow:
    //   stage A (early reply) — keep the latest user message at the
    //     30%-from-top anchor.
    //   stage B (long reply) — track the reply's tail so its bottom
    //     edge sits just above the floating composer card.
    // Math.max picks whichever stage is "later" in scroll terms, so
    // the transition is automatic: the moment the reply gets long
    // enough that tracking its tail would scroll past the user
    // anchor, tail-tracking takes over.
    const pinFollow = () => {
      if (!followRef.current) return;
      if (performance.now() < userMsgPinUntilRef.current) return;
      const lu = latestUser
        ? (el.querySelector(`[data-msg-id="${latestUser.id}"]`) as HTMLElement | null)
        : null;
      // Tail anchor uses the bottom of the *last visible content child*
      // — not just the last assistant message — so newly-rendered
      // siblings (follow-ups placeholder, mcp errors, subagent banner)
      // get tracked too. Skip the spacer (aria-hidden) so its height
      // doesn't push the tail past the real content.
      const inner = el.firstElementChild;
      let contentBottom = 0;
      if (inner) {
        for (const c of Array.from(inner.children) as HTMLElement[]) {
          if (c.getAttribute('aria-hidden') === 'true') continue;
          const b = c.offsetTop + c.offsetHeight;
          if (b > contentBottom) contentBottom = b;
        }
      }
      const composerClearance = composerHeight + 24;
      const tail = contentBottom > 0
        ? contentBottom - el.clientHeight + composerClearance
        : el.scrollHeight - el.clientHeight;
      const anchor = lu
        ? Math.max(0, lu.offsetTop - el.clientHeight * 0.30)
        : 0;
      const maxScroll = el.scrollHeight - el.clientHeight;
      // Streaming markdown can briefly shrink/reflow as blocks become lists,
      // code fences, or headings. While follow-mode is active, avoid chasing
      // those transient upward measurements; only advance toward the tail.
      const nextScrollTop = nextFollowScrollTop({
        currentScrollTop: el.scrollTop,
        maxScroll,
        anchor,
        tail,
      });
      if (nextScrollTop !== el.scrollTop) {
        el.scrollTop = nextScrollTop;
      }
      prevScrollTopRef.current = el.scrollTop;
    };
    // Keep tail-following active through the follow-up phase too. The
    // follow-up tool often lands after text streaming has already flipped
    // the node back to idle; if we stop pinning at that boundary, the final
    // question can render underneath the floating composer.
    const shouldPinTail =
      n?.status === 'streaming' ||
      !!n?.followUpsGenerating ||
      (n?.followUps.length ?? 0) > 0;
    pinFnRef.current = shouldPinTail ? pinFollow : null;
    if (followRef.current && lastMsg?.role === 'assistant' && shouldPinTail) {
      if (performance.now() < userMsgPinUntilRef.current) return;
      requestAnimationFrame(pinFollow);
    }
  }, [
    n?.messages.length,
    n?.status,
    n?.followUpsGenerating,
    n?.followUps.length,
    !!n?.mcpServerError,
    n?.subagents?.length,
    subagentSig,
    lastMsg?.id,
    lastMsg?.role,
    lastMsg?.toolCalls.length,
    lastToolSig,
    lastPlanSig,
    lastBlockSig,
    composerHeight,
  ]);

  // When the pane's width changes (e.g. opening a sibling shrinks the grid
  // column), or streamed markdown grows/reflows between network chunks, the
  // scroll position no longer reads as "at bottom" even though the user was.
  // Re-pin if follow-mode is still active.
  //
  // ResizeObserver fires BEFORE paint in modern browsers (after layout, before
  // the next composite/paint step). By calling pinFnRef.current() synchronously
  // here (no rAF wrapper), the scrollTop adjustment lands in the same frame as
  // the height change — eliminating the 1-frame flash where new content appears
  // below the viewport before scroll catches up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const pin = () => {
      // Synchronous pin — ResizeObserver already fires after layout/before paint,
      // so this scrollTop write takes effect within the same frame.
      pinFnRef.current?.();
    };
    // Fallback rAF pin for animation-end callbacks (non-critical path)
    const pinDeferred = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        pinFnRef.current?.();
      });
    };
    const ro = new ResizeObserver(() => {
      setViewportH(el.clientHeight);
      if (sidebarAnimatingRef.current) return;
      pin();
    });
    setViewportH(el.clientHeight);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    animationEndCallbacks.add(pinDeferred);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
      animationEndCallbacks.delete(pinDeferred);
    };
  }, []);

  // Auto-focus the composer textarea when the user's intent is clearly to
  // type into this pane: the pane just became the focused pane, the agent
  // just finished streaming on a focused pane, or a quote was just attached
  // to a focused pane. We skip the focus pull when the user is already
  // typing somewhere else (another input/textarea/contenteditable) so we
  // don't yank focus mid-keystroke.
  const streaming = n?.status === 'streaming';
  const observing = isObserver(nodeId);
  const prevFocusedRef = useRef(isFocused);
  const wasStreamingRef = useRef(streaming);
  const lastQuoteRef = useRef(quotedText);
  useEffect(() => {
    const becameFocused = !prevFocusedRef.current && isFocused;
    const justFinishedStreaming = wasStreamingRef.current && !streaming;
    const quoteJustAdded = !!quotedText && quotedText !== lastQuoteRef.current;
    prevFocusedRef.current = isFocused;
    wasStreamingRef.current = streaming;
    lastQuoteRef.current = quotedText;

    if (!isFocused) return;
    if (!becameFocused && !justFinishedStreaming && !quoteJustAdded) return;

    const active = document.activeElement as HTMLElement | null;
    if (active) {
      const tag = active.tagName;
      // Don't steal focus if the user is already in any editable (incl. our
      // contenteditable composer).
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isFocused, streaming, quotedText]);

  const insertMentionTrigger = useCallback(() => {
    // Type an `@` at the caret; MentionEditor's suggestion opens on it.
    inputRef.current?.editor?.chain().focus().insertContent('@').run();
  }, []);

  // "Cite" from the Artifacts drawer: append `@name ` as plain text at the
  // caret. resolveAtMentions parses the wire token on send, so no formal chip
  // node is required. Only the focused pane (event's target nodeId) reacts.
  useEffect(() => {
    const onCite = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId?: string; name?: string } | undefined;
      if (!detail || detail.nodeId !== nodeId || !detail.name) return;
      const ed = inputRef.current?.editor;
      if (!ed) return;
      // Insert a leading space when the composer isn't empty / doesn't already
      // end in whitespace, so the @token stays a standalone mention.
      const endsWithSpace = /\s$/.test(ed.getText());
      ed.chain().focus().insertContent(`${endsWithSpace ? '' : ' '}@${detail.name} `).run();
    };
    window.addEventListener('michi:cite-artifact', onCite);
    return () => window.removeEventListener('michi:cite-artifact', onCite);
  }, [nodeId]);

  const openModelMenu = useCallback((
    anchor: { x: number; y: number; anchorBottom: number },
    _shouldLoadModels: boolean,
  ) => {
    setModelMenu(anchor);
  }, []);

  const handleOpenBranch = useCallback((childNodeId: string) => {
    focusPane(childNodeId);
  }, [focusPane]);

  const handleRetryTurn = useCallback((userIdx: number) => {
    retryLastTurn(nodeId, userIdx);
  }, [nodeId, retryLastTurn]);

  const handleEditUserMessage = useCallback((text: string) => {
    // Past messages contain wire-format tokens; reset mentions metadata
    // since we can't reconstruct chip anchors from just the text.
    setDraft({ value: text, mentions: [] });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [setDraft]);

  const handleContinueFollowUp = useCallback((question: string) => {
    void sendMessage(nodeId, question);
  }, [nodeId, sendMessage]);

  const handleBranchFollowUp = useCallback((question: string) => {
    void createChildChat(nodeId, question, undefined, {
      anchorMessageId: n?.followUpsSourceMessageId,
    }).catch(() => {});
  }, [createChildChat, n?.followUpsSourceMessageId, nodeId]);

  const handleBranchFromMessage = useCallback((messageId: string) => {
    void createBlankChild(nodeId, { anchorMessageId: messageId }).catch(() => {});
  }, [createBlankChild, nodeId]);

  const innerWrap = useMemo<React.CSSProperties>(
    () => (
      contentMaxWidth != null
        ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto', width: '100%' }
        : { width: '100%' }
    ),
    [contentMaxWidth],
  );

  // Flash a toast in the header when the agent mode changes. We track the
  // previous currentModeId with a ref so the first render (initial mode) does
  // not flash.
  if (!n) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 11,
        }}
      >
        — empty pane —
      </div>
    );
  }

  // A node can become `deletedAt` while this pane is still open — e.g. it was
  // deleted in another tree/tab, or a backend sync flipped the flag. The tree
  // and sidebar already hide trashed nodes; render a placeholder instead of the
  // chat surface + composer so a lingering pane can't keep chatting with a
  // deleted node. The reactive pane prune (chatStore) closes the pane shortly
  // after; this is the render-time backstop.
  if (n.deletedAt) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--term-surface)',
          borderRight: '1px solid var(--term-line)',
          minWidth: 0,
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--term-muted)',
          fontSize: 11,
          gap: 4,
        }}
      >
        <div>— this conversation was deleted —</div>
      </div>
    );
  }

  const title = n.title || chatLabel(n) || 'thread';
  const currentMode = n.currentModeId
    ? availableModes.find((m) => m.id === n.currentModeId)
    : undefined;

  const onSubmit = async (forceBranch = false) => {
    if (observing) return;
    const submitDraft = latestDraftRef.current;
    const submitQuotedText = latestQuotedTextRef.current;
    // Expand mention chips back to wire-format tokens (`@node:<id>` for nodes,
    // `@<name>` for contexts) before any downstream parsing — fanout, branch
    // prefix stripping, etc. all see the wire string, not the chip-display.
    const raw = expandMentions(submitDraft.value, submitDraft.mentions).trim();
    const pending = n.pendingComments ?? [];
    // Comment-only sends are allowed: empty text is fine as long as there's
    // at least one pending comment to flush. Attachment-only sends are also
    // allowed.
    if (!raw && pending.length === 0 && pendingAttachments.length === 0) return;
    clearComposerDraft();
    const attachmentsForSend = pendingAttachments.map(p => ({ name: p.name, absPath: p.absPath }));
    // Attachments stay scoped to this turn — the agent reads them via the
    // [Attached files: …] sentinel appended below. We deliberately do NOT
    // promote them to workspace contexts: that registered every uploaded image
    // as a workspace-level context row, which the first-turn manifest then
    // advertised to *every other* conversation in the workspace, so sibling
    // threads kept reading unrelated screenshots.
    setPendingAttachments([]);

    // Fanout commands (`/fan topic1, topic2`) bypass the normal pipeline. The
    // parser requires text so it short-circuits on comment-only sends
    // automatically; we still guard explicitly so the intent is readable.
    if (raw) {
      const fanout = parseFanoutCommand(raw);
      if (fanout) {
        const lastAssistantId = [...(n.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.id;
        await fanoutBranches(nodeId, fanout.topics, { anchorMessageId: lastAssistantId });
        return;
      }
    }

    const { branched: slashBranched, text } = raw
      ? stripBranchPrefix(raw)
      : { branched: false, text: '' };

    // With comment-only enabled, `text` can legitimately be empty. Only bail
    // when there's nothing outgoing at all (no comments AND no text AND no
    // attachments).
    if (!text && pending.length === 0 && attachmentsForSend.length === 0) return;

    // Compute commentBlock BEFORE the queue branch so it can be folded into
    // the queue payload. quotedText is already captured in scope from the
    // pre-clear draft snapshot.
    const commentBlock = pending.length > 0 ? formatCommentsBlock(pending) : null;
    const queuedQuote = submitQuotedText;

    // Streaming + plain Enter (no force, no slash-branch) → queue path.
    // Branch button still bypasses (forceBranch=true) and calls
    // createChildChat as before. Pending-comment-only sends also queue
    // during streaming (text empty, but comments exist) — otherwise they
    // would fall through to sendMessage on a streaming node and the
    // chatStore guard would no-op them with a console warning.
    if (
      streaming &&
      !forceBranch &&
      !slashBranched &&
      (text || attachmentsForSend.length > 0 || pending.length > 0)
    ) {
      queueMessage(nodeId, {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        value: submitDraft.value,           // literal text (chip labels intact)
        mentions: [...submitDraft.mentions],
        attachments: attachmentsForSend.map(a => ({ ...a })),
        quotedText: queuedQuote ?? undefined,
        commentBlock: commentBlock ?? undefined,
        queuedAt: Date.now(),
      });
      // Comments were folded into the queue entry — clear them off the node
      // so they don't double-fire when the next idle send runs.
      if (pending.length > 0) clearPendingComments(nodeId);
      return;
    }

    const baseFinal = joinMessageParts(commentBlock, submitQuotedText, text);
    const finalText = appendAttachmentsSentinel(baseFinal, attachmentsForSend);
    if (pending.length > 0) clearPendingComments(nodeId);

    // The wire payload (`finalText`) carries the flattened quote + sentinel.
    // The optimistic user message renders only the bare prose plus structured
    // quotedText / attachments / comments, so the bubble can show them as modules.
    const meta = {
      quotedText: submitQuotedText ?? undefined,
      attachments: attachmentsForSend.length > 0 ? attachmentsForSend.map(a => ({ ...a })) : undefined,
      comments: pending.length > 0 ? pending.map(c => ({ ...c })) : undefined,
      displayText: text,
    };

    // Comment-only sends do not branch: branching semantics tie to the user's
    // current turn, and flushing pending reply-to-selection comments is the
    // opposite of starting a new line of inquiry.
    const shouldBranch =
      !!text && shouldBranchOnSubmit({ forceBranch, slashBranched, streaming });
    if (shouldBranch) {
      await createChildChat(nodeId, finalText, meta);
    } else {
      sendMessage(nodeId, finalText, meta);
    }
  };

  const canAttach = !!getElectron()?.chooseFiles || !!activeProject;
  const sendDisabledBase = !draftHasText
    && pendingAttachments.length === 0
    && (n.pendingComments?.length ?? 0) === 0;
  const sendDisabled = observing || sendDisabledBase;

  const isError = n.status === 'error';
  // composerEmpty mirrors the same predicate used in the onSubmit early-return above.
  const composerEmpty = sendDisabledBase;
  const sendMode: PaneComposerSendMode =
    observing ? 'send'
    : composerEmpty && streaming ? 'stop'
    : composerEmpty && isError ? 'retry'
    : 'send';

  const PANE_DRAG_MIME = 'application/x-michi-pane-id';

  const handlePaneDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const next: 'left' | 'right' = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
    // dragOver fires ~60 Hz; gate setState so an unchanged side doesn't
    // re-render the whole pane (MessageBlock + composer) every tick.
    setPaneDropSide((cur) => (cur === next ? cur : next));
  };
  const handlePaneDragLeave = (e: React.DragEvent) => {
    // Ignore leaves into descendants
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
    setPaneDropSide(null);
  };
  const handlePaneDrop = (e: React.DragEvent) => {
    const fromId = e.dataTransfer.getData(PANE_DRAG_MIME);
    setPaneDropSide(null);
    if (!fromId || fromId === nodeId) return;
    e.preventDefault();
    reorderPane(fromId, nodeId);
  };

  return (
    <div
      data-node-id={nodeId}
      className="terminal-pane"
      onMouseDown={() => {
        focusPane(nodeId);
        setFocusedNodeId(nodeId);
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
        handleDragEnter(e);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDragOver(e);
          return;
        }
        handleDragOver(e);
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDragLeave(e);
          return;
        }
        handleDragLeave(e);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(PANE_DRAG_MIME)) {
          handlePaneDrop(e);
          return;
        }
        void handleDrop(e);
      }}
      style={paneShellStyle}
    >
      {n.spawnedByAgent && (
        <div
          style={{
            padding: '6px 14px',
            background: 'var(--term-mauve-f)',
            borderBottom: '1px solid var(--term-line)',
            fontSize: 10.5,
            color: 'var(--term-mauve)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700 }}>⎇</span>
          <span style={{ letterSpacing: '.04em' }}>
            spawned by agent{parentTitle ? ` · inherits ${parentTitle}` : ''}
          </span>
        </div>
      )}

      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SelectionActions
          containerRef={scrollRef}
          onQuote={(q) => setQuotedText(q)}
          onBranch={(q, p, anchorMessageId) => {
            void createChildChat(
              nodeId,
              formatQuotedMessage(q, p),
              { quotedText: q, displayText: p },
              { anchorMessageId },
            ).catch(() => {});
          }}
          onComment={(q, body) => addPendingComment(nodeId, q, body)}
        />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: prefs.paneTopFadeHeight,
          background: 'var(--term-pane-bg)',
          maskImage: 'linear-gradient(to bottom, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black, transparent)',
          pointerEvents: 'none',
          zIndex: 2,
        }}
      />
      <div
        ref={scrollRef}
        onWheel={(e) => {
          if (e.deltaY < 0) markUserScrollIntent();
        }}
        onTouchMove={markUserScrollIntent}
        onPointerDown={markUserScrollIntent}
        onKeyDown={markUserScrollIntentFromKey}
        onScroll={(e) => {
          // Keep the persisted anchor fresh so a refresh (which skips React
          // unmount) still restores to the latest position.
          schedulePaneScrollSave();
          const el = e.currentTarget;
          const prev = prevScrollTopRef.current;
          const cur = el.scrollTop;
          const distFromBottom = el.scrollHeight - cur - el.clientHeight;
          const programmatic = performance.now() < programmaticScrollUntilRef.current;
          if (programmatic) {
            prevScrollTopRef.current = cur;
            return;
          }
          const userInitiated = performance.now() < userScrollIntentUntilRef.current;
          if (userInitiated && cur < prev - 4 && distFromBottom > 64) {
            followRef.current = false;
          } else if (distFromBottom < 24) {
            followRef.current = true;
          }
          prevScrollTopRef.current = cur;
        }}
        className="term-scrollbar"
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowAnchor: 'none',
          // Sides + top scale with density; bottom always reserves clearance for
          // the floating composer (~card height + 12px gutter on each side, plus a
          // bit extra for the optional quote bar) so the last message can scroll
          // above the card instead of being trapped behind it.
          paddingTop:
            prefs.terminalDensity === 'dense' ? 8 : prefs.terminalDensity === 'compact' ? 12 : 16,
          paddingLeft:
            prefs.terminalDensity === 'dense' ? 22 : prefs.terminalDensity === 'compact' ? 24 : 32,
          paddingRight:
            prefs.terminalDensity === 'dense' ? 22 : prefs.terminalDensity === 'compact' ? 24 : 32,
          // Reserve clearance equal to the measured composer height + 12px top
          // gutter + 12px breathing buffer so the last message scrolls clear.
          paddingBottom: (n.pendingPermission || (n.pendingUserInput && !n.pendingUserInput.resolved)) ? 12 : composerHeight + 24,
          fontSize:
            prefs.terminalDensity === 'dense'
              ? 11
              : prefs.terminalDensity === 'compact'
              ? 12
              : 13,
          lineHeight:
            prefs.terminalDensity === 'dense'
              ? 1.45
              : prefs.terminalDensity === 'compact'
              ? 1.6
              : 1.75,
          color: 'var(--term-fg)',
        }}
      >
        <PaneMessageList
          node={n}
          mergeSourceLabels={mergeSourceLabels}
          prefs={prefs}
          contentStyle={innerWrap}
          streaming={streaming}
          viewportHeight={viewportH}
          onRetryTurn={handleRetryTurn}
          onEditUserMessage={handleEditUserMessage}
          onContinueFollowUp={handleContinueFollowUp}
          onBranchFollowUp={handleBranchFollowUp}
          followUpsDisabled={observing}
          anchorsByMessage={anchorsByMessage}
          onOpenBranch={handleOpenBranch}
          onBranchFromMessage={handleBranchFromMessage}
          contextNames={contextNamesSet}
        />
      </div>
      {!n.pendingPermission && !(n.pendingUserInput && !n.pendingUserInput.resolved) && (
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 12,
          background: 'var(--term-pane-bg, var(--term-surface))',
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />
      )}
      <MergeBanner nodeId={nodeId} />
      {!n.pendingPermission && !(n.pendingUserInput && !n.pendingUserInput.resolved) && (
      <ComposerShell
        ref={composerHandle}
        position="absolute"
        density={prefs.terminalDensity}
        contentMaxWidth={contentMaxWidth ?? null}
        dragHover={dragHover}
        toolbarRef={composerToolbarRef}
        onDragEnter={(e) => {
          // Always preventDefault so the browser doesn't navigate to a
          // dropped file in pure-browser dev mode.
          e.preventDefault();
          e.stopPropagation();
          if (!canAttach) return;
          setDragHover(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!canAttach) return;
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Ignore leaves into our own descendants — only clear when truly leaving.
          if (composerHandle.current?.el?.contains(e.relatedTarget as Node | null)) return;
          setDragHover(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragHover(false);
          const electron = getElectron();
          if (!electron?.getPathForFile) {
            void handleDrop(e);
            return;
          }
          const paths: string[] = [];
          for (const f of Array.from(e.dataTransfer.files)) {
            const p = electron.getPathForFile(f);
            if (p) paths.push(p);
          }
          if (paths.length > 0) addPendingPaths(paths);
        }}
        preBlocks={
          <>
            <UploadProgressBar progress={uploadProgress} />
            <PaneComposerPreBlocks
              node={n}
              quoteMaxLines={prefs.quoteMaxLines}
              quotedText={quotedText}
              pendingAttachments={pendingAttachments}
              onRestoreQueued={(queueId) => {
                // Restore the entry to the composer so the user can edit or
                // branch it. Order: read entry, splice from queue, populate draft.
                const entry = (n.pendingQueued ?? []).find((x) => x.id === queueId);
                if (!entry) return;
                dequeueMessage(nodeId, queueId);
                persistComposerDraft({ value: entry.value, mentions: entry.mentions }, null);
                setPendingAttachments(
                  entry.attachments.map((a, idx) => ({
                    id: `att-restored-${Date.now()}-${idx}`,
                    name: a.name,
                    absPath: a.absPath,
                    createdHere: false,
                  })),
                );
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              onEditPendingComment={(commentId, body) => editPendingComment(nodeId, commentId, body)}
              onRemovePendingComment={(commentId) => removePendingComment(nodeId, commentId)}
              onDismissQuote={() => setQuotedText(null)}
              onRemovePendingAttachment={removePendingAttachment}
            />
          </>
        }
        input={
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
            <MentionEditor
              ref={inputRef}
              value={draft.value}
              mentions={draft.mentions}
              onChange={setDraft}
              disabled={observing}
              className="hide-sb"
              contexts={mentionContexts}
              sameTreeNodes={sameTreeNodes}
              currentNodeId={nodeId}
              agentCommands={n.agentCommands}
              availableModes={availableModes}
              currentModeId={n.currentModeId}
              onSwitchAgent={(modeId) => switchAgent(nodeId, modeId).catch(() => {})}
              onSubmit={({ branch }) => observing ? undefined : void onSubmit(branch)}
              onPaste={(e) => { void handlePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>); }}
            />
            {observing && !draftHasText && (
              <div className="composer-observing-hint" aria-hidden>
                Viewing — another window is editing
              </div>
            )}
          </div>
        }
        toolbarLeft={
          <PaneComposerToolbarLeft
            canAttach={canAttach}
            toolbarTier={toolbarTier}
            currentMode={currentMode}
            currentModeId={n.currentModeId ?? undefined}
            availableModesCount={availableModes.length}
            agentStatus={agentStatus}
            providerModels={providerModels}
            onPickFile={() => void onPickFile()}
            onInsertMentionTrigger={insertMentionTrigger}
            onOpenAgentMenu={setAgentMenu}
            onOpenModelMenu={openModelMenu}
          />
        }
        toolbarRight={
          <PaneComposerActions
            draftHasText={draftHasText}
            sendMode={sendMode}
            streaming={streaming}
            sendDisabled={sendDisabled}
            onBranch={() => void onSubmit(true)}
            onSend={() => void onSubmit()}
            onStop={() => cancelStream(nodeId)}
            onRetry={() => retryLastTurn(nodeId)}
          />
        }
      />
      )}
      <PaneFind
        open={findOpen}
        node={n}
        focusNonce={findFocusNonce}
        onClose={() => setFindOpen(false)}
        onScrollToMatch={(match, occurrence, query) => {
          window.dispatchEvent(
            new CustomEvent('michi:scroll-to-message', {
              detail: {
                nodeId,
                messageId: match.messageId,
                messageIdx: match.messageIdx,
                flash: false,
                query,
                occurrence,
              },
            }),
          );
        }}
      />
      </div>

      {n.pendingPermission && (
        <PermissionBanner
          permission={n.pendingPermission}
          onRespond={(optionId) => resolvePermission(nodeId, optionId)}
          onCancel={() => denyPermission(nodeId)}
          readOnly={observing}
        />
      )}
      {n.pendingUserInput && !n.pendingUserInput.resolved && (
        <div style={{
          position: 'absolute',
          left: prefs.terminalDensity === 'dense' ? 18 : prefs.terminalDensity === 'compact' ? 20 : 26,
          right: prefs.terminalDensity === 'dense' ? 18 : prefs.terminalDensity === 'compact' ? 20 : 26,
          bottom: 12,
          zIndex: 1,
          ...(contentMaxWidth != null
            ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto' }
            : {}),
        }}>
          <UserInputBanner
            userInput={n.pendingUserInput}
            onSubmit={(answers) => resolveUserInputRequest(nodeId, answers)}
            onSkip={() => skipUserInputRequest(nodeId)}
            readOnly={observing}
          />
        </div>
      )}
      <PaneAgentMenus
        agentMenu={agentMenu}
        modelMenu={modelMenu}
        availableModes={availableModes}
        currentModeId={n.currentModeId ?? undefined}
        agentStatus={agentStatus}
        providerModels={providerModels}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onSwitchAgent={(modeId) => void switchAgent(nodeId, modeId)}
        onSaveModel={(model) => {
          void saveAgentOptions({ model }).then(() => {
            refreshAgentStatus();
          });
        }}
        onSaveReasoning={(reasoning) => {
          void saveAgentOptions({ reasoning }).then(() => {
            refreshAgentStatus();
          });
        }}
        onRetryModels={retryModels}
        onCloseAgentMenu={() => setAgentMenu(null)}
        onCloseModelMenu={() => setModelMenu(null)}
      />

      <PaneDropIndicator side={paneDropSide} />
      <FileDropOverlay visible={dropzoneVisible} fileCount={droppedFileCount} />
    </div>
  );
}

const MemoizedTPane = React.memo(TPane, (prev, next) =>
  prev.nodeId === next.nodeId &&
  prev.contentMaxWidth === next.contentMaxWidth,
);

MemoizedTPane.displayName = 'TPane';

export default MemoizedTPane;
