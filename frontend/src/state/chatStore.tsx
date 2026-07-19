import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { allocateNodeIds, ensureSession, fetchAgentStatus, fetchReady, fetchWorkspace, listAgentModes, listAgentModels, setChatMode, respondToPermission, cancelPermission, respondToUserInput, skipUserInput, warmCwd, claimPane, heartbeatPane, releasePane, cancelChat, subscribeChat } from '../services/api';
import type { AgentStatus, SessionMode } from '../services/api';
import { findTreeIdForNode } from './tree';
import { usePrefs } from './prefs';
import { DARK_PALETTES } from '../components/terminal/tokens';
import { resolveAtMentions, resolveAtNodeMentions, buildNodeTranscriptBlock, stripNodeMentionTokens, rewriteNodeMentionsForDisplay } from './contextBudget';
import { runChatStream, type TurnEndReason } from './chatStreamRunner';
import { createBackgroundTurnBinding } from './observeChatStream';
import { createBackgroundTurnTransport } from './backgroundTurnTransport';
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
import { useNavHistory, type NavEntry } from './navHistory';
import { navigateToNode } from './navigateToNode';
import { NODE_ACTIVITY_ACTIONS, reduceNodes, reduceProject } from './chatReducers';
import {
  LEGACY_STATE_KEY,
  buildStateKey,
  readActiveProjectId,
  readInitialHydrated,
  useWorkspacePersistence,
  writeActiveProjectId,
} from './workspacePersistence';
import { useLazyTreeMessages } from './useLazyTreeMessages';
import { useContextActions } from './contextActions';
import { useProjectActions, useTreeActions } from './projectTreeActions';
import { useTrashActions } from './trashActions';
import { notify } from '../services/notifications';
import { API_BASE_URL } from '../config/env';
import { toast } from 'sonner';
import type { ChatAction, ChatActionsValue, ChatContextValue, ChatNodeState, ChatProjectsValue, ComposerDraft, MessageAttachment, PendingQueuedMessage, Project, ProjectEdge, Theme, UserSendMeta } from './chatTypes';
import { computeSurvivingMessageIds, cleanupOrphanedAnchors } from './branchAnchors';
import { sleep } from '../utils/sleep';
import { reconcileBackgroundWorkspaceSnapshot } from './backgroundGapReconcile';
import type { StreamHandlers } from '../services/chatStreamEvents';

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

function durableNodePrerequisite(project: Project, node: ChatNodeState): Record<string, unknown> {
  const directTreeId = findTreeIdForNode(node.nodeId, project);
  const parentTreeId = node.parentNodeId ? findTreeIdForNode(node.parentNodeId, project) : null;
  const treeId = directTreeId ?? parentTreeId;
  const tree = treeId ? project.trees.find((candidate) => candidate.id === treeId) : undefined;
  const existingEdges = project.edges.filter((edge) => edge.target === node.nodeId);
  const graphEdges: ProjectEdge[] = existingEdges.length > 0
    ? existingEdges
    : node.parentNodeId
      ? [{ source: node.parentNodeId, target: node.nodeId, kind: 'branch' as const }]
      : (node.mergeSources ?? []).map((source) => ({ source, target: node.nodeId, kind: 'merge' as const }));
  return {
    workspace: {
      id: project.id,
      name: project.name,
      cwd: project.cwd ?? null,
      createdAt: project.createdAt ?? Date.now(),
      activeTreeId: project.activeTreeId ?? treeId ?? null,
      settings: {
        ...(project.instructions ? { instructions: project.instructions } : {}),
        ...(project.aiGlobalContext === false ? { aiGlobalContext: false } : {}),
      },
    },
    ...(tree ? {
      tree: {
        id: tree.id,
        rootNodeId: tree.rootNodeId,
        name: tree.name ?? null,
        archivedAt: tree.archivedAt ?? null,
        pinnedAt: tree.pinnedAt ?? null,
        lastActiveAt: tree.lastActiveAt,
        createdAt: tree.createdAt,
      },
    } : {}),
    node: {
      id: node.nodeId,
      treeId: treeId ?? null,
      parentNodeId: node.parentNodeId ?? null,
      kind: node.kind,
      title: node.title ?? null,
      spawnedByAgent: node.spawnedByAgent ?? false,
      currentModeId: node.currentModeId ?? null,
      createdAt: node.messages[0]?.createdAt ?? project.createdAt ?? Date.now(),
    },
    edges: graphEdges.map((edge) => ({
      id: `${edge.kind || 'branch'}-${edge.source}-${edge.target}`,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      kind: edge.kind || 'branch',
      anchorMessageId: edge.anchorMessageId ?? null,
      createdAt: edge.createdAt ?? null,
    })),
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
  'set-composer-draft',
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
  const [projects, setProjectsState] = useState<Project[]>([]);
  // Structural actions often create a tree/node and submit its first message
  // in the same event handler. Keep the project forest synchronously readable,
  // matching nodesRef below, so startStream never builds a graph prerequisite
  // from the previous render's tree list.
  const projectsRef = useRef(projects);
  const setProjects = useCallback<React.Dispatch<React.SetStateAction<Project[]>>>((update) => {
    const next = typeof update === 'function'
      ? (update as (prev: Project[]) => Project[])(projectsRef.current)
      : update;
    projectsRef.current = next;
    setProjectsState(next);
  }, []);
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
    closePane: closePaneState,
    focusPane,
    reorderPane,
    setViewMode,
    retainProjectPaneKeys,
    setPaneSlot,
    ensurePaneSlot,
    openPaneInTree,
    appendPaneInTree,
    prunePaneIds,
  } = usePaneState({ projects, activeProjectId });
  // Latest active workspace id, read synchronously by the back/forward nav
  // callbacks (which must stay referentially stable for the actions context).
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  // Back/forward navigation history (per-window, in-memory only — reload clears
  // it). Wired to the focused-location observer + navBack/navForward below.
  const {
    record: recordNav,
    back: navHistoryBack,
    forward: navHistoryForward,
    prune: pruneNav,
    canBack: canNavBack,
    canForward: canNavForward,
  } = useNavHistory();
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
    // focused node belongs to a tree, activate that tree. Nodes outside any
    // tree (digest, merge) resolve to null — don't deactivate the current tree.
    if (!id) return;
    setProjects((prev) => {
      const owning = prev.find((p) => p.chatIds.includes(id));
      if (!owning) return prev;
      const treeId = findTreeIdForNode(id, owning);
      if (!treeId || treeId === owning.activeTreeId) return prev;
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
  const backgroundTransportRef = useRef<ReturnType<typeof createBackgroundTurnTransport> | null>(null);
  // Direct replay streams installed after a renderer reload. Kept separate
  // from normal prompt cancel fns so re-rendering cannot open duplicate SSE
  // consumers for the same hydrated foreground turn.
  const recoveredForegroundReplayRef = useRef<Map<string, { cancel: () => void; retry?: ReturnType<typeof setTimeout> }>>(new Map());
  const backgroundGapReconciliationsRef = useRef<Map<string, Promise<void>>>(new Map());
  const sharedStreamHandlersRef = useRef<(nodeId: string) => Omit<Partial<StreamHandlers>, 'onEnvelope' | 'onTurnStart' | 'onDone' | 'onError'>>(() => ({}));
  const turnEndHandlerRef = useRef<(reason: TurnEndReason, nodeId: string) => void>(() => {});
  const streamCompleteHandlerRef = useRef<(nodeId: string) => void>(() => {});
  const sendMessageRef = useRef<(nodeId: string, text: string, meta?: UserSendMeta) => void>(() => {});

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

  const closePane = useCallback((nodeId: string) => {
    const remaining = openPanes.filter((id) => id !== nodeId);
    const nextFocusedPane = focusedPane === nodeId
      ? remaining[remaining.length - 1] ?? null
      : focusedPane;
    closePaneState(nodeId);
    if (focusedNodeId === nodeId) setFocusedNodeIdState(nextFocusedPane);
  }, [closePaneState, focusedNodeId, focusedPane, openPanes]);

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
    structureVersion: nodeStore.getStructureVersion(),
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
  const warmedTargetsRef = React.useRef<Set<string>>(new Set());
  const warmingTargetsRef = React.useRef<Set<string>>(new Set());
  const warmRetryStatesRef = React.useRef<Map<string, { cancelled: boolean }>>(new Map());
  const activeWarmTargetRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hydrated || !activeProjectId) return;
    const p = projects.find((proj) => proj.id === activeProjectId);
    if (!p?.cwd) return;
    if (!agentStatus?.runtime) return;
    const cwd = p.cwd;
    const projectId = p.id;
    const runtime = agentStatus.runtime;
    const model = agentStatus.model ?? '';
    const warmTarget = `${runtime}\u0000${model}\u0000${cwd}`;
    const previousTarget = activeWarmTargetRef.current;
    if (previousTarget !== warmTarget) {
      activeWarmTargetRef.current = warmTarget;
      if (previousTarget) warmedTargetsRef.current.delete(previousTarget);
    }
    if (warmedTargetsRef.current.has(warmTarget) || warmingTargetsRef.current.has(warmTarget)) return;

    const retryState = { cancelled: false };
    const startedAt = Date.now();
    const retryDelayMs = 250;
    const maxAttempts = 120;
    warmingTargetsRef.current.add(warmTarget);
    warmRetryStatesRef.current.set(warmTarget, retryState);
    startupMark('workspace_warm_start', { cwd, projectId, runtime, model });

    const run = async () => {
      let attempts = 0;
      try {
        while (!retryState.cancelled && attempts < maxAttempts) {
          attempts += 1;
          try {
            await warmCwd(cwd);
            if (retryState.cancelled) return;
            if (activeWarmTargetRef.current === warmTarget) {
              warmedTargetsRef.current.add(warmTarget);
            }
            startupMark('workspace_warm_done', { cwd, projectId, runtime, model, attempts, durMs: Date.now() - startedAt });
            return;
          } catch (err) {
            if (retryState.cancelled) return;
            startupMark('workspace_warm_attempt_failed', {
              cwd,
              projectId,
              runtime,
              model,
              attempts,
              error: (err as Error).message,
            });
            await sleep(retryDelayMs);
          }
        }
        if (!retryState.cancelled) {
          startupMark('workspace_warm_gave_up', { cwd, projectId, runtime, model, attempts, durMs: Date.now() - startedAt });
        }
      } finally {
        if (warmRetryStatesRef.current.get(warmTarget) === retryState) {
          warmRetryStatesRef.current.delete(warmTarget);
          warmingTargetsRef.current.delete(warmTarget);
        }
      }
    };
    void run();
  }, [hydrated, activeProjectId, agentStatus?.runtime, agentStatus?.model, projects]);

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

  // Lazy-load: fetch the active tree's message bodies on demand when it's a
  // placeholder (hydration only eager-loads the initially-active tree).
  // Mounted after `dispatch` is defined so it can dispatch `messages-loaded`.
  useLazyTreeMessages({ hydrated, activeProjectId, projects, nodesRef, dispatch });

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

  const reconcileBackgroundGap = useCallback(async (gap: {
    chatId: string;
    nodeId?: string;
    turnId: string;
    seq: number;
  }, signal: AbortSignal = new AbortController().signal): Promise<void> => {
    const existing = backgroundGapReconciliationsRef.current.get(gap.chatId);
    if (existing) return existing;
    const reconciliation = (async () => {
      const nodeId = gap.nodeId
        ?? Object.values(nodesRef.current).find((candidate) => candidate.chatId === gap.chatId)?.nodeId;
      const node = nodeId ? nodesRef.current[nodeId] : undefined;
      const project = node
        ? projectsRef.current.find((candidate) => candidate.id === node.projectId)
        : undefined;
      if (!nodeId || !node || !project) {
        throw new Error(`Cannot reconcile background gap for unknown chat ${gap.chatId}`);
      }

      const waitForForegroundIdle = async () => {
        while (cancelFns.current[nodeId]) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            }, 50);
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }
      };

      // A local rename/delete/context edit can happen while the snapshot is in
      // flight. Treat object identity as a lightweight revision barrier and
      // refetch until the request spans a stable local state.
      while (true) {
        await waitForForegroundIdle();
        const projectsBefore = projectsRef.current;
        const nodesBefore = nodesRef.current;
        const projectBefore = projectsBefore.find((candidate) => candidate.id === project.id);
        const rawWorkspace = await fetchWorkspace(project.id, signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (cancelFns.current[nodeId]) continue;
        const projectAfter = projectsRef.current.find((candidate) => candidate.id === project.id);
        if (nodesRef.current !== nodesBefore || projectAfter !== projectBefore) continue;

        const result = reconcileBackgroundWorkspaceSnapshot({
          currentProjects: projectsRef.current,
          currentNodes: nodesRef.current,
          rawWorkspace,
          gap,
        });
        if (!result) throw new Error(`Durable workspace snapshot omitted ${gap.chatId}`);
        setProjects(result.projects);
        nodesRef.current = result.nodes;
        structureVersionRef.current += 1;
        setNodes(result.nodes);
        return;
      }
    })().finally(() => {
      if (backgroundGapReconciliationsRef.current.get(gap.chatId) === reconciliation) {
        backgroundGapReconciliationsRef.current.delete(gap.chatId);
      }
    });
    backgroundGapReconciliationsRef.current.set(gap.chatId, reconciliation);
    return reconciliation;
  }, [setProjects]);

  useEffect(() => {
    if (!hydrated) return;
    const bindings = new Map<string, { nodeId: string; handlers: StreamHandlers }>();
    const transport = createBackgroundTurnTransport({
      cursorSnapshot: () => {
        const cursors: Record<string, { turnId: string; seq: number }> = {};
        for (const node of Object.values(nodesRef.current)) {
          if (!node.chatId || !node.lastAppliedBackgroundTurnId || typeof node.lastAppliedBackgroundSeq !== 'number') continue;
          cursors[node.chatId] = { turnId: node.lastAppliedBackgroundTurnId, seq: node.lastAppliedBackgroundSeq };
        }
        return cursors;
      },
      onReplayGap: reconcileBackgroundGap,
      handlersForChat: (chatId, envelopeNodeId) => {
        const byEnvelope = envelopeNodeId ? nodesRef.current[envelopeNodeId] : undefined;
        const node = byEnvelope?.chatId === chatId
          ? byEnvelope
          : Object.values(nodesRef.current).find((candidate) => candidate.chatId === chatId);
        if (!node) return {};
        const nodeId = node.nodeId;
        const cached = bindings.get(chatId);
        if (cached?.nodeId === nodeId) return cached.handlers;
        const handlers = createBackgroundTurnBinding({
          chatId,
          nodeId,
          dispatch,
          lastTurnRef: {
            get current() { return nodesRef.current[nodeId]?.lastAppliedBackgroundTurnId ?? ''; },
            set current(_value: string) {},
          },
          lastSeqRef: {
            get current() { return nodesRef.current[nodeId]?.lastAppliedBackgroundSeq ?? -1; },
            set current(_value: number) {},
          },
          extraHandlers: sharedStreamHandlersRef.current(nodeId),
          onTurnEnd: (reason, endedNodeId) => turnEndHandlerRef.current(reason, endedNodeId),
          onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
        }).createHandlers();
        bindings.set(chatId, { nodeId, handlers });
        return handlers;
      },
    });
    backgroundTransportRef.current = transport;
    transport.start();
    return () => {
      transport.stop();
      if (backgroundTransportRef.current === transport) backgroundTransportRef.current = null;
    };
  }, [dispatch, hydrated, reconcileBackgroundGap]);

  // A reload can happen while a user-owned foreground turn is still active.
  // Reattach to its per-chat replay stream exactly once. A 410 is deliberately
  // left live: runtime self-turns are only authoritatively recovered by the
  // shared background feed, and marking this node done/error would hide it.
  useEffect(() => {
    if (!hydrated) return;
    const recover = (nodeId: string, attempt = 0) => {
      const node = nodesRef.current[nodeId];
      if (
        !node
        || node.status !== 'streaming'
        || !node.chatId
        || !node.lastAppliedTurnId
        || typeof node.lastAppliedSeq !== 'number'
        || recoveredForegroundReplayRef.current.has(nodeId)
      ) return;
      const assistantId = [...node.messages].reverse().find((message) => message.role === 'assistant')?.id;
      if (!assistantId) return;
      let stopped = false;
      const finish = () => {
        const entry = recoveredForegroundReplayRef.current.get(nodeId);
        if (entry?.cancel === cancel) recoveredForegroundReplayRef.current.delete(nodeId);
        if (cancelFns.current[nodeId] === stop) delete cancelFns.current[nodeId];
      };
      const binding = createBackgroundTurnBinding({
        chatId: node.chatId,
        nodeId,
        dispatch,
        cursor: 'foreground',
        lastTurnRef: {
          get current() { return nodesRef.current[nodeId]?.lastAppliedTurnId ?? ''; },
          set current(_value: string) {},
        },
        lastSeqRef: {
          get current() { return nodesRef.current[nodeId]?.lastAppliedSeq ?? -1; },
          set current(_value: number) {},
        },
        extraHandlers: sharedStreamHandlersRef.current(nodeId),
        onTurnEnd: (reason, endedNodeId) => turnEndHandlerRef.current(reason, endedNodeId),
        onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
        onTerminal: finish,
      }).createHandlers();
      const cancel = subscribeChat(node.chatId, binding, {
        turnId: node.lastAppliedTurnId,
        seq: node.lastAppliedSeq,
      }, {
        onDisconnect: ({ retryable, error }) => {
          const entry = recoveredForegroundReplayRef.current.get(nodeId);
          if (!entry || entry.cancel !== cancel || stopped) return;
          // A replay ring miss can be a self-initiated runtime turn. The
          // background feed owns that recovery path and will reconcile it.
          if (error?.message.endsWith(': 410')) return;
          if (!retryable) {
            dispatch({ type: 'error', nodeId, assistantId, message: error?.message ?? 'turn replay disconnected' });
            finish();
            return;
          }
          recoveredForegroundReplayRef.current.delete(nodeId);
          entry.retry = setTimeout(() => recover(nodeId, attempt + 1), Math.min(10_000, 500 * (2 ** attempt)));
        },
      });
      const stop = () => {
        stopped = true;
        const entry = recoveredForegroundReplayRef.current.get(nodeId);
        if (entry?.retry) clearTimeout(entry.retry);
        cancel();
        cancelChat(node.chatId!, ownerTokenRef.current, nodesRef.current[nodeId]?.lastAppliedTurnId).catch(() => {});
        finish();
      };
      recoveredForegroundReplayRef.current.set(nodeId, { cancel });
      cancelFns.current[nodeId] = stop;
    };
    for (const node of Object.values(nodesRef.current)) recover(node.nodeId);
    return () => {
      for (const entry of recoveredForegroundReplayRef.current.values()) {
        if (entry.retry) clearTimeout(entry.retry);
        entry.cancel();
      }
      recoveredForegroundReplayRef.current.clear();
    };
  }, [dispatch, hydrated]);

  const releasePaneOwnership = useCallback(
    (nodeId: string) => {
      const claim = ownerClaimsRef.current[nodeId];
      if (claim) {
        delete ownerClaimsRef.current[nodeId];
        releasePane(claim.chatId, ownerTokenRef.current).catch(() => {});
      }
      claimInFlightRef.current.delete(nodeId);
      dispatchOwner({ type: 'released', nodeId });
    },
    [dispatchOwner],
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
        } else {
          delete ownerClaimsRef.current[nodeId];
        }
      } catch {
        dispatchOwner({ type: 'claim-result', nodeId, result: { owner: false } });
      } finally {
        claimInFlightRef.current.delete(nodeId);
      }
    },
    [dispatchOwner],
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
    for (const nodeId of openPanes) {
      const chatId = nodesRef.current[nodeId]?.chatId;
      if (!chatId) continue;
      const claim = ownerClaimsRef.current[nodeId];
      if (claim?.chatId === chatId) continue;
      const role = ownerStateRef.current[nodeId]?.role;
      if (role !== 'owner' && !claimInFlightRef.current.has(nodeId)) {
        void claimPaneOwnership(nodeId, chatId);
      }
    }
  }, [openPaneBindingsKey, openPanes, claimPaneOwnership, releasePaneOwnership]);

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
  }, [claimPaneOwnership, dispatchOwner]);

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
  // indicator clears. On cleanup (focus departing), re-stamp viewedAt so any
  // lastAssistantAt that landed while focused is covered — without this, a
  // node that completed streaming while you were looking at it would show
  // unread the moment you navigated away.
  useEffect(() => {
    if (focusedNodeId !== null) {
      dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now() });
    }
    return () => {
      if (focusedNodeId !== null) {
        dispatch({ type: 'node-viewed', nodeId: focusedNodeId, viewedAt: Date.now() });
      }
    };
  }, [focusedNodeId, dispatch]);

  // Bulk close of the read loop — used by the unread filter's "Read all"
  // action to clear every unread chat thread at once.
  const markAllRead = useCallback(() => {
    dispatch({ type: 'mark-all-read', viewedAt: Date.now() });
  }, [dispatch]);

  const renameNode = useCallback(
    (nodeId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      dispatch({ type: 'rename-node', nodeId, title: trimmed });
    },
    [dispatch],
  );

  const newNodeId = useCallback(
    async () => {
      try {
        return (await allocateNodeIds(1))[0];
      } catch (err) {
        toast.error('Could not allocate a new thread id.');
        throw err;
      }
    },
    [],
  );

  /** Feature side effects shared by foreground and runtime self-turn streams. */
  const createSharedStreamHandlers = useCallback((nodeId: string): Omit<Partial<StreamHandlers>, 'onEnvelope' | 'onTurnStart' | 'onDone' | 'onError'> => ({
    onContextSaved: (name, filePath, size, contextId) => {
      const projectId = nodesRef.current[nodeId]?.projectId;
      if (!projectId) return;
      setProjects((prev) => prev.map((project) => {
        if (project.id !== projectId) return project;
        const existing = (project.contexts ?? []).find((context) => context.name.toLowerCase() === name.toLowerCase());
        return reduceProject(project, {
          type: 'upsert-context',
          projectId,
          context: { id: contextId ?? existing?.id, name, filePath, size, source: 'agent' },
        });
      }));
    },
    onContextUpdated: (name, filePath, size, contextId) => {
      const projectId = nodesRef.current[nodeId]?.projectId;
      if (!projectId) return;
      setProjects((prev) => prev.map((project) => project.id === projectId
        ? reduceProject(project, {
            type: 'update-context-by-name',
            projectId,
            context: { id: contextId, name, filePath, size, source: 'agent' },
          })
        : project));
    },
    onSpawnBranches: (topics) => {
      if (topics.length === 0) return;
      const parent = nodesRef.current[nodeId];
      if (!parent) return;
      const projectId = parent.projectId;
      const owningProject = projectsRef.current.find((project) => project.id === projectId);
      const treeId = owningProject ? findTreeIdForNode(nodeId, owningProject) : null;
      const spawned = topics.map((topic) => ({
        nodeId: topic.nodeId ?? topic.chatId,
        chatId: topic.chatId,
        title: topic.title,
        prompt: topic.prompt,
        runtimeId: parent.runtimeId,
      }));
      const lastAssistantId = [...parent.messages]
        .reverse()
        .find((message) => message.role === 'assistant')?.id;
      const spawnCreatedAt = Date.now();
      dispatch({ type: 'agent-spawn', parentNodeId: nodeId, projectId, nodes: spawned });
      setProjects((prev) => prev.map((project) => project.id === projectId
        ? {
            ...project,
            chatIds: [...project.chatIds, ...spawned.map((child) => child.nodeId)
              .filter((nodeId) => !project.chatIds.includes(nodeId))],
            edges: [
              ...project.edges,
              ...spawned
                .filter((child) => !project.edges.some((edge) =>
                  edge.source === nodeId && edge.target === child.nodeId && (edge.kind ?? 'branch') === 'branch'))
                .map((child) => makeBranchEdge({
                source: nodeId,
                target: child.nodeId,
                kind: 'branch',
                anchorMessageId: lastAssistantId,
                createdAt: spawnCreatedAt,
              })),
            ],
          }
        : project));
      if (treeId) {
        for (const child of spawned) appendPaneInTree(projectId, treeId, child.nodeId);
      }
    },
    onPermissionRequest: (data) => {
      if (prefsRef.current.bypassPermissions) {
        const allowOption = data.options.find((option) => option.kind === 'allow_once');
        const chatId = nodesRef.current[nodeId]?.chatId;
        if (chatId && allowOption) {
          void respondToPermission(chatId, data.requestId, allowOption.optionId);
          return;
        }
      }
      const autoOption = toolPermissionsRef.current.get(data.title);
      const chatId = nodesRef.current[nodeId]?.chatId;
      if (autoOption && chatId) {
        void respondToPermission(chatId, data.requestId, autoOption);
        return;
      }
      dispatch({ type: 'permission-request', nodeId, permission: data });
      if (prefsRef.current.notifications !== 'off' && !document.hasFocus()) {
        notify({ title: 'Tool approval needed', body: data.title });
      }
    },
    onUserInputRequest: (data) => {
      dispatch({
        type: 'user-input-request',
        nodeId,
        userInput: { requestId: data.requestId, questions: data.questions, answers: [] },
      });
      if (prefsRef.current.notifications !== 'off' && !document.hasFocus()) {
        notify({
          title: 'Agent needs your input',
          body: data.questions[0]?.question ?? 'Please answer',
        });
      }
    },
    onUserInputResolved: () => dispatch({ type: 'user-input-resolved', nodeId }),
  }), [dispatch, openPaneInTree, setProjects]);
  sharedStreamHandlersRef.current = createSharedStreamHandlers;

  const handleTurnEnd = useCallback((reason: TurnEndReason, endedNodeId: string) => {
    const ended = nodesRef.current[endedNodeId];
    if (reason === 'error') {
      boundSessionsRef.current.delete(endedNodeId);
    }
    if (!ended) return;
    const queue = ended.pendingQueued ?? [];
    if (queue.length === 0) return;
    if (reason === 'error') {
      dispatch({ type: 'mark-queue-errored', nodeId: endedNodeId });
      return;
    }

    const payload = buildFlushPayload(queue);
    if (!payload) return;
    dispatch({ type: 'flush-queue', nodeId: endedNodeId });
    const commentBlocks = queue
      .map((entry) => entry.commentBlock)
      .filter((block): block is string => !!block);
    const combinedComments = commentBlocks.length > 0 ? commentBlocks.join('\n\n') : null;
    const firstQuote = queue.find((entry) => entry.quotedText)?.quotedText ?? null;
    const expandedValue = expandMentions(payload.value, payload.mentions);
    const expandedText = appendAttachmentsSentinel(
      joinMessageParts(combinedComments, firstQuote, expandedValue),
      payload.attachments,
    );
    const meta: UserSendMeta = {
      quotedText: firstQuote ?? undefined,
      attachments: payload.attachments.length > 0
        ? payload.attachments.map((attachment) => ({ ...attachment }))
        : undefined,
      displayText: joinMessageParts(combinedComments, null, expandedValue),
    };
    setTimeout(() => sendMessageRef.current(endedNodeId, expandedText, meta), 0);
  }, [dispatch]);
  turnEndHandlerRef.current = handleTurnEnd;

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
      const owningProject = projectsRef.current.find((p) => p.id === n.projectId);
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

      // Resolve reusable artifacts to inject. `extraContexts` is what actually
      // gets injected this turn — ONLY explicit @mentions (auto-inject was
      // removed). `contextManifest` lists EVERY artifact on the shelf so the
      // agent knows what it can @mention / read — links carry a url and no
      // filePath, so pass both and let the backend pick per type.
      const mentionCtxs = resolveAtMentions(text, owningProject?.contexts ?? []);

      const extraContexts = mentionCtxs.length > 0
        ? mentionCtxs.map(c => ({ name: c.name, filePath: c.filePath, url: c.url, size: c.size, kind: c.kind }))
        : undefined;

      const contextManifest = (owningProject?.contexts ?? []).length > 0
        ? (owningProject!.contexts!).map(c => ({ name: c.name, filePath: c.filePath, url: c.url, kind: c.kind }))
        : undefined;

      let chatId = n.chatId;
      let outgoingText = text;
      const tEnsureStart = perf.now();
      try {
        if (!owningProject) throw new Error('workspace not found for node');
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
          graphPrerequisite: durableNodePrerequisite(owningProject, nodesRef.current[nodeId] ?? n),
        });
        perf.measure('client:ensure_session', tEnsureStart, { nodeId, strategy: ensured.resumeStrategy });
        perf.measure('client:submit_to_ensured', tSubmit, { nodeId });
        // New backends return chatId === nodeId. Ignore a legacy runtime id in
        // the compatibility field; all subsequent frontend operations address
        // the canonical nodeId.
        chatId = nodeId;
        dispatch({
          type: 'bind-chat',
          nodeId,
          currentModeId: ensured.currentModeId,
          runtimeId: ensured.runtimeId,
          providerId: ensured.providerId,
          modelId: ensured.modelId,
          reasoning: ensured.reasoning,
          resumeFingerprint: ensured.resumeFingerprint,
        });
        boundSessionsRef.current.add(nodeId);

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
        prompt: outgoingText,
        nodeId,
        assistantId,
        dispatch,
        assistantTextBufs,
        cancelFns,
        ownerToken: ownerTokenRef.current,
        displayText,
        userMetadata: {
          quotedText: meta?.quotedText,
          attachments: meta?.attachments,
          comments: meta?.comments as Array<Record<string, unknown>> | undefined,
        },
        onTurnEnd: handleTurnEnd,
        extraHandlers: createSharedStreamHandlers(nodeId),
        onStreamComplete: () => streamCompleteHandlerRef.current(nodeId),
      });
      cancelFns.current[nodeId] = cancel;
      if (pendingCancels.current.has(nodeId)) {
        pendingCancels.current.delete(nodeId);
        cancel();
      }
    },
    [createSharedStreamHandlers, dispatch, handleTurnEnd],
  );

  // A spawn frame can be missed after its short replay window. The backend
  // writes this outbox first, so hydration can submit exactly the same first
  // child turn through the normal foreground path. `user-send` flips status
  // synchronously, making StrictMode/effect re-entry harmless; `turn_start`
  // then clears the outbox only after the backend committed the provisional
  // turn rows.
  useEffect(() => {
    if (!hydrated) return;
    for (const node of Object.values(nodesRef.current)) {
      if (
        !node.spawnedByAgent
        || !node.pendingSpawnPrompt
        || !node.chatId
        || node.status !== 'idle'
        || node.messages.length !== 0
        || (node.messageCount ?? 0) !== 0
      ) continue;
      void startStream(node.nodeId, node.pendingSpawnPrompt);
    }
  }, [hydrated, nodes, startStream]);

  const {
    createProject,
    enterChatsWorkspace,
    renameProject,
    setProjectCwd,
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
      const nodeId = await newNodeId();
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
    async (parentNodeId: string, opts?: { anchorMessageId?: string }) => {
      const parent = nodesRef.current[parentNodeId];
      if (!parent) throw new Error('unknown parent node');
      const projectId = parent.projectId;
      const nodeId = await newNodeId();
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
    async (sourceNodeIds: string[]) => {
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
      const nodeId = await newNodeId();
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
  sendMessageRef.current = sendMessage;

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
    const node = nodesRef.current[nodeId];
    const activeTurnId = node?.lastAppliedTurnId ?? node?.lastAppliedBackgroundTurnId;
    if (fn) {
      fn();
    } else if (ownerStateRef.current[nodeId]?.role === 'owner' && node?.chatId) {
      cancelChat(node.chatId, ownerTokenRef.current, activeTurnId).catch(() => {});
    } else if (ownerStateRef.current[nodeId]?.role === 'observer') {
      return;
    } else if (claimInFlightRef.current.has(nodeId) && node?.chatId) {
      // A claim is installed by the server before its response reaches this
      // pane. A self-turn may therefore arrive on the shared feed while the
      // local role is still unresolved; treating Stop as a foreground-only
      // pending cancel would lose it because no startStream callback exists to
      // consume the marker. Send the token now: it is already authoritative if
      // the claim won, and safely rejected if another pane owns the lease.
      cancelChat(node.chatId, ownerTokenRef.current, activeTurnId).catch(() => {});
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

  const resolveUserInputRequest = useCallback((nodeId: string, answers: Array<{ question: string; answer: string }>) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingUserInput) return;
    respondToUserInput(node.chatId, node.pendingUserInput.requestId, answers)
      .catch(() => toast.error('Failed to send user input response'));
    dispatch({ type: 'user-input-resolved', nodeId, answers });
  }, [dispatch]);

  const skipUserInputRequest = useCallback((nodeId: string) => {
    const node = nodesRef.current[nodeId];
    if (!node?.chatId || !node.pendingUserInput) return;
    skipUserInput(node.chatId, node.pendingUserInput.requestId)
      .catch(() => toast.error('Failed to skip user input'));
    dispatch({ type: 'user-input-resolved', nodeId, answers: [] });
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
      const newIds = await allocateNodeIds(cleaned.length);
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
    [dispatch, setFocusedPane, setOpenPanes, startStream],
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

  // ---- Artifact pane ----
  const openArtifactPane = useCallback(
    async (filePath: string): Promise<string> => {
      if (!activeProjectId) throw new Error('No active project');
      if (!filePath || !filePath.trim()) throw new Error('No file path provided');

      // Backend resolves workspace root for all workspace types (user-picked,
      // skip-folder scratch dir, upload root fallback).

      // Check if this file is already open as an artifact pane
      const existing = Object.values(nodesRef.current).find(
        (n) => n.kind === 'artifact' && n.artifact?.filePath === filePath && n.projectId === activeProjectId,
      );
      if (existing) {
        // Just focus the existing pane
        openPane(existing.nodeId);
        return existing.nodeId;
      }

      const nodeId = await newNodeId();
      dispatch({ type: 'create-artifact', nodeId, projectId: activeProjectId, filePath });

      // Add to project's chatIds so the node is tracked
      setProjects((prev) =>
        prev.map((p) =>
          p.id === activeProjectId
            ? { ...p, chatIds: [...p.chatIds, nodeId] }
            : p,
        ),
      );

      // Open it as a pane
      openPane(nodeId);
      return nodeId;
    },
    [activeProjectId, dispatch, newNodeId, nodesRef, openPane, projects, setProjects],
  );

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
    pinProject,
    unpinProject,
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

  const handleStreamComplete = useCallback((nodeId: string) => {
    if (prefsRef.current.notifications !== 'all') return;
    if (focusedPaneRef.current === nodeId) return;
    const node = nodesRef.current[nodeId];
    notify({
      title: node?.title ?? 'Branch complete',
      body: 'Streaming finished',
      onClick: () => {
        window.focus();
        const project = projectsRef.current.find((candidate) => candidate.chatIds.includes(nodeId));
        if (!project) {
          openPane(nodeId);
          return;
        }
        const treeId = findTreeIdForNode(nodeId, project);
        if (!treeId) {
          openPane(nodeId);
          return;
        }
        selectProject(project.id);
        if (treeId !== project.activeTreeId) {
          openPaneInTree(project.id, treeId, nodeId);
          activateTree(treeId, project.id);
        } else {
          openPane(nodeId);
        }
        setFocusedNodeId(nodeId);
        window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'dashboard' } }));
      },
    });
  }, [activateTree, openPane, openPaneInTree, selectProject, setFocusedNodeId]);
  streamCompleteHandlerRef.current = handleStreamComplete;

  const {
    createContext,
    updateContext,
    deleteContext,
    pinContext,
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

  // ── Back/forward navigation ──────────────────────────────────────────────
  // A nav entry is live only if its workspace and node still exist and aren't
  // soft-deleted; back/forward skip dead ones (like a browser skipping a closed
  // tab). Reads refs so the callbacks stay stable across chunk-driven renders.
  const isNavEntryLive = useCallback((entry: NavEntry): boolean => {
    const proj = projectsRef.current.find((p) => p.id === entry.projectId);
    if (!proj || proj.deletedAt) return false;
    if (!proj.chatIds.includes(entry.nodeId)) return false;
    if (nodesRef.current[entry.nodeId]?.deletedAt) return false;
    return true;
  }, []);

  // All cross-boundary movement goes through navigateToNode so back/forward
  // inherit its stale-slot fix (seed the destination pane before switching
  // workspace/tree). navBack/navForward arm the history's suppression window so
  // the focus change they cause isn't re-recorded as a new location.
  const runNavTo = useCallback(
    (entry: NavEntry | null) => {
      if (!entry) return;
      navigateToNode(
        {
          projects: projectsRef.current,
          activeProjectId: activeProjectIdRef.current,
          selectProject,
          openPane,
          openPaneInTree,
          activateTree,
          setFocusedNodeId,
        },
        entry.nodeId,
        entry.projectId,
      );
    },
    [selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId],
  );

  const navBack = useCallback(() => {
    runNavTo(navHistoryBack(isNavEntryLive));
  }, [runNavTo, navHistoryBack, isNavEntryLive]);

  const navForward = useCallback(() => {
    runNavTo(navHistoryForward(isNavEntryLive));
  }, [runNavTo, navHistoryForward, isNavEntryLive]);

  // Observe the focused-location triple (workspace, active tree, focused pane)
  // and record a nav entry whenever it lands somewhere new. Gated on `hydrated`
  // so boot-time workspace churn (seed → hydrated) doesn't seed a bogus entry.
  const activeTreeIdForNav = activeProject?.activeTreeId ?? null;
  useEffect(() => {
    if (!hydrated || !activeProjectId || !activeTreeIdForNav || !focusedPane) return;
    recordNav({ nodeId: focusedPane, projectId: activeProjectId, treeId: activeTreeIdForNav });
  }, [hydrated, activeProjectId, activeTreeIdForNav, focusedPane, recordNav]);

  // Drop nav entries whose node was deleted (reuses the trashed-id signal).
  useEffect(() => {
    if (!deletedIdsKey) return;
    pruneNav(isNavEntryLive);
  }, [deletedIdsKey, pruneNav, isNavEntryLive]);

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
      canNavBack,
      canNavForward,
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
      canNavBack,
      canNavForward,
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
      setProjectCwd,
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
      openArtifactPane,
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
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      pinContext,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
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
      renameNode,
      navBack,
      navForward,
      canNavBack,
      canNavForward,
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
      setProjectCwd,
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
      openArtifactPane,
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
      pinProject,
      unpinProject,
      renameTree,
      deleteTree,
      activateTree,
      moveTreeToWorkspace,
      createContext,
      updateContext,
      deleteContext,
      pinContext,
      resolvePermission,
      denyPermission,
      resolveUserInputRequest,
      skipUserInputRequest,
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
      renameNode,
      navBack,
      navForward,
      canNavBack,
      canNavForward,
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
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
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
      resolveUserInputRequest,
      skipUserInputRequest,
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
      renameNode,
      navBack,
      navForward,
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
      pinTree,
      unpinTree,
      pinProject,
      unpinProject,
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
      resolveUserInputRequest,
      skipUserInputRequest,
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
      renameNode,
      navBack,
      navForward,
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
