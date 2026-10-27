import { createHash } from 'node:crypto';
import {
  boundWorkflowRun,
  isWorkflowRunOpen,
  isWorkflowRunTerminal,
  WORKFLOW_LIMITS,
  type WorkflowAction,
  type WorkflowApprovalDto,
  type WorkflowRunDtoV1,
  type WorkflowRunStatus,
  type WorkflowRuntime,
} from 'michi-shared';
import { log } from './logger';
import { SqliteWorkflowRunStore, type WorkflowRunStore } from './workflowRunsRepository';

/**
 * Live workflow runs. Runtime adapters fold their native events through
 * `update`; the hub stamps revision/time and allowed actions, persists the
 * snapshot (coalesced while running) and notifies subscribers. Controls and
 * pending approvals are registered by the adapter that drives the run and
 * live only as long as it.
 *
 * Revisions are time-based (`max(prev + 1, now * 1000)`) so a snapshot
 * written after a backend restart always outranks one a renderer kept from
 * before it, even when coalescing lost the last few live revisions.
 */

export interface WorkflowRunContext {
  ownerUserId: string;
  /** Null when the session has not learned its workspace; the node's is used. */
  workspaceId: string | null;
  nodeId: string | null;
}

export type WorkflowControl = () => Promise<void>;
export type WorkflowControls = Partial<Record<WorkflowAction, WorkflowControl>>;
export type WorkflowRunListener = (ownerUserId: string, run: WorkflowRunDtoV1) => void;
/**
 * Called once per approval: the chosen option, or null when it lapsed.
 * `endedAs` is the run's terminal status when the run ending lapsed it.
 */
export type WorkflowApprovalResolver = (optionId: string | null, endedAs?: WorkflowRunStatus) => void;

const ALLOWED: Record<WorkflowRunStatus, readonly WorkflowAction[]> = {
  running: ['pause', 'stop'],
  paused: ['resume', 'stop'],
  completed: [],
  failed: ['retry'],
  cancelled: ['retry'],
};
const PERSIST_DELAY_MS = 750;
/** Finished runs leave memory this long after their last change. */
const EVICT_AFTER_MS = 60_000;

export class WorkflowActionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function workflowRunId(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string): string {
  return `wfr_${createHash('sha256').update(`${ownerUserId}\u0000${runtime}\u0000${nativeId}`).digest('hex').slice(0, 24)}`;
}

interface Live {
  ownerUserId: string;
  run: WorkflowRunDtoV1;
  controls: WorkflowControls;
  approvals: Map<string, WorkflowApprovalResolver>;
  /** A row exists for this run (written once, or loaded from the store). */
  persisted: boolean;
  persistTimer?: ReturnType<typeof setTimeout>;
  evictTimer?: ReturnType<typeof setTimeout>;
}

export class WorkflowRunHub {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<WorkflowRunListener>();
  private readonly untracked = new Set<string>();
  private recovered = false;

  constructor(
    private readonly store: WorkflowRunStore = new SqliteWorkflowRunStore(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Create or update the run for `runtime`/`nativeId`. `mutate` receives the
   * current snapshot (a fresh one on first sight) and returns the next; the
   * same object means "no change".
   */
  update(
    context: WorkflowRunContext,
    runtime: WorkflowRuntime,
    nativeId: string,
    mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1,
  ): WorkflowRunDtoV1 | null {
    this.recover();
    const id = workflowRunId(context.ownerUserId, runtime, nativeId);
    let entry = this.live.get(id);
    if (!entry) {
      const stored = this.safe(() => this.store.get(context.ownerUserId, id), null);
      const workspaceId = stored?.workspaceId ?? context.workspaceId
        ?? (context.nodeId ? this.safe(() => this.store.workspaceOfNode(context.nodeId!), null) : null);
      if (!workspaceId) {
        if (!this.untracked.has(id)) {
          this.untracked.add(id);
          log.warn('chat', 'workflow run has no workspace; not tracked', { runtime, nativeId });
        }
        return null;
      }
      const at = this.now();
      entry = {
        ownerUserId: context.ownerUserId,
        controls: {},
        approvals: new Map(),
        persisted: !!stored,
        run: stored ? { ...stored, actions: [], approvals: undefined } : {
          version: 1, id, runtime, nativeId, workspaceId, nodeId: context.nodeId, parentToolCallId: null,
          name: 'Workflow', status: 'running', nodes: [], log: [], actions: [], startedAt: at, updatedAt: at, revision: 0,
        },
      };
      this.live.set(id, entry);
    }
    const next = mutate(entry.run);
    if (next === entry.run && entry.run.revision > 0) {
      // A late frame for a stored, finished run: let it leave memory again.
      if (!entry.evictTimer) this.scheduleEvict(entry);
      return entry.run;
    }
    this.commit(entry, next);
    return entry.run;
  }

  /** Update a run already live in this process, by native id. */
  updateKnown(runtime: WorkflowRuntime, nativeId: string, mutate: (run: WorkflowRunDtoV1) => WorkflowRunDtoV1): WorkflowRunDtoV1 | null {
    for (const entry of this.live.values()) {
      if (entry.run.runtime !== runtime || entry.run.nativeId !== nativeId) continue;
      const next = mutate(entry.run);
      if (next !== entry.run) this.commit(entry, next);
      return entry.run;
    }
    return null;
  }

  /** Controls the driving adapter accepts; replaces earlier ones. */
  registerControls(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, controls: WorkflowControls): void {
    const entry = this.live.get(workflowRunId(ownerUserId, runtime, nativeId));
    if (!entry) return;
    entry.controls = controls;
    this.commit(entry, entry.run);
  }

  /**
   * A step waits on a tool approval. Returns false (and resolves nothing)
   * when the run is not live or not open, so the caller can fall back.
   */
  requestApproval(
    ownerUserId: string,
    runtime: WorkflowRuntime,
    nativeId: string,
    approval: Omit<WorkflowApprovalDto, 'requestedAt'>,
    resolve: WorkflowApprovalResolver,
  ): boolean {
    const entry = this.live.get(workflowRunId(ownerUserId, runtime, nativeId));
    if (!entry || isWorkflowRunTerminal(entry.run.status)) return false;
    const pending = entry.run.approvals ?? [];
    if (pending.length >= WORKFLOW_LIMITS.approvals || pending.some((item) => item.id === approval.id)) return false;
    entry.approvals.set(approval.id, resolve);
    this.commit(entry, { ...entry.run, approvals: [...pending, { ...approval, requestedAt: this.now() }] });
    return true;
  }

  async answerApproval(ownerUserId: string, id: string, approvalId: string, optionId: string): Promise<WorkflowRunDtoV1> {
    const entry = this.live.get(id);
    if (!entry || entry.ownerUserId !== ownerUserId) throw new WorkflowActionError('not_found', 404);
    const approval = entry.run.approvals?.find((item) => item.id === approvalId);
    const resolve = entry.approvals.get(approvalId);
    if (!approval || !resolve) throw new WorkflowActionError('This approval is no longer pending', 409);
    if (!approval.options.some((option) => option.optionId === optionId)) throw new WorkflowActionError('Unknown option', 400);
    this.dropApproval(entry, approvalId);
    resolve(optionId);
    return entry.run;
  }

  /** The adapter withdrew an approval (answered elsewhere, timed out). */
  withdrawApproval(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, approvalId: string): void {
    const entry = this.live.get(workflowRunId(ownerUserId, runtime, nativeId));
    if (entry) this.dropApproval(entry, approvalId);
  }

  /** The driving runtime went away (process exit, session disposed). */
  releaseControls(ownerUserId: string, runtime: WorkflowRuntime, nativeId: string, reason?: string): void {
    const entry = this.live.get(workflowRunId(ownerUserId, runtime, nativeId));
    if (!entry) return;
    entry.controls = {};
    const run = isWorkflowRunTerminal(entry.run.status) || !reason
      ? entry.run
      : { ...entry.run, status: 'cancelled' as const, statusDetail: reason, endedAt: entry.run.endedAt ?? this.now(),
          nodes: entry.run.nodes.map((node) => node.status === 'running' ? { ...node, status: 'cancelled' as const, currentTool: undefined } : node) };
    this.commit(entry, run);
  }

  get(ownerUserId: string, id: string): WorkflowRunDtoV1 | null {
    this.recover();
    const entry = this.live.get(id);
    if (entry) return entry.ownerUserId === ownerUserId ? entry.run : null;
    const stored = this.safe(() => this.store.get(ownerUserId, id), null);
    // Nothing in this process drives a stored run: it accepts no actions.
    return stored ? { ...stored, actions: [], approvals: undefined } : null;
  }

  list(ownerUserId: string, workspaceId: string, limit = 50): WorkflowRunDtoV1[] {
    this.recover();
    const byId = new Map<string, WorkflowRunDtoV1>();
    for (const run of this.safe(() => this.store.list(ownerUserId, workspaceId, limit), [])) {
      byId.set(run.id, { ...run, actions: [], approvals: undefined });
    }
    for (const entry of this.live.values()) {
      if (entry.ownerUserId === ownerUserId && entry.run.workspaceId === workspaceId) byId.set(entry.run.id, entry.run);
    }
    // Open runs first: one waiting on an approval may be old by update time.
    const open = (run: WorkflowRunDtoV1) => Number(isWorkflowRunOpen(run));
    return [...byId.values()].sort((a, b) => open(b) - open(a) || b.updatedAt - a.updatedAt).slice(0, limit);
  }

  workspaceOwnedBy(ownerUserId: string, workspaceId: string): boolean {
    return this.safe(() => this.store.workspaceOwnedBy(ownerUserId, workspaceId), false);
  }

  async act(ownerUserId: string, id: string, action: WorkflowAction): Promise<WorkflowRunDtoV1> {
    const entry = this.live.get(id);
    if (!entry || entry.ownerUserId !== ownerUserId) {
      if (this.get(ownerUserId, id)) throw new WorkflowActionError('This workflow is no longer connected to a running agent', 409);
      throw new WorkflowActionError('not_found', 404);
    }
    const control = entry.run.actions.includes(action) ? entry.controls[action] : undefined;
    if (!control) throw new WorkflowActionError(`Cannot ${action} this workflow now`, 409);
    await control();
    return entry.run;
  }

  subscribe(listener: WorkflowRunListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Write pending snapshots now (shutdown, tests). */
  flush(): void {
    for (const entry of this.live.values()) {
      if (!entry.persistTimer) continue;
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
      this.persist(entry);
    }
  }

  /**
   * Runs an earlier process still drove lost their runtime with it
   * (Michi's agent processes do not survive a restart): open runs are
   * closed, and finished runs that still offered actions or approvals are
   * rewritten without them. The new revision outranks any copy a renderer
   * kept across the restart. Idempotent; call at startup, and every read
   * path calls it too.
   */
  recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    for (const { ownerUserId, run } of this.safe(() => this.store.listOpen(), [])) {
      if (this.live.has(run.id)) continue;
      const at = this.now();
      const settled: WorkflowRunDtoV1 = isWorkflowRunTerminal(run.status)
        ? { ...run, actions: [], approvals: undefined, updatedAt: at, revision: this.nextRevision(run.revision, at) }
        : {
            ...run,
            status: 'cancelled',
            statusDetail: run.runtime === 'kiro'
              ? 'Interrupted: Michi restarted while this workflow was running. Kiro may resume it in a new session.'
              : 'Interrupted: Michi restarted while this workflow was running',
            endedAt: run.endedAt ?? at,
            actions: [],
            approvals: undefined,
            nodes: run.nodes.map((node) => node.status === 'running' ? { ...node, status: 'cancelled', currentTool: undefined } : node),
            updatedAt: at,
            revision: this.nextRevision(run.revision, at),
          };
      this.safe(() => this.store.upsert(ownerUserId, settled), undefined);
    }
  }

  private nextRevision(previous: number, at: number): number {
    return Math.max(previous + 1, at * 1000);
  }

  private dropApproval(entry: Live, approvalId: string): void {
    if (!entry.approvals.delete(approvalId)) return;
    const approvals = (entry.run.approvals ?? []).filter((item) => item.id !== approvalId);
    this.commit(entry, { ...entry.run, approvals: approvals.length > 0 ? approvals : undefined });
  }

  private commit(entry: Live, next: WorkflowRunDtoV1): void {
    const at = this.now();
    let run = next;
    let lapsed: WorkflowApprovalResolver[] = [];
    if (isWorkflowRunTerminal(run.status) && entry.approvals.size > 0) {
      // A finished run asks nothing any more; lapse what it was waiting on.
      lapsed = [...entry.approvals.values()];
      entry.approvals.clear();
      run = { ...run, approvals: undefined };
    }
    const actions = ALLOWED[run.status].filter((action) => !!entry.controls[action]);
    entry.run = boundWorkflowRun({ ...run, actions, updatedAt: at, revision: this.nextRevision(entry.run.revision, at) });
    this.schedulePersist(entry);
    this.scheduleEvict(entry);
    for (const listener of this.listeners) {
      try { listener(entry.ownerUserId, entry.run); } catch (error) {
        log.warn('chat', 'workflow listener failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // Only now that the run is terminal: a resolver that asks again
    // elsewhere must not be able to re-host the request on this run.
    for (const resolve of lapsed) resolve(null, entry.run.status);
  }

  private schedulePersist(entry: Live): void {
    if (isWorkflowRunTerminal(entry.run.status) || !entry.persisted) {
      if (entry.persistTimer) clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
      this.persist(entry);
      return;
    }
    if (entry.persistTimer) return;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = undefined;
      this.persist(entry);
    }, PERSIST_DELAY_MS);
    entry.persistTimer.unref?.();
  }

  /** Finished, persisted runs with nothing left to drive leave memory. */
  private scheduleEvict(entry: Live): void {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = undefined;
    if (!isWorkflowRunTerminal(entry.run.status) || entry.approvals.size > 0) return;
    entry.evictTimer = setTimeout(() => {
      entry.evictTimer = undefined;
      if (entry.persistTimer || entry.approvals.size > 0 || !isWorkflowRunTerminal(entry.run.status)) return;
      if (Object.keys(entry.controls).length > 0) return;
      if (this.live.get(entry.run.id) === entry) this.live.delete(entry.run.id);
    }, EVICT_AFTER_MS);
    entry.evictTimer.unref?.();
  }

  private persist(entry: Live): void {
    this.safe(() => { this.store.upsert(entry.ownerUserId, entry.run); entry.persisted = true; }, undefined);
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch (error) {
      log.warn('chat', 'workflow run store unavailable', { error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  }
}

/** Process-wide hub, shared by runtime adapters and routes. */
export const workflowRunHub = new WorkflowRunHub();
