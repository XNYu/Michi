import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ensureSession, fetchAgentStatus, fetchReady, listAgentModes, listAgentModels, setChatMode, respondToPermission, cancelPermission, warmCwd, claimPane, heartbeatPane, releasePane, cancelChat } from '../services/api';
import type { AgentStatus, SessionMode } from '../services/api';
import { findTreeIdForNode } from './tree';
import { usePrefs } from './prefs';
import { DARK_PALETTES } from '../components/terminal/tokens';
import { resolveAtMentions, resolveAtNodeMentions, buildNodeTranscriptBlock, stripNodeMentionTokens, rewriteNodeMentionsForDisplay } from './contextBudget';
import { runChatStream } from './chatStreamRunner';
import { observeChatStream } from './observeChatStream';
import { mintOwnerToken, ownerStateReducer } from './paneOwnership';
import type { OwnerEvent, OwnerStateMap } from './paneOwnership';
import { visibleMessageText } from './assistantBlocks';
import * as perf from '../services/perf';
import { startupMark, startupMarkOnce } from '../services/startupTrace';
import { buildFlushPayload } from './queueFlush';
import { expandMentions } from '../components/mentions';
import { appendAttachmentsSentinel } from '../lib/composerAttachments';
import { joinMessageParts } from '../lib/commentFormat';
import { useDigestOrchestration } from './digestOrchestration';
import { buildSubtreeContextBlocks } from './mergePreamble';
import { usePaneState } from './paneState';
import { NODE_ACTIVITY_ACTIONS, reduceNodes, reduceProject } from './chatReducers';
import {
  LEGACY_STATE_KEY,
  buildStateKey,
  readActiveProjectId,
  readInitialHydrated,
  useWorkspacePersistence,
  writeActiveProjectId,
} from './workspacePersistence';
import { useContextActions } from './contextActions';
import { useProjectActions, useTreeActions } from './projectTreeActions';
import { useTrashActions } from './trashActions';
import { notify } from '../services/notifications';
import { API_BASE_URL } from '../config/env';
import { toast } from 'sonner';
import type { ChatAction, ChatActionsValue, ChatContextValue, ChatNodeState, ChatProjectsValue, ComposerDraft, MessageAttachment, PendingQueuedMessage, Project, ProjectEdge, Theme, UserSendMeta } from './chatTypes';
import { computeSurvivingMessageIds, cleanupOrphanedAnchors } from './branchAnchors';
import { sleep } from '../utils/sleep';

/**
 * Construct a branch edge with provenance fields stamped at fork time.
 * All 4 edge-creation sites in this file funnel through here so the shape
 * is a single source of truth.
 */
export function makeBranchEdge(params: {
  source: string;
  target: string;
  anchorMessageId?: string;
  createdAt: number;
  kind?: 'branch';
}): ProjectEdge {
  return {
    source: params.source,
    target: params.target,
    ...(params.kind ? { kind: params.kind } : {}),
    anchorMessageId: params.anchorMessageId,
    createdAt: params.createdAt,
  };
}

export { hydrateBackendWorkspaces, hydrateSavedState, STATE_SCHEMA_VERSION } from './chatHydration';
export { parseTitle } from './assistantParsing';
export { reduceProject } from './chatReducers';
export type {
  ChatAction,
  ChatContextValue,
  ChatMessage,
  ChatNodeState,
  ChatProjectsValue,
  ComposerDraft,
  ComposerMention,
  ContextEntry,
  EdgeKind,
  NodeKind,
  Project,
  ProjectAction,
  ProjectEdge,
  Theme,
  ToolCallState,
  Tree,
  ViewMode,
} from './chatTypes';

/**
 * Singleton workspace id for the "Chats" workspace — the default
 * folder-less home for ad-hoc conversations. Created lazily on first Skip.
 */
export const CHATS_WORKSPACE_ID = 'chats-default';

/**
 * High-frequency action types that throttle React renders to one per animation
 * frame and DO NOT advance the structure version. Streamed token / heartbeat /
 * tool-progress actions all fall here. Locked by chatReducers.structural.test.ts —
 * if you add a new type here, that test verifies it does not mutate any
 * structural field.
 */
export const HIGH_FREQ_ACTIONS: ReadonlySet<ChatAction['type']> = new Set([
  'chunk', 'thought', 'heartbeat', 'tool-call', 'tool-call-update', 'plan',
  'subagent-list-update', 'subagent-tool-activity', 'apply-seq',
]);

const ChatContext = createContext<ChatContextValue | null>(null);

interface ChatNodeStoreValue {
  getNode: (nodeId: string) => ChatNodeState | undefined;
  getNodes: () => Record<string, ChatNodeState>;
  subscribeNode: (nodeId: string, listener: () => void) => () => void;
  /** Subscribe to ANY node change. Listener fires once per `nodes` reference flip. */
  subscribe: (listener: () => void) => () => void;
  /** Returns a monotonic counter that bumps on non-HIGH_FREQ_ACTIONS dispatches. */
  getStructureVersion: () => number;
  /** Subscribe to structural changes — fires only when the version advances. (Wired in Task 3.) */
  subscribeStructure: (listener: () => void) => () => void;
}

/**
 * @internal Exposed only for structural-channel tests.
 * Production code should use useChatNode, useNodesSelector, useStructureVersion,
 * useStructuralSelector, or useChatNodesSnapshot — not this raw context.
 */
export const ChatNodeStoreContext = createContext<ChatNodeStoreValue | null>(null);
const ChatActionsContext = createContext<ChatActionsValue | null>(null);
const ChatProjectsContext = createContext<ChatProjectsValue | null>(null);

/**
 * Build a pre-rendered context block from a source node. The backend
 * embeds these verbatim into the merge node's first-message preamble.
 */
function buildMergeContextBlock(source: ChatNodeState | undefined): string | null {
  if (!source) return null;
  const title = source.title || source.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || 'thread';
  const lastAssistant = [...source.messages].reverse().find((m) => m.role === 'assistant' && visibleMessageText(m));
  if (!lastAssistant) return null;
  const visibleText = visibleMessageText(lastAssistant);
  if (!visibleText) return null;
  return `=== Source: ${title} ===\n${visibleText}`;
}

/**
 * Build a preamble block from a digest node. Used when a chat is branched off
 * a digest (e.g. "explore" on an open thread, or follow-up question from the
 * digest pane) — without this the new session would inherit no context since
 * digests have no chatId of their own.
 */
function buildDigestContextBlock(source: ChatNodeState | undefined): string | null {
  if (!source || source.kind !== 'digest' || !source.digest) return null;
  const title = source.title || 'Workspace digest';
  const content = source.digest.content?.trim();
  if (!content) return null;
  return `=== Digest: ${title} ===\n${content}`;
}

/** Return the nodeIds of every peer connected to `nodeId` via a 'link' edge. */
function linkedPeersOf(
  nodeId: string,
  edges: ReadonlyArray<ProjectEdge>,
): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.kind !== 'link') continue;
    if (e.source === nodeId) out.push(e.target);
    else if (e.target === nodeId) out.push(e.source);
  }
  return out;
}

/**
 * Subscribe to a child node's SSE stream. The child was pre-registered both
 * frontend-side (via the `agent-spawn` reducer which created its user + empty
 * assistant messages) and backend-side (its ACP chatId already exists). This
 * helper just kicks off the first prompt on that chatId and routes events
 * into the already-created assistant message id — it does NOT dispatch
 * `user-send` because that would duplicate the messages.
 */
function subscribeChildStream(
  chatId: string,
  prompt: string,
  nodeId: string,
  assistantId: string,
  dispatch: (a: ChatAction) => void,
  assistantTextBufs: React.MutableRefObject<Record<string, string>>,
  cancelFns: React.MutableRefObject<Record<string, () => void>>,
  ownerToken?: string,
): () => void {
  return runChatStream({
    chatId,
    prompt,
    nodeId,
    assistantId,
    dispatch,
    assistantTextBufs,
    cancelFns,
    ownerToken,
  });
}

/**
 * Returns the active tree's root nodeId, or `null` if the workspace has no
 * active tree (e.g. every tree was archived). Callers previously used
 * `project.chatIds[0]`; this is the forest-aware replacement.
 */
export function activeTreeRootNodeId(project: Project | null | undefined): string | null {
  if (!project || !project.activeTreeId) return null;
  const t = project.trees.find((x) => x.id === project.activeTreeId);
  return t ? t.rootNodeId : null;
}

function resolveWindowId(): string {
  const injected = (window as unknown as { electron?: { michiWindowId?: string } }).electron?.michiWindowId;
  if (typeof injected === 'string' && injected.length > 0) return injected;
  try {
    const key = 'michi:windowId';
    let v = window.sessionStorage.getItem(key);
    if (!v) {
      v = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(key, v);
    }
    return v;
  } catch {
    return 'default';
  }
}

export const WINDOW_ID = typeof window !== 'undefined' ? resolveWindowId() : 'default';

export function ChatProvider({ children, userId }: { children: React.ReactNode; userId?: string }) {
  const [nodes, setNodes] = useState<Record<string, ChatNodeState>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const activeProjectBaseKey = userId ? buildStateKey(userId) : LEGACY_STATE_KEY;
  // Seed from localStorage so the most-recently-active workspace is restored on
  // boot. Backend hydration runs async; without this seed, `initialActiveProjectIdRef`
  // captures `null` and falls back to `projects[0]`, which can land on a deleted
  // or archived row and leave the UI on "No workspace" until the user clicks one.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => readActiveProjectId(
      userId ? buildStateKey(userId) : LEGACY_STATE_KEY,
      WINDOW_ID,
      readInitialHydrated(userId).activeProjectId,
    ),
  );
  const {
    openPanes,
    focusedPane,
    viewMode,
    setOpenPanes,
    setFocusedPane,
    openPane,
    closePane,
    focusPane,
    reorderPane,
    setViewMode,
    retainProjectPaneKeys,
    setPaneSlot,
    ensurePaneSlot,
    openPaneInTree,
    prunePaneIds,
  } = usePaneState({ projects, activeProjectId });
  // Agent runtime descriptors, fetched on mount and refreshed on the
  // `michi:reload-agent-status` window event (dispatched by chatStreamRunner on
  // auth errors and by Settings when keys change). Not persisted.
  //   - agentStatus: capabilities-shaped descriptor consumed by ApiKeyGate,
  //     Settings (provider/model/reasoning controls), and the TPane toolbar chips.
  //   - availableModes: process-global list of agents (ACP modes), empirically
  //     identical across sessions/cwds, reused for every /agent picker.
  // Both load via the cold-start-tolerant effect below: on desktop the renderer
  // can mount before the backend is listening, so each fetch retries until it
  // lands instead of failing once and leaving the agent picker stuck on
  // "Loading…" (Kiro-CLI agents never appearing).
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [availableModes, setAvailableModes] = useState<SessionMode[]>([]);
  const [warmFailedError, setWarmFailedError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let statusLoaded = false;
    let modesLoaded = false;
    let statusRequestSeq = 0;

    // Track backend warmup for the cold-start error banner, but don't gate
    // /agent/status on it. Status is intentionally fast and lets the composer
    // render its agent/model chips while the runtime warm pool finishes.
    const POLL_INTERVAL_MS = 250;
    const POLL_TIMEOUT_MS = 30_000;

    const waitForReady = async (): Promise<'ready' | 'failed' | 'timeout'> => {
      const t0 = Date.now();
      while (!cancelled && Date.now() - t0 < POLL_TIMEOUT_MS) {
        try {
          const r = await fetchReady();
          if (r.status === 'ready') return 'ready';
          if (r.status === 'failed') {
            setWarmFailedError(r.error ?? 'Runtime failed to start');
            return 'failed';
          }
        } catch {
          // backend not yet listening — keep polling
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      return 'timeout';
    };

    const refreshSanitizedModel = (status: AgentStatus, seq: number) => {
      if (status.capabilities.models !== true) return;
      void listAgentModels({ provider: status.provider })
        .then((modelsResp) => {
          if (cancelled || seq !== statusRequestSeq) return;
          if (!modelsResp.sanitizedModel || modelsResp.sanitizedModel === status.model) return;
          setAgentStatus((prev) =>
            prev && prev.runtime === status.runtime
              ? { ...prev, model: modelsResp.sanitizedModel ?? undefined }
              : prev,
          );
        })
        .catch(() => {});
    };

    const load = async (): Promise<boolean> => {
      const seq = ++statusRequestSeq;
      try {
        const status = await fetchAgentStatus();
        if (cancelled || seq !== statusRequestSeq) return false;
        statusLoaded = true;
        setAgentStatus(status);
        refreshSanitizedModel(status, seq);
        return true;
      } catch {
        // Backend may not be listening yet — loadUntilLoaded retries below.
        return false;
      }
    };

    // Companion to load() for the /agent picker. A 200 (even an empty list for
    // a runtime without modes) counts as loaded; only a throw — connection
    // refused before the backend is listening, or a 500 while the ACP client
    // is still spawning — is retryable.
    const loadModes = async (): Promise<boolean> => {
      try {
        const modes = await listAgentModes();
        if (cancelled) return false;
        modesLoaded = true;
        setAvailableModes(modes);
        return true;
      } catch {
        // Backend may not be listening yet — loadUntilLoaded retries below.
        return false;
      }
    };

    // Poll /agent/status and /modes until each succeeds, independent of warm.
    // The runtime is registered synchronously before the backend starts
    // listening, so the first request that connects already returns full
    // capabilities and the agent list — there's no reason to wait for
    // /api/ready (which only flips to `ready` once the warm pool finishes).
    // Without this, a renderer that mounts before the backend is listening (the
    // norm in dev, where the window loads from the vite server while the backend
    // boots separately) would never re-fetch, leaving the composer chips blank
    // and the agent picker stuck on "Loading…" until then.
    const loadUntilLoaded = async () => {
      const t0 = Date.now();
      while (!cancelled && !(statusLoaded && modesLoaded) && Date.now() - t0 < POLL_TIMEOUT_MS) {
        if (!statusLoaded) await load();
        if (!modesLoaded) await loadModes();
        if (statusLoaded && modesLoaded) return;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    };

    const watchReady = async () => {
      const result = await waitForReady();
      if (cancelled) return;
      if (result === 'ready') setWarmFailedError(null);
      // Backstop: surface status/modes even if the poll above somehow never landed.
      if (result !== 'timeout') {
        if (!statusLoaded) void load();
        if (!modesLoaded) void loadModes();
      }
    };

    void loadUntilLoaded();
    void watchReady();
    const handler = () => { void load(); void loadModes(); };
    window.addEventListener('michi:reload-agent-status', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('michi:reload-agent-status', handler);
    };
  }, []);
  const refreshAgentStatus = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    }
  }, []);

  const [focusedNodeId, setFocusedNodeIdState] = useState<string | null>(null);
  const setFocusedNodeId = useCallback((id: string | null) => {
    setFocusedNodeIdState(id);
    // Keep activeTreeId in sync with focus so the sidebar's ThreadRow active
    // visual never lingers on a tree whose node is no longer focused. If the
    // focused node belongs to a tree, activate that tree; merge nodes (no
    // branch parent) resolve to null, which deactivates the project's tree.
    if (!id) return;
    setProjects((prev) => {
      const owning = prev.find((p) => p.chatIds.includes(id));
      if (!owning) return prev;
      const treeId = findTreeIdForNode(id, owning);
      if (treeId === owning.activeTreeId) return prev;
      return prev.map((p) => (p.id === owning.id ? reduceProject(p, { type: 'activate-tree', treeId }) : p));
    });
  }, []);
  const [unreadFilterOn, setUnreadFilterOnState] = useState<boolean>(false);
  const setUnreadFilterOn = useCallback((on: boolean) => {
    setUnreadFilterOnState(on);
  }, []);

  // Search highlight: holds the current keyword to highlight in chat messages.
  const [searchHighlightTerm, setSearchHighlightTerm] = useState<{ term: string; nodeId: string } | null>(null);

  // Auto-clear search highlight after 8 seconds so it doesn't persist indefinitely.
  // Centralised here to avoid multiple pane instances racing.
  useEffect(() => {
    if (!searchHighlightTerm) return;
    const timer = setTimeout(() => setSearchHighlightTerm(null), 8000);
    return () => clearTimeout(timer);
  }, [searchHighlightTerm]);

  const [selection, setSelectionState] = useState<ReadonlySet<string>>(() => new Set());

  const [hydrated, setHydrated] = useState(false);
  const [treeSelection, setTreeSelection] = useState<ReadonlySet<string>>(() => new Set());

  const toggleSelection = useCallback((nodeId: string) => {
    setSelectionState((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectionState(new Set());
  }, []);

  const toggleTreeSelection = useCallback((treeId: string) => {
    setTreeSelection((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      return next;
    });
  }, []);

  const clearTreeSelection = useCallback(() => {
    setTreeSelection(new Set());
  }, []);

  const selectAllTrees = useCallback(() => {
    const proj = projects.find((p) => p.id === activeProjectId);
    if (!proj) return;
    const liveTreeIds = proj.trees
      .filter((t) => !t.archivedAt && !nodesRef.current[t.rootNodeId]?.deletedAt)
      .map((t) => t.id);
    setTreeSelection(new Set(liveTreeIds));
  }, [projects, activeProjectId]);

  useEffect(() => {
    setSelectionState(new Set());
    setTreeSelection(new Set());
    retainProjectPaneKeys(activeProjectId);
  }, [activeProjectId, retainProjectPaneKeys]);

  // Close any open pane whose node became `deletedAt`, across EVERY pane key
  // (not just the active one). `deleteNode`/`trimNode` only clear the pane key
  // they run in, so a node deleted while another tree/tab holds an open pane —
  // or flipped to `deletedAt` by an L2 sync-conflict adoption — would otherwise
  // linger as a chattable pane even though the tree/sidebar hide it.
  //
  // The derived key is stable across renders (sorted trashed-id join), so the
  // EFFECT only re-fires when the trashed set actually changes; `prunePaneIds`
  // is additionally a no-op (no setState) when none of those ids are open.
  // The scan itself can't gate on the structural-version channel: the trash
  // mutators call setNodes directly (not dispatch), so they don't bump
  // structureVersion — gating there would miss deletions entirely. It runs in
  // ChatProvider's render (which already commits per RAF frame while
  // streaming), adding only an allocation-free O(nodeCount) read loop — not the
  // channel-mutating per-chunk work the structural fast-path guards against.
  const deletedIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const id in nodes) if (nodes[id]?.deletedAt) ids.push(id);
    return ids.sort().join(',');
  }, [nodes]);
  useEffect(() => {
    if (!deletedIdsKey) return;
    prunePaneIds(new Set(deletedIdsKey.split(',')));
  }, [deletedIdsKey, prunePaneIds]);

  const { prefs, setPref } = usePrefs();
  const theme: Theme = DARK_PALETTES.has(prefs.terminalPalette) ? 'dark' : 'light';

  const cancelFns = useRef<Record<string, () => void>>({});
  // Tracks nodes whose Stop button was pressed before their cancelFn got
  // registered (i.e. during ensureSession await / pre-SSE window). When
  // startStream finally registers a cancelFn for a node in this set, it
  // invokes it immediately.
  const pendingCancels = useRef<Set<string>>(new Set());
  const assistantTextBufs = useRef<Record<string, string>>({});
  /** Tracks chatIds that have been bound to the current backend process
   *  (via ensureSession). Reset on app restart (ref starts empty). */
  const boundSessionsRef = useRef<Set<string>>(new Set());
  const ownerTokenRef = useRef(mintOwnerToken());
  const [ownerState, setOwnerState] = useState<OwnerStateMap>({});
  const ownerStateRef = useRef<OwnerStateMap>({});
  const ownerClaimsRef = useRef<Record<string, { chatId: string }>>({});
  const claimInFlightRef = useRef<Set<string>>(new Set());
  const observerStopsRef = useRef<Record<string, () => void>>({});

  const nodesRef = useRef(nodes);
  const lastNotifiedNodesRef = useRef(nodes);
  const nodeSubscribersRef = useRef<Map<string, Set<() => void>>>(new Map());
  const storeSubscribersRef = useRef<Set<() => void>>(new Set());
  // Bumps on every non-HIGH_FREQ dispatch. Streamed-token commits keep it
  // still so structural consumers (useStructuralSelector, Task 4) skip work
  // each frame. Locked by chatStore.structural.test.tsx.
  const structureVersionRef = useRef(0);
  const lastNotifiedStructureVersionRef = useRef(0);
  const structureSubscribersRef = useRef<Set<() => void>>(new Set());
  /**
   * Held true by destructive async actions (Empty Trash, single-group purge)
   * while they await the backend's explicit DELETE/purge endpoint. The 2s
   * persistence interval checks this and skips the full-state POST /sync that
   * would otherwise race the purge — a pre-purge snapshot in flight when the
   * DELETE lands would re-insert the just-purged rows. Cleared after the
   * follower setState resolves so the next interval syncs the clean state.
   */
  const syncPausedRef = useRef(false);

  const notifyNodeSubscribers = useCallback((nodeIds: Iterable<string>) => {
    const listeners = new Set<() => void>();
    for (const id of nodeIds) {
      nodeSubscribersRef.current.get(id)?.forEach((listener) => listeners.add(listener));
    }
    listeners.forEach((listener) => listener());
  }, []);

  const notifyChangedNodeSubscribers = useCallback(
    (
      prev: Record<string, ChatNodeState>,
      next: Record<string, ChatNodeState>,
    ) => {
      if (prev === next) return;
      const changed = new Set<string>();
      for (const id of Object.keys(prev)) {
        if (prev[id] !== next[id]) changed.add(id);
      }
      for (const id of Object.keys(next)) {
        if (!(id in prev)) changed.add(id);
      }
      if (changed.size > 0) notifyNodeSubscribers(changed);
    },
    [notifyNodeSubscribers],
  );

  const nodeStore = useMemo<ChatNodeStoreValue>(
    () => ({
      getNode: (nodeId) => nodesRef.current[nodeId],
      getNodes: () => nodesRef.current,
      subscribeNode: (nodeId, listener) => {
        let listeners = nodeSubscribersRef.current.get(nodeId);
        if (!listeners) {
          listeners = new Set();
          nodeSubscribersRef.current.set(nodeId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners?.delete(listener);
          if (listeners?.size === 0) nodeSubscribersRef.current.delete(nodeId);
        };
      },
      subscribe: (listener) => {
        storeSubscribersRef.current.add(listener);
        return () => {
          storeSubscribersRef.current.delete(listener);
        };
      },
      getStructureVersion: () => structureVersionRef.current,
      subscribeStructure: (listener) => {
        structureSubscribersRef.current.add(listener);
        return () => {
          structureSubscribersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  // Per-session map remembering 'always allow' / 'never allow' choices for
  // tool-call permission requests. Key = permission title, value = optionId.
  const toolPermissionsRef = useRef<Map<string, string>>(new Map());

  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  const focusedPaneRef = useRef(focusedPane);
  useEffect(() => { focusedPaneRef.current = focusedPane; }, [focusedPane]);
  const openPanesRef = useRef(openPanes);
  useEffect(() => { openPanesRef.current = openPanes; }, [openPanes]);

  // `dispatch` keeps nodesRef.current up-to-date synchronously for the
  // reducer path, and structural setNodes callers must do the same before
  // asking React to render. This effect is only the notification bridge for
  // React commits.
  //
  // IMPORTANT: do not copy the committed `nodes` value back into nodesRef.
  // RAF-coalesced streaming renders can commit an older snapshot after
  // nodesRef has already advanced. Treating that commit as authoritative
  // rolls the stream backward and drops text mid-reply (for example broken
  // `[FOLLOW-` prefixes in follow-up sentinels).
  // Structural refs (structureVersionRef / lastNotifiedStructureVersionRef /
  // structureSubscribersRef) are also intentionally omitted — refs are stable
  // by definition and adding them would make the gate self-defeating.
  useEffect(() => {
    const prev = lastNotifiedNodesRef.current;
    const next = nodesRef.current;
    if (prev === next) return;
    lastNotifiedNodesRef.current = next;
    notifyChangedNodeSubscribers(prev, next);
    storeSubscribersRef.current.forEach((l) => l());

    // Structural channel: only fire when the version actually advanced since
    // the last commit. Streamed-token commits keep the version unchanged, so
    // useStructuralSelector consumers do not re-snapshot during streaming.
    const v = structureVersionRef.current;
    if (v !== lastNotifiedStructureVersionRef.current) {
      lastNotifiedStructureVersionRef.current = v;
      structureSubscribersRef.current.forEach((l) => l());
    }
  }, [nodes, notifyChangedNodeSubscribers]);

  useWorkspacePersistence({
    projects,
    activeProjectId,
    nodes,
    hydrated,
    nodesRef,
    setProjects,
    setActiveProjectId,
    setNodes,
    setHydrated,
    userId,
    windowId: WINDOW_ID,
    syncPausedRef,
  });

  useEffect(() => {
    if (!hydrated) return;
    writeActiveProjectId(activeProjectBaseKey, WINDOW_ID, activeProjectId);
  }, [hydrated, activeProjectId, activeProjectBaseKey]);

  // Pre-warm the active workspace's runtime session pool once hydration
  // discovers its cwd. On desktop startup this can run before the backend is
  // listening, so retry briefly instead of treating the first connection
  // refusal as a permanent miss.
  const warmedCwdsRef = React.useRef<Set<string>>(new Set());
  const warmingCwdsRef = React.useRef<Set<string>>(new Set());
  const warmRetryStatesRef = React.useRef<Map<string, { cancelled: boolean }>>(new Map());
  React.useEffect(() => {
    if (!hydrated || !activeProjectId) return;
    const p = projects.find((proj) => proj.id === activeProjectId);
    if (!p?.cwd) return;
    const cwd = p.cwd;
    const projectId = p.id;
    if (warmedCwdsRef.current.has(cwd) || warmingCwdsRef.current.has(cwd)) return;

    const retryState = { cancelled: false };
    const startedAt = Date.now();
    const retryDelayMs = 250;
    const maxAttempts = 120;
    warmingCwdsRef.current.add(cwd);
    warmRetryStatesRef.current.set(cwd, retryState);
    startupMark('workspace_warm_start', { cwd, projectId });

    const run = async () => {
      let attempts = 0;
      try {
        while (!retryState.cancelled && attempts < maxAttempts) {
          attempts += 1;
          try {
            await warmCwd(cwd);
            if (retryState.cancelled) return;
            warmedCwdsRef.current.add(cwd);
            startupMark('workspace_warm_done', { cwd, projectId, attempts, durMs: Date.now() - startedAt });
            return;
          } catch (err) {
            if (retryState.cancelled) return;
            startupMark('workspace_warm_attempt_failed', {
              cwd,
              projectId,
              attempts,
              error: (err as Error).message,
            });
            await sleep(retryDelayMs);
          }
        }
        if (!retryState.cancelled) {
          startupMark('workspace_warm_gave_up', { cwd, projectId, attempts, durMs: Date.now() - startedAt });
        }
      } finally {
        if (warmRetryStatesRef.current.get(cwd) === retryState) {
          warmRetryStatesRef.current.delete(cwd);
          warmingCwdsRef.current.delete(cwd);
        }
      }
    };
    void run();
  }, [hydrated, activeProjectId, projects]);

  const rafPending = React.useRef(false);

  const dispatch = useCallback((a: ChatAction) => {
    // Compute next from the ref (single source of truth for "latest"),
    // update the ref synchronously, then push to React. The previous pattern
    // (inside the setNodes functional updater) relied on React running
    // updaters synchronously — which it does not reliably do across renders
    // and batched event handlers. This caused startStream(newId, …) to read
    // the old ref and bail out when called right after a 'create' dispatch.
    const next = reduceNodes(nodesRef.current, a);
    nodesRef.current = next;

    if (!HIGH_FREQ_ACTIONS.has(a.type)) {
      structureVersionRef.current += 1;
    }

    // For high-frequency streaming actions, coalesce React renders into one
    // per animation frame. The ref is already up-to-date for synchronous
    // reads (e.g. startStream right after create).
    if (HIGH_FREQ_ACTIONS.has(a.type)) {
      if (!rafPending.current) {
        rafPending.current = true;
        requestAnimationFrame(() => {
          rafPending.current = false;
          setNodes(nodesRef.current);
        });
      }
    } else {
      setNodes(next);
    }

    if (NODE_ACTIVITY_ACTIONS.has(a.type)) {
      const nodeId =
        'nodeId' in a ? a.nodeId : 'parentNodeId' in a ? a.parentNodeId : undefined;
      if (!nodeId) return;
      const now = Date.now();
      setProjects((prev) =>
        prev.map((p) => {
          if (!p.chatIds.includes(nodeId)) return p;
          const treeId = findTreeIdForNode(nodeId, p);
          if (!treeId) return p;
          return reduceProject(p, { type: 'touch-tree', treeId, now });
        }),
      );
    }
  }, []);

  const dispatchOwner = useCallback((ev: OwnerEvent) => {
    const next = ownerStateReducer(ownerStateRef.current, ev);
    if (next === ownerStateRef.current) return;
    ownerStateRef.current = next;
    setOwnerState(next);
  }, []);

  const isObserver = useCallback(
    (nodeId: string) => ownerState[nodeId]?.role === 'observer',
    [ownerState],
  );

  const stopObserver = useCallback((nodeId: string) => {
    const stop = observerStopsRef.current[nodeId];
    if (!stop) return;
    stop();
    delete observerStopsRef.current[nodeId];
  }, []);

  const startObserver = useCallback(
    (nodeId: string, chatId: string) => {
      if (observerStopsRef.current[nodeId]) return;
      const node = nodesRef.current[nodeId];
      const lastTurnRef = { current: node?.lastAppliedTurnId ?? '' };
      const lastSeqRef = { current: node?.lastAppliedSeq ?? -1 };
      observerStopsRef.current[nodeId] = observeChatStream({
        chatId,
        nodeId,
        dispatch,
        lastTurnRef,
        lastSeqRef,
        onTerminal: () => {
          if (ownerStateRef.current[nodeId]?.role === 'owner') {
            stopObserver(nodeId);
          }
        },
      });
    },
    [dispatch, stopObserver],
  );

  const releasePaneOwnership = useCallback(
    (nodeId: string) => {
      const claim = ownerClaimsRef.current[nodeId];
      if (claim) {
        delete ownerClaimsRef.current[nodeId];
        releasePane(claim.chatId, ownerTokenRef.current).catch(() => {});
      }
      claimInFlightRef.current.delete(nodeId);
      stopObserver(nodeId);
      dispatchOwner({ type: 'released', nodeId });
    },
    [dispatchOwner, stopObserver],
  );

  const claimPaneOwnership = useCallback(
    async (nodeId: string, chatId: string) => {
      if (claimInFlightRef.current.has(nodeId)) return;
      claimInFlightRef.current.add(nodeId);
      try {
        const result = await claimPane(chatId, ownerTokenRef.current, WINDOW_ID);
        const stillOpen = openPanesRef.current.includes(nodeId);
        const currentChatId = nodesRef.current[nodeId]?.chatId;
        if (!stillOpen || currentChatId !== chatId) {
          if (result.owner) releasePane(chatId, ownerTokenRef.current).catch(() => {});
          return;
        }
        dispatchOwner({ type: 'claim-result', nodeId, result });
        if (result.owner) {
          ownerClaimsRef.current[nodeId] = { chatId };
          if (nodesRef.current[nodeId]?.status !== 'streaming') stopObserver(nodeId);
        } else {
          delete ownerClaimsRef.current[nodeId];
          startObserver(nodeId, chatId);
        }
      } catch {
        dispatchOwner({ type: 'claim-result', nodeId, result: { owner: false } });
        startObserver(nodeId, chatId);
      } finally {
        claimInFlightRef.current.delete(nodeId);
      }
    },
    [dispatchOwner, startObserver, stopObserver],
  );

  // Ownership bindings only depend on open pane ids and structural node fields
  // such as chatId. Streaming chunks flip the nodes map every RAF, but they do
  // not advance structureVersionRef; keep this key off the hot nodes ref so the
  // owner/observer effect does not re-run on every token.
  const openPaneBindingsKey = openPanes
    .map((id) => `${id}:${nodesRef.current[id]?.chatId ?? ''}`)
    .join('|');

  useEffect(() => {
    const openSet = new Set(openPanes);
    for (const nodeId of Object.keys(ownerClaimsRef.current)) {
      const claim = ownerClaimsRef.current[nodeId];
      if (!openSet.has(nodeId) || nodesRef.current[nodeId]?.chatId !== claim.chatId) {
        releasePaneOwnership(nodeId);
      }
    }
    for (const nodeId of Object.keys(observerStopsRef.current)) {
      if (!openSet.has(nodeId)) releasePaneOwnership(nodeId);
    }
    for (const nodeId of openPanes) {
      const chatId = nodesRef.current[nodeId]?.chatId;
      if (!chatId) continue;
      const claim = ownerClaimsRef.current[nodeId];
      if (claim?.chatId === chatId) continue;
      const role = ownerStateRef.current[nodeId]?.role;
      if (role === 'observer') {
        startObserver(nodeId, chatId);
      } else if (!claimInFlightRef.current.has(nodeId)) {
        void claimPaneOwnership(nodeId, chatId);
      }
    }
  }, [openPaneBindingsKey, openPanes, claimPaneOwnership, releasePaneOwnership, startObserver]);

  useEffect(() => {
    const HEARTBEAT_MS = 10_000;
    const timer = window.setInterval(() => {
      const openSet = new Set(openPanesRef.current);
      for (const nodeId of openSet) {
        const chatId = nodesRef.current[nodeId]?.chatId;
        if (!chatId) continue;
        const claim = ownerClaimsRef.current[nodeId];
        if (claim?.chatId === chatId) {
          heartbeatPane(chatId, ownerTokenRef.current)
            .then((ok) => {
              if (ok) return;
              delete ownerClaimsRef.current[nodeId];
              dispatchOwner({ type: 'heartbeat-demoted', nodeId });
              startObserver(nodeId, chatId);
            })
            .catch(() => {});
          continue;
        }
        const role = ownerStateRef.current[nodeId]?.role;
        if (role === 'observer' || !role) {
          void claimPaneOwnership(nodeId, chatId);
        }
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [claimPaneOwnership, dispatchOwner, startObserver]);

  useEffect(() => {
    const releaseAll = () => {
      for (const [nodeId, claim] of Object.entries(ownerClaimsRef.current)) {
        const body = JSON.stringify({ ownerToken: ownerTokenRef.current });
        const url = `${API_BASE_URL}/chats/${claim.chatId}/release`;
        if (navigator.sendBeacon) {
          const blob = new Blob([body], { type: 'application/json' });
          navigator.sendBeacon(url, blob);
        } else {
          releasePane(claim.chatId, ownerTokenRef.current).catch(() => {});
        }
        delete ownerClaimsRef.current[nodeId];
      }
    };
    window.addEventListener('beforeunload', releaseAll);
    return () => {
      window.removeEventListener('beforeunload', releaseAll);
      releaseAll();
    };
  }, []);

  // When the user moves focus to a node, mark it as viewed so the unread
  // indicator clears. This is the data-layer close of the read loop.
  useEffect(() => {
    if (focusedNodeId !== null) {
      dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now() });
    }
  }, [focusedNodeId, dispatch]);

  // Bulk close of the read loop — used by the unread filter's "Read all"
  // action to clear every unread chat thread at once.
  const markAllRead = useCallback(() => {
    dispatch({ type: 'mark-all-read', viewedAt: Date.now() });
  }, [dispatch]);

  const newNodeId = useCallback(
    () => `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  /** Stream a message. Lazily creates the backend chat session on first use. */
  const startStream = useCallback(
    async (
      nodeId: string,
      text: string,
      opts?: { contextFromNodeId?: string },
      meta?: UserSendMeta,
    ) => {
      const tSubmit = perf.now();
      perf.mark('client:user_submit', { nodeId, textLen: text.length });
      startupMarkOnce('first_message_send', { nodeId, textLen: text.length });
      const n = nodesRef.current[nodeId];
      if (!n) return;
      if (ownerStateRef.current[nodeId]?.role === 'observer') {
        console.warn('startStream called on observer pane — ignoring send');
        return;
      }
      const priorMessagesForResume = n.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          text: visibleMessageText(m),
        }));

      // Create assistant message synchronously first so status flips to 'streaming'
      // immediately, blocking concurrent submits on the same node.
      const assistantId = `a-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Rewrite @node:xxx tokens to @<title> for display so the chip the user
      // typed survives in the transcript. Raw tokens are resolved later and
      // injected as context into the outgoing prompt.
      const baseDisplay = meta?.displayText ?? text;
      const displayText = rewriteNodeMentionsForDisplay(baseDisplay, nodesRef.current);
      dispatch({
        type: 'user-send',
        nodeId,
        userText: displayText,
        assistantId,
        quotedText: meta?.quotedText,
        attachments: meta?.attachments,
        comments: meta?.comments,
      });
      assistantTextBufs.current[assistantId] = '';

      // Gather linked peers whose context hasn't been injected yet, so we
      // can bridge them into this node's session.
      const owningProject = projects.find((p) => p.id === n.projectId);
      const consumed = new Set(n.consumedLinks ?? []);
      const peerIds = linkedPeersOf(nodeId, owningProject?.edges ?? []).filter(
        (pid) => !consumed.has(pid),
      );
      const peerBlocks = peerIds
        .map((pid) => buildMergeContextBlock(nodesRef.current[pid]))
        .filter((b): b is string => !!b);

      const parentNode = n.parentNodeId ? nodesRef.current[n.parentNodeId] : undefined;
      // Digest parents have no chatId — create a fresh/compatible session and
      // inject the digest content as a preamble block instead. When the caller
      // re-anchored the branch edge (e.g. createChildChat from a digest
      // re-parents to the originating tree's root), it passes the digest's
      // nodeId via opts.contextFromNodeId so we can still build the preamble.
      const parentChatId = parentNode && parentNode.kind !== 'digest'
        ? parentNode.chatId ?? undefined
        : undefined;
      const cwd = owningProject?.cwd;
      const mergeContextsFromMerge = buildSubtreeContextBlocks(
        n.mergeSources ?? [],
        nodesRef.current,
        owningProject?.edges ?? [],
        (id) => !nodesRef.current[id]?.deletedAt,
      );
      const digestSourceNode = opts?.contextFromNodeId
        ? nodesRef.current[opts.contextFromNodeId]
        : parentNode;
      const digestParentBlock = buildDigestContextBlock(digestSourceNode);
      // Both merge sources and fresh link peers feed the same preamble slot;
      // a digest parent contributes its summary content the same way.
      const mergeContexts = [
        ...(digestParentBlock ? [digestParentBlock] : []),
        ...mergeContextsFromMerge,
        ...peerBlocks,
      ];

      // Resolve reusable contexts: auto-inject + @mentions.
      const autoCtxs = (owningProject?.contexts ?? []).filter(c => c.autoInject);
      const mentionCtxs = resolveAtMentions(text, owningProject?.contexts ?? []);
      const autoIds = new Set(autoCtxs.map(c => c.id));
      const dedupedMentions = mentionCtxs.filter(c => !autoIds.has(c.id));
      const allContexts = [...autoCtxs, ...dedupedMentions];

      const extraContexts = allContexts.length > 0
        ? allContexts.map(c => ({ name: c.name, filePath: c.filePath, size: c.size, kind: c.kind }))
        : undefined;

      const contextManifest = (owningProject?.contexts ?? []).length > 0
        ? (owningProject!.contexts!).map(c => ({ name: c.name, filePath: c.filePath, kind: c.kind }))
        : undefined;

      let chatId = n.chatId;
      let outgoingText = text;
      const tEnsureStart = perf.now();
      try {
        const ensured = await ensureSession({
          nodeId,
          chatId,
          cwd,
          workspaceId: owningProject?.id,
          parentChatId,
          mergeContexts: mergeContexts.length > 0 ? mergeContexts : undefined,
          extraContexts,
          enableFollowUps: prefsRef.current.enableFollowUps,
          contextManifest,
          priorMessages: priorMessagesForResume,
          runtimeId: n.runtimeId,
          providerId: n.providerId,
          modelId: n.modelId,
          reasoning: n.reasoning,
          // Desired agent for a brand-new thread (Home composer pre-selection).
          // Applied server-side after the fresh session is created, before this
          // first prompt streams. Ignored on resume (node already has a chatId).
          modeId: n.chatId ? undefined : n.currentModeId ?? undefined,
          resumeFingerprint: n.resumeFingerprint,
        });
        perf.measure('client:ensure_session', tEnsureStart, { nodeId, strategy: ensured.resumeStrategy });
        perf.measure('client:submit_to_ensured', tSubmit, { nodeId });
        chatId = ensured.chatId;
        dispatch({
          type: 'bind-chat',
          nodeId,
          chatId,
          currentModeId: ensured.currentModeId,
          runtimeId: ensured.runtimeId,
          providerId: ensured.providerId,
          modelId: ensured.modelId,
          reasoning: ensured.reasoning,
          resumeFingerprint: ensured.resumeFingerprint,
        });
        boundSessionsRef.current.add(chatId);

        if ((ensured.resumeStrategy === 'live' || ensured.resumeStrategy === 'exact') && peerBlocks.length > 0) {
          // Existing hidden context stays intact, so newly linked peer context
          // needs to ride on this user turn instead of first-message preamble.
          outgoingText =
            `The user linked a peer thread. Use the following as additional context:\n\n` +
            peerBlocks.join('\n\n') +
            `\n\n---\n\n${text}`;
        }
      } catch (err) {
        dispatch({
          type: 'error',
          nodeId,
          assistantId,
          message: (err as Error).message || 'failed to ensure chat session',
        });
        delete assistantTextBufs.current[assistantId];
        pendingCancels.current.delete(nodeId);
        return;
      }

      // Mark these peers consumed so we don't re-inject on the next turn.
      if (peerIds.length > 0) {
        dispatch({ type: 'consume-links', nodeId, peerIds });
      }

      if (!chatId) {
        dispatch({ type: 'error', nodeId, assistantId, message: 'failed to bind chat session' });
        delete assistantTextBufs.current[assistantId];
        pendingCancels.current.delete(nodeId);
        return;
      }

      // Resolve @node:xxx mentions — inject referenced node transcripts.
      const mentionedNodes = resolveAtNodeMentions(outgoingText, nodesRef.current);
      if (mentionedNodes.length > 0) {
        const nodeBlocks = mentionedNodes.map(mn => buildNodeTranscriptBlock(mn));
        const cleanText = stripNodeMentionTokens(outgoingText);
        outgoingText =
          `The user referenced the following chat nodes. Use their full conversation as context:\n\n` +
          nodeBlocks.join('\n\n') +
          `\n\n---\n\n${cleanText}`;
      }

      const cancel = runChatStream({
        chatId,
        prompt: outgoingText,
        nodeId,
        assistantId,
        dispatch,
        assistantTextBufs,
        cancelFns,
        requestNodeId: nodeId,
        ownerToken: ownerTokenRef.current,
        onTurnEnd: (reason, endedNodeId) => {
          if (reason === 'error') {
            // Evict session from the bound set so the next retry re-runs
            // ensureSession instead of hitting the same dead session.
            boundSessionsRef.current.delete(chatId);
          }
          const ended = nodesRef.current[endedNodeId];
          if (!ended) return;
          const queue = ended.pendingQueued ?? [];
          if (queue.length === 0) return;

          if (reason === 'error') {
            dispatch({ type: 'mark-queue-errored', nodeId: endedNodeId });
            return;
          }

          // 'done' or 'cancel' both flush. Build payload first, then clear
          // the queue, then send. The send goes through the same code path
          // as a fresh user submit (sendMessage on this same node).
          const payload = buildFlushPayload(queue);
          if (!payload) return;
          dispatch({ type: 'flush-queue', nodeId: endedNodeId });

          // Per-entry commentBlocks and quotedTexts captured at queue time
          // get folded back in here so streaming-time quotes / pending
          // comments don't get silently dropped. Multiple entries: join all
          // commentBlocks with a blank-line gap and use the EARLIEST quote
          // (FIFO order) — most users only have one of either active at a
          // time, so the merge is rarely visible.
          const commentBlocks = queue
            .map((q) => q.commentBlock)
            .filter((b): b is string => !!b);
          const combinedComments = commentBlocks.length > 0 ? commentBlocks.join('\n\n') : null;
          const firstQuote = queue.find((q) => q.quotedText)?.quotedText ?? null;

          // Order matches TPane.onSubmit: expand chips against payload.value
          // FIRST (so mention offsets resolve correctly), THEN prepend the
          // comment + quote prefix, THEN append the attachments sentinel.
          const expandedValue = expandMentions(payload.value, payload.mentions);
          const baseFinal = joinMessageParts(combinedComments, firstQuote, expandedValue);
          const expandedText = appendAttachmentsSentinel(baseFinal, payload.attachments);

          // Capture meta so the optimistic user message gets structured
          // quote/attachments fields. displayText preserves comment block +
          // expanded prose so reply-to-selection comments stay visible.
          // comments not modularised here yet — queued entries only carry the
          // pre-formatted commentBlock string, not PendingComment objects.
          // See follow-up for full queue-flush modularisation.
          const meta = {
            quotedText: firstQuote ?? undefined,
            attachments: payload.attachments.length > 0 ? payload.attachments.map(a => ({ ...a })) : undefined,
            displayText: joinMessageParts(combinedComments, null, expandedValue),
          };
          // Defer the send by one tick so the state update has settled.
          setTimeout(() => sendMessage(endedNodeId, expandedText, meta), 0);
        },
        extraHandlers: {
          onContextSaved: (name, filePath, size) => {
            setProjects(prev => prev.map(proj => {
              if (proj.id !== n.projectId) return proj;
              const existing = (proj.contexts ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase());
              return reduceProject(proj, {
                type: 'upsert-context',
                projectId: proj.id,
                context: {
                  id: existing?.id,
                  name,
                  filePath,
                  size,
                  source: 'agent',
                },
              });
            }));
          },
          onContextUpdated: (name, filePath, size) => {
            setProjects(prev => prev.map(proj =>
              proj.id === n.projectId
                ? reduceProject(proj, {
                    type: 'update-context-by-name',
                    projectId: proj.id,
                    context: { name, filePath, size, source: 'agent' },
                  })
                : proj,
            ));
          },
          onSpawnBranches: (topics) => {
          if (topics.length === 0) return;
          const parent = nodesRef.current[nodeId];
          if (!parent) return;
          const projectId = parent.projectId;
          const spawned = topics.map((t) => ({
            nodeId: newNodeId(),
            chatId: t.chatId,
            title: t.title,
            prompt: t.prompt,
            runtimeId: parent.runtimeId,
          }));
          // Capture the parent's last assistant message id BEFORE dispatch so we
          // can stamp it onto the new spawn edges as their anchor. The reducer's
          // agent-spawn case appends a tool-call block to that same message —
          // no new message is created — so this id is stable across the dispatch.
          const lastAssistantId = [...parent.messages]
            .reverse()
            .find((m) => m.role === 'assistant')?.id;
          const spawnCreatedAt = Date.now();
          // Reducer creates nodes + annotates parent's last assistant message
          dispatch({ type: 'agent-spawn', parentNodeId: nodeId, projectId, nodes: spawned });
          setProjects((prev) =>
            prev.map((p) =>
              p.id === projectId
                ? {
                    ...p,
                    chatIds: [...p.chatIds, ...spawned.map((s) => s.nodeId)],
                    edges: [
                      ...p.edges,
                      ...spawned.map((s) =>
                        makeBranchEdge({
                          source: nodeId,
                          target: s.nodeId,
                          kind: 'branch',
                          anchorMessageId: lastAssistantId,
                          createdAt: spawnCreatedAt,
                        }),
                      ),
                    ],
                  }
                : p,
            ),
          );
          // Auto-open the new panes so the user sees them stream in.
          setOpenPanes((prev) => [
            ...prev,
            ...spawned.map((s) => s.nodeId).filter((id) => !prev.includes(id)),
          ]);
          // Subscribe to each child's stream. Each child was pre-created
          // backend-side (chatId already bound); we just need to kick off the
          // first prompt and wire handlers for the inbound SSE.
          spawned.forEach((s) => {
            const cancel = subscribeChildStream(
              s.chatId,
              s.prompt,
              s.nodeId,
              `a-${s.nodeId}-0`,
              dispatch,
              assistantTextBufs,
              cancelFns,
              ownerTokenRef.current,
            );
            cancelFns.current[s.nodeId] = cancel;
          });
          },
          onPermissionRequest: (data) => {
            // Bypass all permissions when the pref is on
            if (prefsRef.current.bypassPermissions) {
              const node = nodesRef.current[nodeId];
              const allowOpt = data.options.find((o: { kind: string }) => o.kind === 'allow_once');
              if (node?.chatId && allowOpt) {
                respondToPermission(node.chatId, data.requestId, allowOpt.optionId);
                return;
              }
            }
            // Auto-approve/deny if user previously chose 'always allow' or 'never allow'
            const autoOption = toolPermissionsRef.current.get(data.title);
            if (autoOption) {
              const node = nodesRef.current[nodeId];
              if (node?.chatId) {
                respondToPermission(node.chatId, data.requestId, autoOption);
                return;
              }
            }
            // Show permission banner. The banner itself is the approval UI;
            // we only fire an OS notification when the window is unfocused,
            // skipping the in-app toast that would otherwise cover the
            // banner's right-side action buttons.
            dispatch({ type: 'permission-request', nodeId, permission: data });
            const prefs = prefsRef.current;
            if (prefs.notifications !== 'off' && !document.hasFocus()) {
              notify({
                title: 'Tool approval needed',
                body: data.title,
              });
            }
          },
        },
        onStreamComplete: () => {
          if (prefsRef.current.notifications === 'all') {
            if (document.hasFocus() && focusedPaneRef.current === nodeId) return;
            const node = nodesRef.current[nodeId];
            notify({ title: node?.title ?? 'Branch complete', body: 'Streaming finished' });
          }
        },
      });
      cancelFns.current[nodeId] = cancel;
      if (pendingCancels.current.has(nodeId)) {
        pendingCancels.current.delete(nodeId);
        cancel();
      }
    },
    [dispatch, newNodeId, projects, setOpenPanes],
  );

  const {
    createProject,
    enterChatsWorkspace,
    renameProject,
    setProjectInstructions,
    deleteProject,
    restoreProject,
    purgeProject,
    archiveProject,
    unarchiveProject,
    selectProject,
  } = useProjectActions({
    projects,
    activeProjectId,
    chatsWorkspaceId: CHATS_WORKSPACE_ID,
    nodesRef,
    setProjects,
    setActiveProjectId,
    setNodes,
  });

  const createChildChat = useCallback(
    async (
      parentNodeId: string,
      firstMessage: string,
      meta?: UserSendMeta,
      opts?: { anchorMessageId?: string },
    ) => {
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      // Digests are free-floating (not part of any tree). Re-anchor child
      // chats to the originating tree's root so they show up in the sidebar
      // tree under the thread the digest summarized. The digest content is
      // still injected as a preamble in startStream.
      let branchParentNodeId = parentNodeId;
      if (parent.kind === 'digest' && parent.digest) {
        const project = projects.find((p) => p.id === projectId);
        const liveSourceId = parent.digest.sources.find((sid) => {
          const s = nodesRef.current[sid];
          return !!s && !s.deletedAt;
        });
        const treeId = project && liveSourceId
          ? findTreeIdForNode(liveSourceId, project)
          : null;
        const tree = project?.trees.find((t) => t.id === treeId);
        if (tree && nodesRef.current[tree.rootNodeId]) {
          branchParentNodeId = tree.rootNodeId;
        }
      }
      const nodeId = newNodeId();
      dispatch({ type: 'create', nodeId, projectId, parentNodeId: branchParentNodeId });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, nodeId],
                edges: [
                  ...p.edges,
                  makeBranchEdge({
                    source: branchParentNodeId,
                    target: nodeId,
                    anchorMessageId: opts?.anchorMessageId,
                    createdAt,
                  }),
                ],
              }
            : p,
        ),
      );
      // Auto-open in a pane so it's visible in the dashboard view immediately.
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      setFocusedPane(nodeId);
      // Pass the original digest parent through to startStream so the digest
      // content lands as a preamble even though we re-anchored the branch edge.
      void startStream(
        nodeId,
        firstMessage,
        { contextFromNodeId: parent.kind === 'digest' ? parentNodeId : undefined },
        meta,
      );
      return nodeId;
    },
    [dispatch, newNodeId, projects, setFocusedPane, setOpenPanes, startStream],
  );

  const createBlankChild = useCallback(
    (parentNodeId: string, opts?: { anchorMessageId?: string }) => {
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      const nodeId = newNodeId();
      dispatch({ type: 'create', nodeId, projectId, parentNodeId });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, nodeId],
                edges: [
                  ...p.edges,
                  makeBranchEdge({
                    source: parentNodeId,
                    target: nodeId,
                    anchorMessageId: opts?.anchorMessageId,
                    createdAt,
                  }),
                ],
              }
            : p,
        ),
      );
      setOpenPanes((prev) => (prev.includes(nodeId) ? prev : [...prev, nodeId]));
      setFocusedPane(nodeId);
      return nodeId;
    },
    [dispatch, newNodeId, setFocusedPane, setOpenPanes],
  );

  const sameTree = useCallback(
    (a: string, b: string) => {
      const project = projects.find((p) => p.chatIds.includes(a) && p.chatIds.includes(b));
      if (!project) return false;
      return findTreeIdForNode(a, project) === findTreeIdForNode(b, project);
    },
    [projects],
  );

  const createMergedChat = useCallback(
    (sourceNodeIds: string[]) => {
      if (sourceNodeIds.length < 2) {
        toast.error('Select at least two threads to merge.');
        throw new Error('createMergedChat requires at least 2 source nodes');
      }
      const dedup = new Set(sourceNodeIds);
      if (dedup.size !== sourceNodeIds.length) {
        toast.error('Cannot merge a thread with itself.');
        throw new Error('createMergedChat: duplicate source ids (self-merge?)');
      }
      // All sources must belong to the same workspace.
      const projectId = projects.find((p) => p.chatIds.includes(sourceNodeIds[0]))?.id;
      if (!projectId) {
        toast.error('Could not find the workspace for the selected threads.');
        throw new Error('unknown source workspace');
      }
      for (const sid of sourceNodeIds) {
        const p = projects.find((proj) => proj.chatIds.includes(sid));
        if (!p || p.id !== projectId) {
          toast.error('Cannot merge threads across workspaces.');
          throw new Error('cross-workspace merge');
        }
      }
      const nodeId = newNodeId();
      const treeId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const now = Date.now();
      dispatch({
        type: 'create',
        nodeId,
        projectId,
        // No branch parent — merge nodes anchor a new tree of their own.
        mergeSources: sourceNodeIds,
      });
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== projectId) return p;
          // Add merge edges first, then create the merge tree (sets activeTreeId
          // to this tree, which paneKey will pick up on the next render).
          const withEdges = {
            ...p,
            edges: [
              ...p.edges,
              ...sourceNodeIds.map((src) => ({ source: src, target: nodeId, kind: 'merge' as const })),
            ],
          };
          return reduceProject(withEdges, {
            type: 'create-tree',
            treeId,
            rootNodeId: nodeId,
            now,
            kind: 'merge',
          });
        }),
      );
      // Seed the new tree's pane slot so the merge view is visible immediately,
      // mirroring createThread (paneKey still reflects the old activeTreeId).
      setPaneSlot(projectId, treeId, [nodeId], nodeId);
      setFocusedNodeIdState(nodeId);
      return nodeId;
    },
    [dispatch, newNodeId, projects, setPaneSlot, setProjects],
  );

  const sendMessage = useCallback(
    (
      nodeId: string,
      text: string,
      meta?: UserSendMeta,
    ) => {
      // Defensive guard: when a node is already streaming, submit() in the UI
      // layer should have routed this to createChildChat (auto-branch). If we
      // ever land here on a streaming node, do nothing — auto-branching inside
      // startStream would risk recursion with createChildChat.
      const node = nodesRef.current[nodeId];
      if (ownerStateRef.current[nodeId]?.role === 'observer') {
        console.warn('sendMessage called on observer pane — ignoring send');
        return;
      }
      if (node?.status === 'streaming') {
        console.warn(
          'sendMessage called on streaming node — expected createChildChat (auto-branch)',
        );
        return;
      }
      void startStream(nodeId, text, undefined, meta);
    },
    [startStream],
  );

  const retryLastTurn = useCallback(
    (nodeId: string, fromIndex?: number) => {
      const n = nodesRef.current[nodeId];
      if (!n) return;
      let sourceMsg: typeof n.messages[number] | undefined;
      if (fromIndex != null) {
        // Find the user message at or just before fromIndex.
        for (let j = fromIndex; j >= 0; j--) {
          if (n.messages[j]?.role === 'user') { sourceMsg = n.messages[j]; break; }
        }
      } else {
        sourceMsg = [...n.messages].reverse().find((m) => m.role === 'user');
      }
      if (!sourceMsg) return;
      cancelFns.current[nodeId]?.();
      // Compute surviving ids BEFORE dispatch — deterministic mirror of the
      // reducer's trim logic so we know which anchors become orphaned.
      const survivingIds = computeSurvivingMessageIds(n.messages, fromIndex);
      dispatch({ type: 'retry-trim', nodeId, fromIndex });
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== n.projectId) return p;
          const edges = cleanupOrphanedAnchors(p.edges, nodeId, survivingIds);
          return edges === p.edges ? p : { ...p, edges };
        }),
      );
      // For retries, the stored text is already the wire-flattened payload
      // (quote prefix + attachment sentinel are baked in for old messages).
      // For new messages with structured fields, m.text is bare prose, so we
      // re-flatten via joinMessageParts + appendAttachmentsSentinel so the
      // backend gets the same shape it always has.
      const reText = sourceMsg.text;
      const reQuote = sourceMsg.quotedText;
      const reAttach = sourceMsg.attachments ?? [];
      const reComments = sourceMsg.comments;
      const flattened = reQuote
        ? appendAttachmentsSentinel(joinMessageParts(null, reQuote, reText), reAttach)
        : appendAttachmentsSentinel(reText, reAttach);
      void startStream(nodeId, flattened, undefined, {
        quotedText: reQuote,
        attachments: reAttach.length > 0 ? reAttach.map(a => ({ ...a })) : undefined,
        comments: reComments,
        displayText: reText,
      });
    },
    [dispatch, setProjects, startStream],
  );

  const cancelStream = useCallback((nodeId: string) => {
    const fn = cancelFns.current[nodeId];
    if (fn) {
      fn();
    } else if (ownerStateRef.current[nodeId]?.role === 'owner' && nodesRef.current[nodeId]?.chatId) {
      cancelChat(nodesRef.current[nodeId]!.chatId!, ownerTokenRef.current).catch(() => {});
    } else if (ownerStateRef.current[nodeId]?.role === 'observer') {
      return;
    } else {
      // Stop was pressed before streamMessage registered its cancel fn.
      // Mark it so startStream aborts as soon as cancel is available.
      pendingCancels.current.add(nodeId);
    }
  }, []);

  const switchAgent = useCallback(
    async (nodeId: string, modeId: string) => {
      const n = nodesRef.current[nodeId];
      if (!n?.chatId) return;
      // Optimistic: kiro-cli 2.1.0 doesn't broadcast current_mode_update, so we
      // flip currentModeId locally. If the RPC fails we roll back.
      const prev = n.currentModeId ?? null;
      dispatch({ type: 'set-current-mode', nodeId, currentModeId: modeId });
      try {
        const updated = await setChatMode(n.chatId, modeId);
        if (updated && updated !== modeId) {
          dispatch({ type: 'set-current-mode', nodeId, currentModeId: updated });
        }
      } catch (err) {
        if (prev !== null) dispatch({ type: 'set-current-mode', nodeId, currentModeId: prev });
        throw err;
      }
    },
    [dispatch],
  );

  const resolvePermission = useCallback((nodeId: string, optionId: string) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingPermission) return;
    // Store 'always' choices for auto-approve on future requests
    const option = node.pendingPermission.options.find(o => o.optionId === optionId);
    if (option && (option.kind === 'allow_always' || option.kind === 'reject_always')) {
      toolPermissionsRef.current.set(node.pendingPermission.title, optionId);
    }
    respondToPermission(node.chatId, node.pendingPermission.requestId, optionId)
      .catch(() => toast.error('Failed to send permission response'));
    dispatch({ type: 'permission-resolved', nodeId });
  }, [dispatch]);

  const denyPermission = useCallback((nodeId: string) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingPermission) return;
    cancelPermission(node.chatId, node.pendingPermission.requestId)
      .catch(() => toast.error('Failed to send permission denial'));
    dispatch({ type: 'permission-resolved', nodeId });
  }, [dispatch]);

  const setMinimized = useCallback(
    (nodeId: string, minimized: boolean) => {
      dispatch({ type: 'set-minimized', nodeId, minimized });
    },
    [dispatch],
  );

  const setPaneWidth = useCallback(
    (nodeId: string, width: number | undefined) => {
      dispatch({ type: 'set-pane-width', nodeId, width });
    },
    [dispatch],
  );

  const addPendingComment = useCallback(
    (nodeId: string, quotedText: string, body: string) => {
      const trimmedQuote = quotedText.trim();
      const trimmedBody = body.trim();
      // Guard against empty entries: a comment needs at least the body text,
      // since a quote-only entry is what Quote reply already covers.
      if (!trimmedBody) return;
      dispatch({
        type: 'add-comment',
        nodeId,
        comment: {
          id:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          quotedText: trimmedQuote,
          body: trimmedBody,
          createdAt: Date.now(),
        },
      });
    },
    [dispatch],
  );

  const editPendingComment = useCallback(
    (nodeId: string, commentId: string, body: string) => {
      dispatch({ type: 'edit-comment', nodeId, commentId, body });
    },
    [dispatch],
  );

  const removePendingComment = useCallback(
    (nodeId: string, commentId: string) => {
      dispatch({ type: 'remove-comment', nodeId, commentId });
    },
    [dispatch],
  );

  const clearPendingComments = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'clear-comments', nodeId });
    },
    [dispatch],
  );

  const queueMessage = useCallback(
    (nodeId: string, message: PendingQueuedMessage) => {
      dispatch({ type: 'queue-message', nodeId, message });
    },
    [dispatch],
  );

  const dequeueMessage = useCallback(
    (nodeId: string, messageId: string) => {
      dispatch({ type: 'dequeue-message', nodeId, messageId });
    },
    [dispatch],
  );

  const flushQueue = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'flush-queue', nodeId });
    },
    [dispatch],
  );

  const markQueueErrored = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'mark-queue-errored', nodeId });
    },
    [dispatch],
  );

  const setComposerDraft = useCallback(
    (nodeId: string, draft: ComposerDraft | null) => {
      dispatch({ type: 'set-composer-draft', nodeId, draft });
    },
    [dispatch],
  );

  const setNodePosition = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      dispatch({ type: 'set-position', nodeId, position });
    },
    [dispatch],
  );

  const resetLayout = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      dispatch({ type: 'clear-positions', nodeIds: project.chatIds });
    },
    [dispatch, projects],
  );

  const linkNodes = useCallback(
    (a: string, b: string) => {
      if (a === b) return false;
      const an = nodesRef.current[a];
      const bn = nodesRef.current[b];
      if (!an || !bn) return false;
      if (an.projectId !== bn.projectId) return false;
      if (!sameTree(a, b)) return false;
      const project = projects.find((p) => p.id === an.projectId);
      if (!project) return false;
      // Reject if ANY edge already connects these two nodes (in either
      // direction). Duplicating a branch edge as a link adds no info and
      // would just clutter the graph model.
      const alreadyConnected = project.edges.some(
        (e) =>
          (e.source === a && e.target === b) || (e.source === b && e.target === a),
      );
      if (alreadyConnected) return false;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id
            ? { ...p, edges: [...p.edges, { source: a, target: b, kind: 'link' as const }] }
            : p,
        ),
      );
      // Linking fresh — forget any prior consumption on either side so the
      // newly-linked peer's current context flows in on the next message.
      dispatch({ type: 'forget-consumed-link', nodeId: a, peerId: b });
      dispatch({ type: 'forget-consumed-link', nodeId: b, peerId: a });
      return true;
    },
    [dispatch, projects, sameTree],
  );

  const unlinkNodes = useCallback(
    (a: string, b: string) => {
      setProjects((prev) =>
        prev.map((p) => ({
          ...p,
          edges: p.edges.filter(
            (e) =>
              !(
                e.kind === 'link' &&
                ((e.source === a && e.target === b) || (e.source === b && e.target === a))
              ),
          ),
        })),
      );
    },
    [],
  );

  const fanoutBranches = useCallback(
    async (parentNodeId: string, topics: string[], opts?: { anchorMessageId?: string }) => {
      const cleaned = topics.map((t) => t.trim()).filter(Boolean);
      if (cleaned.length === 0) return [];
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;

      // Pre-generate ids, add all structural updates in one pass so views see
      // the new nodes appear together.
      const newIds = cleaned.map(() => newNodeId());
      newIds.forEach((nid) => {
        dispatch({ type: 'create', nodeId: nid, projectId, parentNodeId });
      });
      const createdAt = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                chatIds: [...p.chatIds, ...newIds],
                edges: [
                  ...p.edges,
                  ...newIds.map((nid) =>
                    makeBranchEdge({
                      source: parentNodeId,
                      target: nid,
                      kind: 'branch',
                      anchorMessageId: opts?.anchorMessageId,
                      createdAt,
                    }),
                  ),
                ],
              }
            : p,
        ),
      );
      // Auto-open in panes so the new siblings are visible in the dashboard.
      setOpenPanes((prev) => [...prev, ...newIds.filter((id) => !prev.includes(id))]);
      setFocusedPane(newIds[0]);
      // Fire streams in parallel — each opens its own ACP session lazily.
      cleaned.forEach((topic, i) => {
        void startStream(newIds[i], topic);
      });
      return newIds;
    },
    [dispatch, newNodeId, setFocusedPane, setOpenPanes, startStream],
  );

  const { createDigest, refreshDigest, setDigestPrompt, markDigestViewed, deleteDigest } = useDigestOrchestration({
    projects,
    dispatch,
    nodesRef,
    setProjects,
    setNodes,
    sameTree,
    newNodeId,
  });

  const {
    deleteNode,
    trimNode,
    archiveNode,
    restoreDeletion,
    purgeDeletion,
    purgeDeletionAsync,
    restoreLastDeletion,
    emptyTrash,
    emptyTrashAsync,
  } = useTrashActions({
    projects,
    nodesRef,
    cancelFns,
    setProjects,
    setNodes,
    setOpenPanes,
    setFocusedPane,
    setFocusedNodeId: setFocusedNodeIdState,
    setSelection: setSelectionState,
    trashTTLDays: prefs.trashTTLDays,
    activeTreeRootNodeId,
    syncPausedRef,
  });

  const setSidebarExpandedPref = useCallback(
    (sidebarExpanded: typeof prefs.sidebarExpanded) => {
      setPref('sidebarExpanded', sidebarExpanded);
    },
    [setPref],
  );

  const {
    createThread,
    archiveTree,
    unarchiveTree,
    pinTree,
    unpinTree,
    renameTree,
    activateTree,
    deleteTree,
    moveTreeToWorkspace,
    bulkArchiveTrees,
    bulkDeleteTrees,
    bulkUnarchiveTrees,
  } = useTreeActions({
    projects,
    activeProjectId,
    nodesRef,
    cancelFns,
    dispatch,
    newNodeId,
    setProjects,
    setNodes,
    setOpenPanes,
    setFocusedPane,
    setPaneSlot,
    ensurePaneSlot,
    setFocusedNodeId: setFocusedNodeIdState,
    setSelection: setSelectionState,
    treeSelection,
    setTreeSelection,
    sidebarExpanded: prefs.sidebarExpanded,
    setSidebarExpanded: setSidebarExpandedPref,
  });

  const {
    createContext,
    updateContext,
    deleteContext,
    toggleAutoInject,
  } = useContextActions({
    projects,
    activeProjectId,
    setProjects,
  });

  // Auto-open the root pane when (and only when) the active workspace
  // CHANGES *and* the destination tree's pane slot is empty. Previously this
  // also depended on `projects`, which mutates on every chat/edge mutation —
  // so creating a new thread would trip this effect and blow away any split
  // panes the user had open. Now we also skip when callers (e.g. sidebar
  // cross-workspace branch click via `openPaneInTree`) have already seeded
  // the destination slot, so we don't clobber their explicit pane choice.
  const lastActiveProjectIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastActiveProjectIdRef.current === activeProjectId) return;
    lastActiveProjectIdRef.current = activeProjectId;
    const project = projects.find((p) => p.id === activeProjectId);
    if (!project) {
      setFocusedNodeIdState(null);
      setOpenPanes([]);
      setFocusedPane(null);
      return;
    }
    // If a caller has already populated the destination tree's pane slot
    // (paneKey = projectId::activeTreeId), let it stand — they own the
    // focused node + open panes for this switch. Reading openPanes here is
    // sound because openPanes already reflects the new paneKey by the time
    // this effect runs.
    if (openPanes.length > 0) return;
    setFocusedNodeIdState(null);
    const root = activeTreeRootNodeId(project) ?? project.chatIds[0];
    if (!root) {
      // Workspace has no trees yet (e.g. freshly created — first thread is
      // created lazily by Home composer's submit). Leave panes empty.
      setOpenPanes([]);
      setFocusedPane(null);
      return;
    }
    setOpenPanes([root]);
    setFocusedPane(root);
  }, [activeProjectId, projects, openPanes, setFocusedPane, setOpenPanes]);

  const toggleTheme = useCallback(() => {
    setPref('terminalPalette', DARK_PALETTES.has(prefs.terminalPalette) ? 'bone' : 'monokai');
  }, [prefs.terminalPalette, setPref]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId && !p.deletedAt) ?? null,
    [projects, activeProjectId],
  );

  const projectsValue = useMemo<ChatProjectsValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      // Read nodesRef.current (not the `nodes` state) so this memo doesn't
      // re-fire on every streaming chunk. deleteNode/restoreDeletion bump
      // project identity to keep `order`/`edges` fresh on deletedAt flips.
      order: (activeProject?.chatIds ?? []).filter((id) => !nodesRef.current[id]?.deletedAt),
      edges: (activeProject?.edges ?? []).filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      ),
      theme,
      availableModes,
      agentStatus,
      warmFailedError,
      refreshAgentStatus,
      openPanes,
      focusedPane,
      focusedNodeId,
      viewMode,
      selection,
      hydrated,
      treeSelection,
      searchHighlightTerm,
      unreadFilterOn,
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      theme,
      availableModes,
      agentStatus,
      warmFailedError,
      refreshAgentStatus,
      openPanes,
      focusedPane,
      focusedNodeId,
      viewMode,
      selection,
      hydrated,
      treeSelection,
      searchHighlightTerm,
      unreadFilterOn,
    ],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      // order / edges are the LIVE projection — soft-deleted nodes and the
      // edges touching them are filtered out. Consumers that need the raw
      // list (including trash rows) read `activeProject.chatIds` / `.edges`.
      order: (activeProject?.chatIds ?? []).filter((id) => !nodesRef.current[id]?.deletedAt),
      edges: (activeProject?.edges ?? []).filter(
        (e) => !nodesRef.current[e.source]?.deletedAt && !nodesRef.current[e.target]?.deletedAt,
      ),
      theme,
      toggleTheme,
      createProject,
      enterChatsWorkspace,
      renameProject,
      setProjectInstructions,
      deleteProject,
      restoreProject,
      purgeProject,
      archiveProject,
      unarchiveProject,
      selectProject,
      sendMessage,
      retryLastTurn,
      createChildChat,
      createBlankChild,
      createMergedChat,
      cancelStream,
      isObserver,
      availableModes,
      agentStatus,
      warmFailedError,
      refreshAgentStatus,
      switchAgent,
      deleteNode,
      trimNode,
      archiveNode,
      restoreLastDeletion,
      restoreDeletion,
      purgeDeletion,
      purgeDeletionAsync,
      emptyTrash,
      emptyTrashAsync,
      setMinimized,
      setPaneWidth,
      setNodePosition,
      resetLayout,
      fanoutBranches,
      linkNodes,
      unlinkNodes,
      createDigest,
      refreshDigest,
      setDigestPrompt,
      markDigestViewed,
      setComposerDraft,
      deleteDigest,
      openPanes,
      focusedPane,
      focusedNodeId,
      setFocusedNodeId,
      viewMode,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      reorderPane,
      setViewMode,
      selection,
      toggleSelection,
      clearSelection,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      toggleAutoInject,
      resolvePermission,
      denyPermission,
      hydrated,
      treeSelection,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      bulkUnarchiveTrees,
      searchHighlightTerm,
      setSearchHighlightTerm,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      queueMessage,
      dequeueMessage,
      flushQueue,
      markQueueErrored,
      unreadFilterOn,
      setUnreadFilterOn,
      markAllRead,
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      theme,
      toggleTheme,
      createProject,
      enterChatsWorkspace,
      renameProject,
      setProjectInstructions,
      deleteProject,
      restoreProject,
      purgeProject,
      archiveProject,
      unarchiveProject,
      selectProject,
      sendMessage,
      retryLastTurn,
      createChildChat,
      createBlankChild,
      createMergedChat,
      cancelStream,
      isObserver,
      availableModes,
      agentStatus,
      warmFailedError,
      refreshAgentStatus,
      switchAgent,
      deleteNode,
      trimNode,
      archiveNode,
      restoreLastDeletion,
      restoreDeletion,
      purgeDeletion,
      purgeDeletionAsync,
      emptyTrash,
      emptyTrashAsync,
      setMinimized,
      setPaneWidth,
      setNodePosition,
      resetLayout,
      fanoutBranches,
      linkNodes,
      unlinkNodes,
      createDigest,
      refreshDigest,
      setDigestPrompt,
      markDigestViewed,
      setComposerDraft,
      deleteDigest,
      openPanes,
      focusedPane,
      focusedNodeId,
      setFocusedNodeId,
      viewMode,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      reorderPane,
      setViewMode,
      selection,
      toggleSelection,
      clearSelection,
      createThread,
      archiveTree,
      unarchiveTree,
      pinTree,
      unpinTree,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      toggleAutoInject,
      resolvePermission,
      denyPermission,
      hydrated,
      treeSelection,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      bulkUnarchiveTrees,
      searchHighlightTerm,
      setSearchHighlightTerm,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      queueMessage,
      dequeueMessage,
      flushQueue,
      markQueueErrored,
      unreadFilterOn,
      setUnreadFilterOn,
      markAllRead,
    ],
  );

  const hotActions = useMemo<ChatActionsValue>(
    () => ({
      createProject,
      enterChatsWorkspace,
      selectProject,
      renameProject,
      archiveProject,
      unarchiveProject,
      deleteProject,
      sendMessage,
      retryLastTurn,
      createChildChat,
      createBlankChild,
      createMergedChat,
      fanoutBranches,
      switchAgent,
      cancelStream,
      isObserver,
      deleteNode,
      trimNode,
      archiveNode,
      setMinimized,
      setPaneWidth,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      toggleSelection,
      clearSelection,
      restoreLastDeletion,
      createThread,
      archiveTree,
      unarchiveTree,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      setFocusedNodeId,
      createDigest,
      resolvePermission,
      denyPermission,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      queueMessage,
      dequeueMessage,
      setComposerDraft,
      createContext,
      reorderPane,
      setUnreadFilterOn,
      markAllRead,
      dispatch,
    }),
    [
      createProject,
      enterChatsWorkspace,
      selectProject,
      renameProject,
      archiveProject,
      unarchiveProject,
      deleteProject,
      sendMessage,
      retryLastTurn,
      createChildChat,
      createBlankChild,
      createMergedChat,
      fanoutBranches,
      switchAgent,
      cancelStream,
      isObserver,
      deleteNode,
      trimNode,
      archiveNode,
      setMinimized,
      setPaneWidth,
      openPane,
      openPaneInTree,
      closePane,
      focusPane,
      toggleSelection,
      clearSelection,
      restoreLastDeletion,
      createThread,
      archiveTree,
      unarchiveTree,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      toggleTreeSelection,
      clearTreeSelection,
      selectAllTrees,
      bulkArchiveTrees,
      bulkDeleteTrees,
      setFocusedNodeId,
      createDigest,
      resolvePermission,
      denyPermission,
      addPendingComment,
      editPendingComment,
      removePendingComment,
      clearPendingComments,
      queueMessage,
      dequeueMessage,
      setComposerDraft,
      createContext,
      reorderPane,
      setUnreadFilterOn,
      markAllRead,
      dispatch,
    ],
  );

  return (
    <ChatNodeStoreContext.Provider value={nodeStore}>
      <ChatProjectsContext.Provider value={projectsValue}>
        <ChatActionsContext.Provider value={hotActions}>
          <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
        </ChatActionsContext.Provider>
      </ChatProjectsContext.Provider>
    </ChatNodeStoreContext.Provider>
  );
}

export function useChatStore(): ChatContextValue {
  const v = useContext(ChatContext);
  if (!v) throw new Error('useChatStore must be used within ChatProvider');
  return v;
}

export function useChatActions(): ChatActionsValue {
  const v = useContext(ChatActionsContext);
  if (!v) throw new Error('useChatActions must be used within ChatProvider');
  return v;
}

export function useChatProjects(): ChatProjectsValue {
  const v = useContext(ChatProjectsContext);
  if (!v) throw new Error('useChatProjects must be used within ChatProvider');
  return v;
}

/**
 * Returns the current structural-version counter from the node store.
 * The value bumps on every non-HIGH_FREQ_ACTIONS dispatch and stays still
 * during streaming, so consumers can render at structural rhythm without
 * being woken up by per-token chunk/heartbeat traffic.
 *
 * Subscribes via `useSyncExternalStore` against the dedicated structural
 * channel; the consuming component re-renders whenever the version
 * advances — independently of the parent `setNodes` re-render. For data
 * selection, prefer {@link useStructuralSelector}; this raw hook is mainly
 * useful for debug overlays or "no-op during streaming" gates.
 */
export function useStructureVersion(): number {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useStructureVersion must be used within ChatProvider');
  return useSyncExternalStore(
    store.subscribeStructure,
    store.getStructureVersion,
    store.getStructureVersion,
  );
}

export function useChatNode(nodeId: string): ChatNodeState | undefined {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useChatNode must be used within ChatProvider');
  const subscribe = useCallback(
    (listener: () => void) => store.subscribeNode(nodeId, listener),
    [store, nodeId],
  );
  const getSnapshot = useCallback(
    () => store.getNode(nodeId),
    [store, nodeId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useChatNodesSnapshot(): Record<string, ChatNodeState> {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useChatNodesSnapshot must be used within ChatProvider');
  return store.getNodes();
}

/**
 * Subscribe to a derived value computed from the full nodes map. Re-renders
 * only when the selector's output changes per `equalityFn` (default: `Object.is`).
 *
 * Use for whole-map derived values (counts, filtered arrays, tree walks).
 * For a single node prefer `useChatNode(id)`. For non-reactive lookups
 * inside callbacks prefer `useChatNodesSnapshot()`.
 *
 * @remarks Selector and equality functions are read via refs each call, so
 * passing inline lambdas that close over per-render variables is fine — the
 * hook re-runs the selector when its identity changes. Memoizing the selector
 * (with `useCallback`) is still beneficial: it lets the hook keep the cached
 * value when nothing relevant changed, avoiding redundant selector invocations.
 */
export function useNodesSelector<T>(
  selector: (nodes: Record<string, ChatNodeState>) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useNodesSelector must be used within ChatProvider');

  // Hold the latest selector / equalityFn in refs so a stable getSnapshot
  // reads the most recent versions. Pattern mirrors react-redux `useSelector`.
  const selectorRef = useRef(selector);
  const equalityRef = useRef(equalityFn);

  // If the selector identity changed since the last render, blow away the
  // cached result so the new selector runs on the next snapshot read.
  // Without this, when callers pass per-render closures whose captures
  // changed but the nodes ref hasn't flipped, the cache short-circuit at
  // `last.nodes === nodes` would return the old selector's stale result.
  const lastRef = useRef<{ value: T; nodes: Record<string, ChatNodeState> } | null>(null);
  if (selectorRef.current !== selector) {
    lastRef.current = null;
  }
  selectorRef.current = selector;
  equalityRef.current = equalityFn;

  const getSnapshot = useCallback(() => {
    const nodes = store.getNodes();
    const last = lastRef.current;
    if (last && last.nodes === nodes) return last.value;
    const value = selectorRef.current(nodes);
    if (last && equalityRef.current(last.value, value)) {
      lastRef.current = { value: last.value, nodes };
      return last.value;
    }
    lastRef.current = { value, nodes };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Like {@link useNodesSelector}, but its `getSnapshot` cache is keyed on the
 * store's structure version rather than the nodes-map reference. Streamed-
 * token commits keep the version still, so the selector body is NOT executed
 * each frame for the duration of a stream.
 *
 * Use this for selectors that read only structural fields (status, kind,
 * title, deletedAt/pinnedAt, markedReadAt/seenMessageIds, paneWidth, digest,
 * project edges) — never message text or block content. The
 * HIGH_FREQ_ACTIONS structural invariant (chatReducers.structural.test.ts)
 * guarantees those fields cannot change without advancing the version.
 *
 * @remarks For the version cache to short-circuit correctly, the selector
 * identity must be stable across renders. Wrap inline lambdas with
 * `useCallback` (or define them outside the component). If the selector
 * identity changes, the cache is cleared and the selector re-runs once.
 */
export function useStructuralSelector<T>(
  selector: (nodes: Record<string, ChatNodeState>) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(ChatNodeStoreContext);
  if (!store) throw new Error('useStructuralSelector must be used within ChatProvider');

  const selectorRef = useRef(selector);
  const equalityRef = useRef(equalityFn);

  const lastRef = useRef<{ value: T; version: number } | null>(null);
  if (selectorRef.current !== selector) {
    // Per-render closures break the version cache; blow away cached result so
    // the new selector runs on the next snapshot read.
    lastRef.current = null;
  }
  selectorRef.current = selector;
  equalityRef.current = equalityFn;

  const getSnapshot = useCallback(() => {
    const version = store.getStructureVersion();
    const last = lastRef.current;
    // Safe: HIGH_FREQ_ACTIONS cannot mutate structural fields, so same version
    // implies the selector output is unchanged. See chatReducers.structural.test.ts.
    if (last && last.version === version) return last.value;
    const value = selectorRef.current(store.getNodes());
    if (last && equalityRef.current(last.value, value)) {
      lastRef.current = { value: last.value, version };
      return last.value;
    }
    lastRef.current = { value, version };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribeStructure, getSnapshot, getSnapshot);
}

/** Shallow array equality — convenience for `useNodesSelector` outputs that are arrays. */
export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Derive a short label for a chat node from its first user message. */
export function chatLabel(chat: ChatNodeState | undefined): string {
  if (!chat) return 'new thread';
  const first = chat.messages.find((m) => m.role === 'user');
  if (!first) return 'New thread';
  const txt = first.text.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim();
  return txt.length > 50 ? txt.slice(0, 50) + '…' : txt;
}

/** Cross-project chat enumeration entry — used by the ⌘K palette and global search. */
export interface AllChatEntry {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
}

/**
 * Enumerate every non-deleted chat across every project. Foundation for cross-project
 * surfaces (⌘K palette, global search). Returned unsorted — surfaces apply their own
 * ordering (Task 3 will add recency sort once a `lastInteractedAt` field lands on
 * ChatNodeState; today the field doesn't exist).
 */
export function selectAllChats(state: {
  projects: Project[];
  nodes: Record<string, ChatNodeState>;
}): AllChatEntry[] {
  const out: AllChatEntry[] = [];
  for (const project of state.projects) {
    for (const chatId of project.chatIds) {
      const node = state.nodes[chatId];
      if (!node) continue;
      if (node.deletedAt) continue;
      out.push({
        id: chatId,
        title: chatLabel(node),
        projectId: project.id,
        projectName: project.name,
      });
    }
  }
  return out;
}
