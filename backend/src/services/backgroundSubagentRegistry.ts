import { BACKGROUND_SUBAGENT_LIMITS, SUBAGENT_END_LIMITS, type SubagentEnd } from 'michi-shared';
import { log } from './logger';
import { SqliteWorkflowRunStore } from './workflowRunsRepository';

/**
 * Background subagents that a live agent process in this backend still
 * tracks, per chat node: running after their launch turn ended, or finished
 * and not yet reported by a turn. Runtime sessions report their whole set
 * whenever it changes, and an empty set when their process or session ends.
 *
 * The set is not persisted: a backend that restarts tracks nothing, which
 * is the truth (Michi's agent processes do not survive it; startup records
 * the stored ones as ended, endOrphanedBackgroundSubagents). The renderer
 * reads a persisted background entry without an outcome that is missing
 * here as interrupted (shared untrackedSubagent).
 *
 * Several sessions can report for one node (an old one disposing while its
 * replacement starts), so each report is per source and a node's set is
 * their union. A removal reaches subscribers after REMOVAL_GRACE_MS: an
 * agent's outcome travels on the chat stream, and the renderer must not
 * read it as interrupted in the moment between the two feeds.
 *
 * A session whose process ends while it still tracks some calls `end`
 * with how each ended (stopped, or the outcome it finished with while
 * idle): no turn will report them. The registry withdraws them, has the
 * end recorder store the ends on the node's rosters (the backend wires
 * the database one; without it nothing is stored), then tells `ended`
 * subscribers, so open renderers apply the same ends.
 *
 * A renderer that was not subscribed then (another workspace was open, or
 * its feed was reconnecting) still holds the copies waiting for an
 * outcome, and would read them as interrupted. So the registry keeps the
 * latest ends it published (bounded by RECENT_END_LIMITS, in memory) and
 * a new subscription replays its workspace's (recentEnds). Applying an end
 * twice changes nothing (shared endBackgroundSubagents), so a replay of
 * ends a renderer already has is harmless.
 */

export interface BackgroundSubagentContext {
  ownerUserId: string;
  /** Null when the session has not learned its workspace; the node's is used. */
  workspaceId: string | null;
  nodeId: string;
}

/** `nodes`: node id → the node's ids now (empty: none). */
export type BackgroundSubagentListener = (ownerUserId: string, workspaceId: string, nodes: Record<string, string[]>) => void;

export const REMOVAL_GRACE_MS = 2_000;

/** Ends of one node's background subagents that no turn will report, already stored. */
export interface EndedBackgroundSubagents {
  ownerUserId: string;
  workspaceId: string;
  nodeId: string;
  ends: SubagentEnd[];
}

export type BackgroundSubagentEndedListener = (update: EndedBackgroundSubagents) => void;

/**
 * Bounds of the ends kept for replay, in serialized bytes: per workspace
 * (one subscription's replay is written at once, so it stays well under the
 * feed's 1 MiB buffer bound) and in total. The oldest go first.
 */
export const RECENT_END_LIMITS = { workspaceBytes: 192_000, totalBytes: 2_000_000 } as const;

/** One node's replayed ends; at most SUBAGENT_END_LIMITS.ends, as the wire allows. */
export interface RecentNodeEnds {
  nodeId: string;
  ends: SubagentEnd[];
}

interface RecentEnd {
  ownerUserId: string;
  workspaceId: string;
  nodeId: string;
  end: SubagentEnd;
  bytes: number;
}

/**
 * Store ends on the node's rosters. Returns the node's workspace, or null
 * when the node is gone or not the owner's (then nothing is published).
 */
export type BackgroundSubagentEndRecorder = (ownerUserId: string, nodeId: string, ends: readonly SubagentEnd[]) => { workspaceId: string } | null;

interface NodeEntry {
  ownerUserId: string;
  workspaceId: string;
  nodeId: string;
  bySource: Map<string, Set<string>>;
  /** Ids no source reports any more, still shown until their timer fires. */
  leaving: Map<string, ReturnType<typeof setTimeout>>;
  /** What subscribers were last told. */
  shown: string[];
}

export interface BackgroundSubagentRegistryOptions {
  resolveWorkspace?: (nodeId: string) => string | null;
  graceMs?: number;
  recordEnds?: BackgroundSubagentEndRecorder;
}

export class BackgroundSubagentRegistry {
  private readonly nodes = new Map<string, NodeEntry>();
  private readonly listeners = new Set<BackgroundSubagentListener>();
  private readonly endedListeners = new Set<BackgroundSubagentEndedListener>();
  private readonly untracked = new Set<string>();
  /** Published ends by owner, node and agent; insertion order is age (a newer end moves to the back). */
  private readonly recent = new Map<string, RecentEnd>();
  private readonly recentWorkspaceBytes = new Map<string, number>();
  private recentBytes = 0;
  private readonly resolveWorkspace: (nodeId: string) => string | null;
  private readonly graceMs: number;
  private recordEnds: BackgroundSubagentEndRecorder | null;

  constructor(options: BackgroundSubagentRegistryOptions = {}) {
    this.resolveWorkspace = options.resolveWorkspace ?? defaultResolveWorkspace();
    this.graceMs = options.graceMs ?? REMOVAL_GRACE_MS;
    this.recordEnds = options.recordEnds ?? null;
  }

  /** Where `end` stores ends (the backend wires the database at startup); null stores nothing. */
  setEndRecorder(recorder: BackgroundSubagentEndRecorder | null): void {
    this.recordEnds = recorder;
  }

  /** `source`'s background subagents for the node now; an empty list withdraws them. */
  report(context: BackgroundSubagentContext, source: string, sessionIds: readonly string[]): void {
    const key = nodeKey(context.ownerUserId, context.nodeId);
    let entry = this.nodes.get(key);
    const ids = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= BACKGROUND_SUBAGENT_LIMITS.idLength));
    if (!entry) {
      if (ids.size === 0) return;
      const workspaceId = context.workspaceId ?? this.safeResolve(context.nodeId);
      if (!workspaceId) {
        if (!this.untracked.has(key)) {
          this.untracked.add(key);
          log.warn('chat', 'background subagents have no workspace; not tracked', { nodeId: context.nodeId });
        }
        return;
      }
      entry = { ownerUserId: context.ownerUserId, workspaceId, nodeId: context.nodeId, bySource: new Map(), leaving: new Map(), shown: [] };
      this.nodes.set(key, entry);
    }
    if (ids.size > 0) entry.bySource.set(source, ids);
    else entry.bySource.delete(source);
    const current = this.union(entry);
    for (const id of current) {
      const timer = entry.leaving.get(id);
      if (timer) { clearTimeout(timer); entry.leaving.delete(id); }
    }
    for (const id of entry.shown) {
      if (current.has(id) || entry.leaving.has(id)) continue;
      const timer = setTimeout(() => {
        if (entry.leaving.get(id) !== timer) return;
        entry.leaving.delete(id);
        this.publish(key, entry);
      }, this.graceMs);
      timer.unref?.();
      entry.leaving.set(id, timer);
    }
    this.publish(key, entry);
  }

  /**
   * `source`'s process ended with these background subagents still
   * tracked: withdraws all of the source's, stores `ends` and tells
   * `ended` subscribers. Ends with an invalid id are dropped.
   */
  end(context: BackgroundSubagentContext, source: string, ends: readonly SubagentEnd[]): void {
    // The workspace the node was tracked under; the withdrawal may forget it.
    const tracked = this.nodes.get(nodeKey(context.ownerUserId, context.nodeId))?.workspaceId;
    this.report(context, source, []);
    const seen = new Set<string>();
    const valid = ends.filter((end) => {
      const ok = typeof end?.sessionId === 'string' && end.sessionId.length > 0
        && end.sessionId.length <= SUBAGENT_END_LIMITS.idLength && !seen.has(end.sessionId);
      if (ok) seen.add(end.sessionId);
      return ok;
    }).slice(0, SUBAGENT_END_LIMITS.ends);
    if (valid.length === 0) return;
    let workspaceId: string | null = null;
    if (this.recordEnds) {
      try {
        const recorded = this.recordEnds(context.ownerUserId, context.nodeId, valid);
        if (!recorded) return;
        workspaceId = recorded.workspaceId;
      } catch (error) {
        log.warn('chat', 'background subagent ends were not stored', {
          nodeId: context.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Without the recorder's answer, no lookup: the database is the recorder's.
    workspaceId ??= tracked ?? context.workspaceId;
    if (!workspaceId) return;
    const update: EndedBackgroundSubagents = { ownerUserId: context.ownerUserId, workspaceId, nodeId: context.nodeId, ends: valid };
    this.remember(update);
    for (const listener of this.endedListeners) {
      try { listener({ ...update, ends: [...update.ends] }); } catch (error) {
        log.warn('chat', 'background subagent ended listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  subscribeEnded(listener: BackgroundSubagentEndedListener): () => void {
    this.endedListeners.add(listener);
    return () => { this.endedListeners.delete(listener); };
  }

  /**
   * The ends this registry published for one workspace and still keeps,
   * grouped by node (oldest node first), for a new subscription to replay.
   */
  recentEnds(ownerUserId: string, workspaceId: string): RecentNodeEnds[] {
    const byNode = new Map<string, SubagentEnd[]>();
    for (const item of this.recent.values()) {
      if (item.ownerUserId !== ownerUserId || item.workspaceId !== workspaceId) continue;
      let ends = byNode.get(item.nodeId);
      if (!ends) { ends = []; byNode.set(item.nodeId, ends); }
      ends.push({ ...item.end });
    }
    const out: RecentNodeEnds[] = [];
    for (const [nodeId, ends] of byNode) {
      for (let i = 0; i < ends.length; i += SUBAGENT_END_LIMITS.ends) out.push({ nodeId, ends: ends.slice(i, i + SUBAGENT_END_LIMITS.ends) });
    }
    return out;
  }

  private remember(update: EndedBackgroundSubagents): void {
    const workspace = workspaceKey(update.ownerUserId, update.workspaceId);
    for (const end of update.ends) {
      const key = `${nodeKey(update.ownerUserId, update.nodeId)}\u0000${end.sessionId}`;
      this.forget(key);
      const bytes = Buffer.byteLength(JSON.stringify(end)) + Buffer.byteLength(update.nodeId);
      this.recent.set(key, { ownerUserId: update.ownerUserId, workspaceId: update.workspaceId, nodeId: update.nodeId, end: { ...end }, bytes });
      this.recentBytes += bytes;
      this.recentWorkspaceBytes.set(workspace, (this.recentWorkspaceBytes.get(workspace) ?? 0) + bytes);
    }
    // Oldest first: of this workspace past its bound, then of all past the total.
    for (const [key, item] of this.recent) {
      if ((this.recentWorkspaceBytes.get(workspace) ?? 0) <= RECENT_END_LIMITS.workspaceBytes) break;
      if (workspaceKey(item.ownerUserId, item.workspaceId) === workspace) this.forget(key);
    }
    for (const key of this.recent.keys()) {
      if (this.recentBytes <= RECENT_END_LIMITS.totalBytes) break;
      this.forget(key);
    }
  }

  private forget(key: string): void {
    const item = this.recent.get(key);
    if (!item) return;
    this.recent.delete(key);
    this.recentBytes -= item.bytes;
    const workspace = workspaceKey(item.ownerUserId, item.workspaceId);
    const left = (this.recentWorkspaceBytes.get(workspace) ?? 0) - item.bytes;
    if (left > 0) this.recentWorkspaceBytes.set(workspace, left);
    else this.recentWorkspaceBytes.delete(workspace);
  }

  /** Background subagents of one workspace's nodes (nodes without any are absent). */
  snapshot(ownerUserId: string, workspaceId: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    let count = 0;
    for (const entry of this.nodes.values()) {
      if (entry.ownerUserId !== ownerUserId || entry.workspaceId !== workspaceId || entry.shown.length === 0) continue;
      if (count >= BACKGROUND_SUBAGENT_LIMITS.nodes) break;
      out[entry.nodeId] = [...entry.shown];
      count += 1;
    }
    return out;
  }

  subscribe(listener: BackgroundSubagentListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private union(entry: NodeEntry): Set<string> {
    const ids = new Set<string>();
    for (const set of entry.bySource.values()) for (const id of set) ids.add(id);
    return ids;
  }

  private publish(key: string, entry: NodeEntry): void {
    const visible = new Set([...this.union(entry), ...entry.leaving.keys()]);
    // Ids already shown keep their place; the set, not the order, is the news.
    const shown = [...entry.shown.filter((id) => visible.has(id)), ...[...visible].filter((id) => !entry.shown.includes(id))]
      .slice(0, BACKGROUND_SUBAGENT_LIMITS.idsPerNode);
    const previous = new Set(entry.shown);
    const changed = shown.length !== previous.size || shown.some((id) => !previous.has(id));
    entry.shown = shown;
    if (shown.length === 0 && entry.bySource.size === 0 && entry.leaving.size === 0 && this.nodes.get(key) === entry) {
      this.nodes.delete(key);
    }
    if (!changed) return;
    for (const listener of this.listeners) {
      try { listener(entry.ownerUserId, entry.workspaceId, { [entry.nodeId]: [...shown] }); } catch (error) {
        log.warn('chat', 'background subagent listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private safeResolve(nodeId: string): string | null {
    try { return this.resolveWorkspace(nodeId); } catch (error) {
      log.warn('chat', 'background subagent workspace lookup failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

function nodeKey(ownerUserId: string, nodeId: string): string {
  return `${ownerUserId}\u0000${nodeId}`;
}

function workspaceKey(ownerUserId: string, workspaceId: string): string {
  return `${ownerUserId}\u0000${workspaceId}`;
}

function defaultResolveWorkspace(): (nodeId: string) => string | null {
  let store: SqliteWorkflowRunStore | null = null;
  return (nodeId) => (store ??= new SqliteWorkflowRunStore()).workspaceOfNode(nodeId);
}

/** Process-wide registry, shared by runtime sessions and the workflow-runs feed. */
export const backgroundSubagentRegistry = new BackgroundSubagentRegistry();
