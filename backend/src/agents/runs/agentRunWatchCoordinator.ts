import type { AgentRunDtoV1, AgentRunWatchDtoV1, WatchConditionV1 } from 'michi-shared';
import { isTerminalRunStatus } from './agentRunStateMachine';
import { compactResultHandoff } from './resultBundle';
import type {
  AgentRunClock,
  AgentRunNotifier,
  AgentRunRepositoryPort,
  ParentContinuationSink,
} from './ports';
import { systemAgentRunClock } from './ports';

export function watchConditionSatisfied(condition: WatchConditionV1,
  runs: readonly AgentRunDtoV1[], now: number, manual = false): boolean {
  const terminalCount = runs.filter((run) => isTerminalRunStatus(run.status)).length;
  switch (condition.kind) {
    case 'all': return runs.length > 0 && terminalCount === runs.length;
    case 'any': return terminalCount > 0;
    case 'quorum': return terminalCount >= condition.count;
    case 'deadline': return now >= condition.at;
    case 'manual': return manual;
  }
}

export class AgentRunWatchCoordinator {
  private readonly clock: AgentRunClock;

  constructor(
    private readonly repository: AgentRunRepositoryPort,
    private readonly notifier: AgentRunNotifier,
    private readonly parentSink: ParentContinuationSink,
    clock: AgentRunClock = systemAgentRunClock,
  ) { this.clock = clock; }

  create(ownerUserId: string, workspaceId: string, runIds: readonly string[], condition: WatchConditionV1,
    completionMode: 'notify' | 'wake', parent: {
      parentRunId: string | null; parentNodeId: string | null; parentTurnId: string | null;
    }, operationId: string): AgentRunWatchDtoV1 {
    return this.repository.createWatch(ownerUserId, workspaceId, runIds, condition, completionMode, parent, operationId);
  }

  addRuns(ownerUserId: string, watchId: string, runIds: readonly string[]): number {
    return this.repository.addWatchMembers(ownerUserId, watchId, runIds);
  }

  async evaluate(ownerUserId: string, watchId: string, manual = false): Promise<boolean> {
    const watch = this.repository.getWatch(ownerUserId, watchId);
    if (!watch || watch.status !== 'active') return false;
    // Watch membership can become empty after historical Run deletion. Such a
    // record remains queryable but can never fire, including for deadline or
    // manual conditions.
    if (watch.runIds.length === 0) return false;
    const runs = watch.runIds.map((runId) => this.repository.getRun(ownerUserId, runId))
      .filter((run): run is AgentRunDtoV1 => !!run);
    const failedMember = runs.some((run) => run.status === 'failed' || run.status === 'cancelled');
    const failureShortCircuits = (watch.condition.kind === 'all' || watch.condition.kind === 'quorum') && failedMember;
    if (runs.length !== watch.runIds.length
      || (!failureShortCircuits && !watchConditionSatisfied(watch.condition, runs, this.clock.now(), manual))) {
      return false;
    }
    // Atomic active -> fired is the exactly-once claim. Delivery sinks must
    // additionally dedupe by deliveryId for crash-after-delivery recovery.
    if (!this.repository.fireWatch(ownerUserId, watchId)) return false;
    if (watch.completionMode === 'notify') {
      await Promise.all(runs.map((run) => this.notifier.notify(ownerUserId, run)));
      this.repository.markWatchDelivery(ownerUserId, watchId, 'delivered');
      return true;
    }
    const handoff = runs.map((run) => run.resultBundle ? compactResultHandoff(run.resultBundle) : `${run.id}: ${run.status}`)
      .join('\n\n');
    const result = await this.parentSink.deliver({
      deliveryId: watch.deliveryId,
      requestedTurnId: watch.requestedTurnId,
      ownerUserId,
      workspaceId: watch.workspaceId,
      parentRunId: watch.parentRunId,
      parentNodeId: watch.parentNodeId,
      parentTurnId: watch.parentTurnId,
      runIds: [...watch.runIds],
      handoff,
    });
    this.repository.markWatchDelivery(ownerUserId, watchId, result);
    return true;
  }

  /** Retry a fired delivery after restart. The sink's durable deliveryId makes
   * this idempotent even if the prior process crashed after delivering. */
  async redeliverFired(ownerUserId: string, watchId: string): Promise<boolean> {
    const watch = this.repository.getWatch(ownerUserId, watchId);
    if (!watch || watch.status !== 'fired') return false;
    const runs = watch.runIds.map((id) => this.repository.getRun(ownerUserId, id)).filter((run): run is AgentRunDtoV1 => !!run);
    if (watch.completionMode === 'notify') {
      await Promise.all(runs.map((run) => this.notifier.notify(ownerUserId, run)));
      this.repository.markWatchDelivery(ownerUserId, watchId, 'delivered');
      return true;
    }
    const result = await this.parentSink.deliver({
      deliveryId: watch.deliveryId, requestedTurnId: watch.requestedTurnId,
      ownerUserId, workspaceId: watch.workspaceId, parentRunId: watch.parentRunId,
      parentNodeId: watch.parentNodeId, parentTurnId: watch.parentTurnId,
      runIds: [...watch.runIds], handoff: runs.map((run) => run.resultBundle ? compactResultHandoff(run.resultBundle) : `${run.id}: ${run.status}`).join('\n\n'),
    });
    this.repository.markWatchDelivery(ownerUserId, watchId, result);
    return true;
  }

  /** Bounded startup audit for Watches whose live event subscription was lost
   * across a process restart. One broken delivery is recorded and does not
   * prevent unrelated owners/Watches from recovering. */
  async recoverStartupWatches(pageSize = 100): Promise<{
    activeEvaluated: number;
    deliveriesRetried: number;
    failures: Array<{ watchId: string; message: string }>;
  }> {
    const size = Math.max(1, Math.min(pageSize, 100));
    let activeEvaluated = 0;
    let deliveriesRetried = 0;
    const failures: Array<{ watchId: string; message: string }> = [];
    let afterId: string | null = null;
    while (true) {
      const page = this.repository.listActiveWatchesForRecovery(afterId, size);
      if (!page.length) break;
      for (const watch of page) {
        try {
          if (await this.evaluate(watch.ownerUserId, watch.id)) activeEvaluated += 1;
        } catch (error) {
          failures.push({ watchId: watch.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      afterId = page.at(-1)!.id;
      if (page.length < size) break;
    }

    afterId = null;
    while (true) {
      const page = this.repository.listFiredWatchesPendingDelivery(afterId, size);
      if (!page.length) break;
      for (const watch of page) {
        try {
          if (await this.redeliverFired(watch.ownerUserId, watch.id)) deliveriesRetried += 1;
        } catch (error) {
          failures.push({ watchId: watch.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
      afterId = page.at(-1)!.id;
      if (page.length < size) break;
    }
    return { activeEvaluated, deliveriesRetried, failures };
  }
}
