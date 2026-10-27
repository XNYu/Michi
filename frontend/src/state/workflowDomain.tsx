import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  isWorkflowRunOpen,
  type BackgroundSubagentsEndedV1,
  type BackgroundSubagentsUpdateV1,
  type WorkflowAction,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { backendConnectionIdForWorkspace } from '../config/backendConnections';
import {
  actOnWorkflowRun,
  answerWorkflowApproval,
  getWorkflowRun,
  listWorkflowRuns,
  subscribeWorkflowRuns,
} from '../services/api/workflowRuns';
import { SseHttpError } from '../services/api/sseParser';
import { agentResourceKey, type AgentResourceIdentity, type LocatedAgentResource } from './agentIdentity';

/**
 * Workflow runs (Claude Code Workflows, Kiro CLI workflows) the backend
 * folds outside the chat turn queue. Every update is a whole snapshot with
 * a revision; the reducer keeps the highest, so live pushes, reconnect
 * snapshots and explicit fetches can arrive in any order.
 *
 * State lives in an external store: components select the runs they show
 * (`useWorkflowPlacementsForNode`, `useWorkflowRun`), so progress on one run does
 * not re-render every open chat pane.
 *
 * The same feed says which background subagents the backend's live agent
 * processes still track (BackgroundSubagentsUpdateV1), kept per feed in
 * `backgroundSubagents`.
 */

export type LocatedWorkflowRun = LocatedAgentResource<WorkflowRunDtoV1>;

/** One feed's live background subagents. */
export interface LiveBackgroundSubagentFeed {
  /** Node id → subagent session ids (nodes without any are absent). */
  nodes: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * When the feed disconnected, while it reconnects: `nodes` is then its
   * last word, which says nothing about agents started since. A failed
   * reconnect keeps the first disconnect's time; the reconnect's snapshot
   * clears it.
   */
  staleSince?: number;
}

/**
 * A disconnected feed's last word on one node. It stands for an agent
 * that started before `staleSince`: a process that had ended by then
 * cannot bring the agent back. One started since is unknown.
 */
export interface StaleBackgroundSubagents {
  readonly ids: ReadonlySet<string>;
  readonly staleSince: number;
}

export interface WorkflowDomainState {
  runs: Record<string, LocatedWorkflowRun>;
  /** Action or approval answer in flight per run key. */
  pending: Record<string, WorkflowAction | 'answer' | undefined>;
  /** Last action error per run key. */
  errors: Record<string, string | undefined>;
  /**
   * Live background subagents per workflow-runs feed (workflowFeedKey). A
   * feed is present from its snapshot until its last subscriber leaves or
   * the backend refuses it (403); while it reconnects it is kept, stale.
   * Backends from before the event never add one.
   */
  backgroundSubagents: Readonly<Record<string, LiveBackgroundSubagentFeed>>;
}

export const initialWorkflowDomainState: WorkflowDomainState = { runs: {}, pending: {}, errors: {}, backgroundSubagents: {} };

export type WorkflowDomainAction =
  | { type: 'upsert'; resources: LocatedWorkflowRun[] }
  | { type: 'pending'; runKey: string; action: WorkflowAction | 'answer' | undefined }
  | { type: 'error'; runKey: string; message: string | undefined }
  | { type: 'backgroundSubagents'; feedKey: string; update: BackgroundSubagentsUpdateV1 }
  /** The feed disconnected at `at` and reconnects: its sets stay, stale (LiveBackgroundSubagentFeed.staleSince). */
  | { type: 'backgroundSubagentsStale'; feedKey: string; at: number }
  /** The feed's liveness is unknown again (its last subscriber left, or the backend refused it). */
  | { type: 'backgroundSubagentsUnknown'; feedKey: string };

export function workflowRunKey(identity: AgentResourceIdentity): string {
  return agentResourceKey(identity);
}

function feedKeyOf(backendConnectionId: string, workspaceId: string): string {
  return `${backendConnectionId}\u0000${workspaceId}`;
}

/** The workflow-runs feed a workspace's runs and liveness arrive on: its backend and the workspace. */
export function workflowFeedKey(workspaceId: string): string {
  return feedKeyOf(backendConnectionIdForWorkspace(workspaceId), workspaceId);
}

/** `ids` as a set; `previous` itself when it holds the same ids. */
function liveSet(previous: ReadonlySet<string> | undefined, ids: readonly string[]): ReadonlySet<string> {
  const next = new Set(ids);
  if (previous && previous.size === next.size && [...next].every((id) => previous.has(id))) return previous;
  return next;
}

function sameNodes(a: LiveBackgroundSubagentFeed['nodes'], b: LiveBackgroundSubagentFeed['nodes']): boolean {
  if (a.size !== b.size) return false;
  for (const [nodeId, ids] of a) if (b.get(nodeId) !== ids) return false;
  return true;
}

function ownFeed(feeds: WorkflowDomainState['backgroundSubagents'], feedKey: string): LiveBackgroundSubagentFeed | undefined {
  return Object.hasOwn(feeds, feedKey) ? feeds[feedKey] : undefined;
}

/**
 * A snapshot replaces the feed (nodes it omits have none) and makes a
 * stale feed current again; a delta sets the nodes it names, an empty list
 * removing one. A delta before the feed's first snapshot is dropped: it
 * cannot say the other nodes have none. A delta to a stale feed updates
 * the nodes it names and leaves the feed stale: only a snapshot speaks for
 * the rest. Unchanged nodes keep their sets and an unchanged feed its
 * object.
 */
function reduceBackgroundSubagents(
  feeds: WorkflowDomainState['backgroundSubagents'],
  feedKey: string,
  update: BackgroundSubagentsUpdateV1,
): WorkflowDomainState['backgroundSubagents'] {
  const current = ownFeed(feeds, feedKey);
  if (update.snapshot) {
    const nodes = new Map<string, ReadonlySet<string>>();
    for (const [nodeId, ids] of Object.entries(update.nodes)) {
      if (ids.length > 0) nodes.set(nodeId, liveSet(current?.nodes.get(nodeId), ids));
    }
    if (current && sameNodes(current.nodes, nodes)) {
      return current.staleSince === undefined ? feeds : { ...feeds, [feedKey]: { nodes: current.nodes } };
    }
    return { ...feeds, [feedKey]: { nodes } };
  }
  if (!current) return feeds;
  let nodes: Map<string, ReadonlySet<string>> | undefined;
  for (const [nodeId, ids] of Object.entries(update.nodes)) {
    const previous = (nodes ?? current.nodes).get(nodeId);
    const value = ids.length > 0 ? liveSet(previous, ids) : undefined;
    if (value === previous) continue;
    nodes ??= new Map(current.nodes);
    if (value) nodes.set(nodeId, value);
    else nodes.delete(nodeId);
  }
  return nodes ? { ...feeds, [feedKey]: { ...current, nodes } } : feeds;
}

export function workflowDomainReducer(state: WorkflowDomainState, action: WorkflowDomainAction): WorkflowDomainState {
  switch (action.type) {
    case 'upsert': {
      let runs = state.runs;
      for (const resource of action.resources) {
        const key = workflowRunKey({ backendConnectionId: resource.backendConnectionId, id: resource.value.id });
        const current = runs[key];
        // A full copy replaces a trimmed snapshot copy of the same revision.
        if (current && current.value.revision > resource.value.revision) continue;
        if (current && current.value.revision === resource.value.revision && !(current.value.partial && !resource.value.partial)) continue;
        if (runs === state.runs) runs = { ...state.runs };
        runs[key] = resource;
      }
      return runs === state.runs ? state : { ...state, runs };
    }
    case 'pending':
      if (state.pending[action.runKey] === action.action) return state;
      return { ...state, pending: { ...state.pending, [action.runKey]: action.action } };
    case 'error':
      if (state.errors[action.runKey] === action.message) return state;
      return { ...state, errors: { ...state.errors, [action.runKey]: action.message } };
    case 'backgroundSubagents': {
      const backgroundSubagents = reduceBackgroundSubagents(state.backgroundSubagents, action.feedKey, action.update);
      return backgroundSubagents === state.backgroundSubagents ? state : { ...state, backgroundSubagents };
    }
    case 'backgroundSubagentsStale': {
      const feed = ownFeed(state.backgroundSubagents, action.feedKey);
      // Unknown stays unknown. Already stale: a failed reconnect knows no
      // more than the first disconnect did, so that time stands.
      if (!feed || feed.staleSince !== undefined) return state;
      // The same map and sets: only the feed object is new.
      const stale: LiveBackgroundSubagentFeed = { nodes: feed.nodes, staleSince: action.at };
      return { ...state, backgroundSubagents: { ...state.backgroundSubagents, [action.feedKey]: stale } };
    }
    case 'backgroundSubagentsUnknown': {
      if (!Object.hasOwn(state.backgroundSubagents, action.feedKey)) return state;
      const { [action.feedKey]: _dropped, ...backgroundSubagents } = state.backgroundSubagents;
      return { ...state, backgroundSubagents };
    }
  }
}

export interface WorkflowDomainApi {
  list: typeof listWorkflowRuns;
  get: typeof getWorkflowRun;
  act: typeof actOnWorkflowRun;
  answer: typeof answerWorkflowApproval;
  subscribe: typeof subscribeWorkflowRuns;
}

const defaultApi: WorkflowDomainApi = {
  list: listWorkflowRuns, get: getWorkflowRun, act: actOnWorkflowRun, answer: answerWorkflowApproval, subscribe: subscribeWorkflowRuns,
};

export interface WorkflowDomainStore {
  getState(): WorkflowDomainState;
  subscribe(listener: () => void): () => void;
}

export interface WorkflowDomainContextValue {
  store: WorkflowDomainStore;
  /** Keep the workspace's runs live (snapshot, then pushes; reconnects). */
  subscribeWorkspace(workspaceId: string): () => void;
  load(identity: AgentResourceIdentity): Promise<void>;
  act(identity: AgentResourceIdentity, action: WorkflowAction): Promise<void>;
  answer(identity: AgentResourceIdentity, approvalId: string, optionId: string): Promise<void>;
}

const WorkflowDomainContext = createContext<WorkflowDomainContextValue | null>(null);

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/**
 * The workspace is not ours: retrying cannot help. A 404 is retried with
 * backoff, because a workspace created in this window answers 404 until its
 * first structural flush reaches the backend; a 401 recovers after sign-in.
 */
const FATAL_STATUSES = new Set([403]);

/** A workspace feed's `background_subagents_ended`, with the workspace it came from. */
export interface EndedBackgroundSubagentsOfWorkspace extends BackgroundSubagentsEndedV1 {
  backendConnectionId: string;
  workspaceId: string;
}

export function WorkflowDomainProvider({ children, api = defaultApi, now = Date.now, onBackgroundSubagentsEnded }: {
  children: React.ReactNode;
  api?: WorkflowDomainApi;
  /** When a feed disconnected (LiveBackgroundSubagentFeed.staleSince). Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Background subagents a workspace's feed says ended without a turn
   * reporting them. Not workflow state: the chat store applies them to the
   * node's rosters (App wires it).
   */
  onBackgroundSubagentsEnded?: (ended: EndedBackgroundSubagentsOfWorkspace) => void;
}) {
  // Read at call time, so feeds keep their subscription when the handler changes.
  const onEndedRef = useRef(onBackgroundSubagentsEnded);
  useEffect(() => { onEndedRef.current = onBackgroundSubagentsEnded; }, [onBackgroundSubagentsEnded]);
  const stateRef = useRef(initialWorkflowDomainState);
  const listeners = useRef(new Set<() => void>());
  const store = useMemo<WorkflowDomainStore>(() => ({
    getState: () => stateRef.current,
    subscribe: (listener) => {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
  }), []);
  const dispatch = useCallback((action: WorkflowDomainAction) => {
    const next = workflowDomainReducer(stateRef.current, action);
    if (next === stateRef.current) return;
    stateRef.current = next;
    for (const listener of listeners.current) listener();
  }, []);
  /** One live subscription per workspace, shared by every caller. */
  const subscriptions = useRef(new Map<string, { refs: number; stop: () => void }>());

  useEffect(() => () => {
    for (const subscription of subscriptions.current.values()) subscription.stop();
    subscriptions.current.clear();
  }, []);

  const subscribeWorkspace = useCallback((workspaceId: string) => {
    const backendConnectionId = backendConnectionIdForWorkspace(workspaceId);
    const key = feedKeyOf(backendConnectionId, workspaceId);
    const existing = subscriptions.current.get(key);
    if (existing) {
      existing.refs += 1;
    } else {
      let stopped = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delay = RETRY_MIN_MS;
      const connect = () => {
        if (stopped) return;
        unsubscribe = api.subscribe(workspaceId, {
          onOpen: () => { delay = RETRY_MIN_MS; },
          onRun: (run) => dispatch({ type: 'upsert', resources: [{ backendConnectionId, value: run }] }),
          onBackgroundSubagents: (update) => {
            if (!stopped) dispatch({ type: 'backgroundSubagents', feedKey: key, update });
          },
          onBackgroundSubagentsEnded: (ended) => {
            if (stopped) return;
            try {
              onEndedRef.current?.({ ...ended, backendConnectionId, workspaceId });
            } catch (error) {
              console.warn('[workflowDomain] applying ended background subagents failed', error);
            }
          },
          onDisconnect: (error) => {
            if (stopped) return;
            if (error instanceof SseHttpError && FATAL_STATUSES.has(error.status)) {
              // Refused, and no reconnect follows: nothing would ever
              // refresh the last word, so it says nothing any more.
              dispatch({ type: 'backgroundSubagentsUnknown', feedKey: key });
              return;
            }
            // Until the reconnect's snapshot, the last word still stands for
            // agents that started before now; the rest are unknown.
            dispatch({ type: 'backgroundSubagentsStale', feedKey: key, at: now() });
            // A restarted or briefly unreachable backend: the snapshot on
            // reconnect brings every run back to its latest revision.
            timer = setTimeout(connect, delay);
            delay = Math.min(delay * 2, RETRY_MAX_MS);
          },
        });
      };
      connect();
      subscriptions.current.set(key, {
        refs: 1,
        stop: () => { stopped = true; if (timer) clearTimeout(timer); unsubscribe?.(); },
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const subscription = subscriptions.current.get(key);
      if (!subscription) return;
      subscription.refs -= 1;
      if (subscription.refs > 0) return;
      subscription.stop();
      subscriptions.current.delete(key);
      // No feed keeps the liveness current any more; a new subscription's
      // snapshot brings it back.
      dispatch({ type: 'backgroundSubagentsUnknown', feedKey: key });
    };
  }, [api, dispatch, now]);

  const load = useCallback(async (identity: AgentResourceIdentity) => {
    const run = await api.get(identity.backendConnectionId, identity.id);
    dispatch({ type: 'upsert', resources: [{ backendConnectionId: identity.backendConnectionId, value: run }] });
  }, [api, dispatch]);

  const run = useCallback(async (identity: AgentResourceIdentity, kind: WorkflowAction | 'answer', call: () => Promise<WorkflowRunDtoV1>) => {
    const runKey = workflowRunKey(identity);
    dispatch({ type: 'pending', runKey, action: kind });
    dispatch({ type: 'error', runKey, message: undefined });
    try {
      const updated = await call();
      dispatch({ type: 'upsert', resources: [{ backendConnectionId: identity.backendConnectionId, value: updated }] });
    } catch (error) {
      dispatch({ type: 'error', runKey, message: error instanceof Error ? error.message : String(error) });
    } finally {
      dispatch({ type: 'pending', runKey, action: undefined });
    }
  }, [dispatch]);

  const act = useCallback((identity: AgentResourceIdentity, action: WorkflowAction) =>
    run(identity, action, () => api.act(identity.backendConnectionId, identity.id, action)), [api, run]);
  const answer = useCallback((identity: AgentResourceIdentity, approvalId: string, optionId: string) =>
    run(identity, 'answer', () => api.answer(identity.backendConnectionId, identity.id, approvalId, optionId)), [api, run]);

  const value = useMemo<WorkflowDomainContextValue>(
    () => ({ store, subscribeWorkspace, load, act, answer }),
    [store, subscribeWorkspace, load, act, answer],
  );
  return <WorkflowDomainContext.Provider value={value}>{children}</WorkflowDomainContext.Provider>;
}

/** The workflow domain, or null outside its provider (provider-free tests). */
export function useOptionalWorkflowDomain(): WorkflowDomainContextValue | null {
  return useContext(WorkflowDomainContext);
}

const EMPTY_STORE: WorkflowDomainStore = { getState: () => initialWorkflowDomainState, subscribe: () => () => {} };

/** Where a run's card goes: everything placement needs, nothing that ticks. */
export interface WorkflowPlacement {
  identity: AgentResourceIdentity;
  parentToolCallId: string | null;
  startedAt: number;
}
const NO_PLACEMENTS: WorkflowPlacement[] = [];

/**
 * Runs one chat node launched, oldest first. Identity-stable until a run is
 * added or relinked, so progress frames do not re-render the message list;
 * each card reads its own live run with `useWorkflowRun`.
 */
export function useWorkflowPlacementsForNode(nodeId: string): WorkflowPlacement[] {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const cache = useRef<{ runs: WorkflowDomainState['runs'] | null; nodeId: string; value: WorkflowPlacement[] }>({ runs: null, nodeId: '', value: NO_PLACEMENTS });
  const select = useCallback(() => {
    const runs = store.getState().runs;
    const cached = cache.current;
    if (cached.runs === runs && cached.nodeId === nodeId) return cached.value;
    const next = Object.values(runs)
      .filter((resource) => resource.value.nodeId === nodeId)
      .sort((a, b) => a.value.startedAt - b.value.startedAt)
      .map((resource): WorkflowPlacement => ({
        identity: { backendConnectionId: resource.backendConnectionId, id: resource.value.id },
        parentToolCallId: resource.value.parentToolCallId,
        startedAt: resource.value.startedAt,
      }));
    const same = cached.nodeId === nodeId && next.length === cached.value.length && next.every((placement, index) => {
      const prev = cached.value[index];
      return prev.identity.id === placement.identity.id
        && prev.identity.backendConnectionId === placement.identity.backendConnectionId
        && prev.parentToolCallId === placement.parentToolCallId
        && prev.startedAt === placement.startedAt;
    });
    const value = same ? cached.value : next.length === 0 ? NO_PLACEMENTS : next;
    cache.current = { runs, nodeId, value };
    return value;
  }, [store, nodeId]);
  return useSyncExternalStore(store.subscribe, select, select);
}

const NO_COUNTS: readonly number[] = [];

/**
 * Running or paused runs per chat node, aligned with `nodeIds`. Identity
 * holds until a count changes, so progress frames do not re-render callers
 * (the pane-title badges).
 */
export function useActiveWorkflowCounts(nodeIds: readonly string[]): readonly number[] {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const cache = useRef<{ runs: WorkflowDomainState['runs'] | null; nodeIds: readonly string[]; value: readonly number[] }>({ runs: null, nodeIds: [], value: NO_COUNTS });
  const select = useCallback(() => {
    const runs = store.getState().runs;
    const cached = cache.current;
    if (cached.runs === runs && cached.nodeIds === nodeIds) return cached.value;
    const counts = new Map<string, number>();
    for (const resource of Object.values(runs)) {
      const nodeId = resource.value.nodeId;
      if (nodeId && isWorkflowRunOpen(resource.value)) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
    const next = nodeIds.map((nodeId) => counts.get(nodeId) ?? 0);
    const same = next.length === cached.value.length && next.every((count, index) => count === cached.value[index]);
    const value = same ? cached.value : next;
    cache.current = { runs, nodeIds, value };
    return value;
  }, [store, nodeIds]);
  return useSyncExternalStore(store.subscribe, select, select);
}

const NO_RUNS: LocatedWorkflowRun[] = [];

/**
 * Runs launched by any of `nodeIds`, oldest first. A new array whenever one
 * of them changes revision; unrelated runs leave it alone.
 */
export function useWorkflowRunsForNodes(nodeIds: readonly string[]): LocatedWorkflowRun[] {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const cache = useRef<{ runs: WorkflowDomainState['runs'] | null; nodeIds: readonly string[]; value: LocatedWorkflowRun[] }>({ runs: null, nodeIds: [], value: NO_RUNS });
  const select = useCallback(() => {
    const runs = store.getState().runs;
    const cached = cache.current;
    if (cached.runs === runs && cached.nodeIds === nodeIds) return cached.value;
    const wanted = new Set(nodeIds);
    const next = Object.values(runs)
      .filter((resource) => resource.value.nodeId !== null && wanted.has(resource.value.nodeId))
      .sort((a, b) => a.value.startedAt - b.value.startedAt);
    const same = next.length === cached.value.length && next.every((resource, index) => resource === cached.value[index]);
    const value = same ? cached.value : next.length === 0 ? NO_RUNS : next;
    cache.current = { runs, nodeIds, value };
    return value;
  }, [store, nodeIds]);
  return useSyncExternalStore(store.subscribe, select, select);
}

/**
 * A run shown in full (workflow pane, Background work drawer): fetches it
 * once, and again whenever the bulk snapshot only had a trimmed copy of its
 * revision. `missing` is set when the fetch fails and nothing is known.
 */
export function useWorkflowRunDetail(runIdentity: AgentResourceIdentity): ReturnType<typeof useWorkflowRun> & { missing: boolean } {
  const { backendConnectionId, id } = runIdentity;
  // Callers may pass a fresh object each render; fetch once per run.
  const identity = useMemo(() => ({ backendConnectionId, id }), [backendConnectionId, id]);
  const workflows = useOptionalWorkflowDomain();
  const live = useWorkflowRun(workflowRunKey(identity));
  const [missing, setMissing] = useState(false);
  const load = workflows?.load;
  useEffect(() => {
    if (!load) return;
    let active = true;
    void load(identity).catch(() => { if (active) setMissing(true); });
    return () => { active = false; };
  }, [load, identity]);
  // A run the bulk snapshot trimmed is fetched whole, once per trimmed
  // revision (the full copy then replaces it in the store).
  const partialRevision = live.resource?.value.partial ? live.resource.value.revision : null;
  const fetchedPartial = useRef<number | null>(null);
  useEffect(() => {
    if (!load || partialRevision === null || fetchedPartial.current === partialRevision) return;
    fetchedPartial.current = partialRevision;
    void load(identity).catch(() => {});
  }, [load, identity, partialRevision]);
  return { ...live, missing };
}

/** One run plus its in-flight action and last error. */
export function useWorkflowRun(runKey: string): { resource?: LocatedWorkflowRun; pending?: WorkflowAction | 'answer'; error?: string } {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const resource = useSyncExternalStore(store.subscribe, () => store.getState().runs[runKey], () => store.getState().runs[runKey]);
  const pending = useSyncExternalStore(store.subscribe, () => store.getState().pending[runKey], () => store.getState().pending[runKey]);
  const error = useSyncExternalStore(store.subscribe, () => store.getState().errors[runKey], () => store.getState().errors[runKey]);
  return { resource, pending, error };
}

/** A known node with no live background subagents. */
const NO_LIVE_SUBAGENTS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** One node's liveness: its current ids, a disconnected feed's last word, or unknown. */
export type NodeBackgroundSubagentLiveness = ReadonlySet<string> | StaleBackgroundSubagents | undefined;

/**
 * Stale views per stale feed object and set: one object per node set while
 * the feed stays as it is, gone with the feed.
 */
const staleViews = new WeakMap<LiveBackgroundSubagentFeed, Map<ReadonlySet<string>, StaleBackgroundSubagents>>();

function staleView(feed: LiveBackgroundSubagentFeed, staleSince: number, ids: ReadonlySet<string>): StaleBackgroundSubagents {
  let views = staleViews.get(feed);
  if (!views) {
    views = new Map();
    staleViews.set(feed, views);
  }
  let view = views.get(ids);
  if (!view) {
    view = Object.freeze({ ids, staleSince });
    views.set(ids, view);
  }
  return view;
}

function liveBackgroundSubagentsIn(
  feeds: WorkflowDomainState['backgroundSubagents'],
  workspaceId: string,
  nodeId: string,
): NodeBackgroundSubagentLiveness {
  const feed = ownFeed(feeds, workflowFeedKey(workspaceId));
  if (!feed) return undefined;
  const ids = feed.nodes.get(nodeId) ?? NO_LIVE_SUBAGENTS;
  return feed.staleSince === undefined ? ids : staleView(feed, feed.staleSince, ids);
}

/**
 * The background subagents of one chat node (in `workspaceId`) that a live
 * agent process still tracks. Undefined while that is unknown: the
 * workspace's feed has sent no snapshot (not subscribed, refused, a
 * backend from before the event). While the feed reconnects, its last word
 * (StaleBackgroundSubagents) until the reconnect's snapshot. Otherwise a
 * set that stays the same object until the node's ids change; an empty set
 * when it has none. A stale view stays the same object too while the feed
 * stays as it is.
 */
export function selectLiveBackgroundSubagents(
  state: WorkflowDomainState,
  workspaceId: string,
  nodeId: string,
): NodeBackgroundSubagentLiveness {
  return liveBackgroundSubagentsIn(state.backgroundSubagents, workspaceId, nodeId);
}

/** selectLiveBackgroundSubagents over the store's current state, for callers that look up many nodes. */
export type BackgroundSubagentLiveness = (workspaceId: string, nodeId: string) => NodeBackgroundSubagentLiveness;

/**
 * Looks chat nodes' live background subagents up. A new function only when
 * some feed's liveness changes, so run progress does not re-render callers;
 * outside the provider every node is unknown.
 */
export function useBackgroundSubagentLiveness(): BackgroundSubagentLiveness {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const select = useCallback(() => store.getState().backgroundSubagents, [store]);
  const feeds = useSyncExternalStore(store.subscribe, select, select);
  return useMemo(() => (workspaceId, nodeId) => liveBackgroundSubagentsIn(feeds, workspaceId, nodeId), [feeds]);
}

/**
 * Whether a chat has a Claude workflow running. Claude ends background
 * workflows when the chat's turn is stopped, so Stop says so.
 */
export function useRunningClaudeWorkflow(nodeId: string): boolean {
  const store = useOptionalWorkflowDomain()?.store ?? EMPTY_STORE;
  const select = useCallback(() => Object.values(store.getState().runs).some((resource) =>
    resource.value.nodeId === nodeId && resource.value.runtime === 'claude'
    && (resource.value.status === 'running' || resource.value.status === 'paused')), [store, nodeId]);
  return useSyncExternalStore(store.subscribe, select, select);
}
