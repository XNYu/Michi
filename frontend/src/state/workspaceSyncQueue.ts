export type WorkspaceSyncTask = () => Promise<void>;

interface QueueState {
  inFlight: boolean;
  pending?: WorkspaceSyncTask;
  idleWaiters: Array<() => void>;
}

/**
 * Per-workspace single-flight queue with latest-task coalescing.
 *
 * A workspace may have one active sync and one pending sync. Repeated enqueue
 * calls while the active task is running replace the pending task, because the
 * caller supplies a full snapshot for queued work. Different workspaces retain
 * independent queues and may run concurrently.
 */
export class WorkspaceSyncQueue {
  private readonly states = new Map<string, QueueState>();

  constructor(
    private readonly onTaskError: (error: unknown, workspaceId: string) => void = () => {},
  ) {}

  enqueue(workspaceId: string, task: WorkspaceSyncTask): void {
    const existing = this.states.get(workspaceId);
    if (existing?.inFlight) {
      existing.pending = task;
      return;
    }

    const state = existing ?? { inFlight: false, idleWaiters: [] };
    state.inFlight = true;
    this.states.set(workspaceId, state);
    this.run(workspaceId, state, task);
  }

  isInFlight(workspaceId: string): boolean {
    return this.states.get(workspaceId)?.inFlight === true;
  }

  hasPending(workspaceId: string): boolean {
    return this.states.get(workspaceId)?.pending !== undefined;
  }

  whenIdle(workspaceId: string): Promise<void> {
    const state = this.states.get(workspaceId);
    if (!state?.inFlight) return Promise.resolve();
    return new Promise((resolve) => state.idleWaiters.push(resolve));
  }

  private run(workspaceId: string, state: QueueState, task: WorkspaceSyncTask): void {
    let result: Promise<void>;
    try {
      result = task();
    } catch (error) {
      this.onTaskError(error, workspaceId);
      this.finish(workspaceId, state);
      return;
    }

    void result
      .catch((error) => this.onTaskError(error, workspaceId))
      .finally(() => this.finish(workspaceId, state));
  }

  private finish(workspaceId: string, state: QueueState): void {
    const next = state.pending;
    if (next) {
      state.pending = undefined;
      this.run(workspaceId, state, next);
      return;
    }

    state.inFlight = false;
    this.states.delete(workspaceId);
    for (const resolve of state.idleWaiters.splice(0)) resolve();
  }
}
