import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunStatus, type AgentRunDtoV1, type AgentRunWatchDtoV1, type WatchConditionV1 } from 'michi-shared';
import { AgentRunWatchCoordinator, watchConditionSatisfied } from '../src/agents/runs/agentRunWatchCoordinator';

function run(id: string, status: AgentRunStatus): AgentRunDtoV1 {
  return { id, status, resultBundle: null } as AgentRunDtoV1;
}

class WatchRepo {
  runs = new Map<string, AgentRunDtoV1>();
  watches = new Map<string, AgentRunWatchDtoV1>();
  delivered = new Map<string, string>();
  next = 1;
  getRun(_owner: string, id: string) { return this.runs.get(id) ?? null; }
  createWatch(ownerUserId: string, workspaceId: string, runIds: readonly string[], condition: WatchConditionV1,
    completionMode: 'notify' | 'wake', parent: any) {
    const id = `watch-${this.next++}`;
    const watch = { version: 1 as const, id, ownerUserId, workspaceId, runIds: [...runIds], condition,
      completionMode, status: 'active' as const, deliveryId: `delivery-${id}`, requestedTurnId: `turn-${id}`,
      ...parent, createdAt: 1, firedAt: null };
    this.watches.set(id, watch); return watch;
  }
  getWatch(_owner: string, id: string) { return this.watches.get(id) ?? null; }
  listActiveWatchesForRecovery(afterId: string | null = null, limit = 100) {
    return [...this.watches.values()].filter((watch) => watch.status === 'active' && (!afterId || watch.id > afterId))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
  }
  listFiredWatchesPendingDelivery(afterId: string | null = null, limit = 100) {
    return [...this.watches.values()].filter((watch) => watch.status === 'fired'
      && this.delivered.get(watch.id) !== 'delivered' && this.delivered.get(watch.id) !== 'undeliverable'
      && (!afterId || watch.id > afterId))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
  }
  addWatchMembers(_owner: string, id: string, runIds: readonly string[]) {
    const watch = this.watches.get(id)!; let added = 0;
    for (const runId of runIds) if (!watch.runIds.includes(runId)) { watch.runIds.push(runId); added += 1; }
    return added;
  }
  fireWatch(_owner: string, id: string) {
    const watch = this.watches.get(id); if (!watch || watch.status !== 'active') return false;
    this.watches.set(id, { ...watch, status: 'fired', firedAt: 10 }); return true;
  }
  markWatchDelivery(_owner: string, id: string, status: string) { this.delivered.set(id, status); return true; }
}

describe('AgentRunWatchCoordinator', () => {
  test('evaluates all, any, quorum, deadline, and manual conditions', () => {
    const runs = [run('a', AgentRunStatus.Completed), run('b', AgentRunStatus.Running)];
    assert.equal(watchConditionSatisfied({ version: 1, kind: 'all' }, runs, 10), false);
    assert.equal(watchConditionSatisfied({ version: 1, kind: 'any' }, runs, 10), true);
    assert.equal(watchConditionSatisfied({ version: 1, kind: 'quorum', count: 1 }, runs, 10), true);
    assert.equal(watchConditionSatisfied({ version: 1, kind: 'deadline', at: 10 }, runs, 10), true);
    assert.equal(watchConditionSatisfied({ version: 1, kind: 'manual' }, runs, 10, true), true);
  });

  test('dynamic membership affects all/quorum evaluation and duplicate additions are ignored', async () => {
    const repo = new WatchRepo();
    repo.runs.set('a', run('a', AgentRunStatus.Completed));
    repo.runs.set('b', run('b', AgentRunStatus.Running));
    const coordinator = new AgentRunWatchCoordinator(repo as any, { notify: async () => {} }, { deliver: async () => 'delivered' },
      { now: () => 5, setTimeout: () => 0, clearTimeout: () => {} });
    const watch = coordinator.create('owner', 'ws', ['a'], { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'op');
    assert.equal(coordinator.addRuns('owner', watch.id, ['b', 'b']), 1);
    assert.equal(await coordinator.evaluate('owner', watch.id), false);
    repo.runs.set('b', run('b', AgentRunStatus.Failed));
    assert.equal(await coordinator.evaluate('owner', watch.id), true);
  });

  test('all and quorum fire immediately on a failed/cancelled member without touching running siblings', async () => {
    const repo = new WatchRepo();
    repo.runs.set('failed', run('failed', AgentRunStatus.Failed));
    repo.runs.set('cancelled', run('cancelled', AgentRunStatus.Cancelled));
    repo.runs.set('sibling', run('sibling', AgentRunStatus.Running));
    const coordinator = new AgentRunWatchCoordinator(repo as any, { notify: async () => {} }, { deliver: async () => 'delivered' },
      { now: () => 5, setTimeout: () => 0, clearTimeout: () => {} });
    const all = coordinator.create('owner', 'ws', ['failed', 'sibling'], { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'all-op');
    const quorum = coordinator.create('owner', 'ws', ['cancelled', 'sibling'], { version: 1, kind: 'quorum', count: 2 }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'quorum-op');
    assert.equal(await coordinator.evaluate('owner', all.id), true);
    assert.equal(await coordinator.evaluate('owner', quorum.id), true);
    assert.equal(repo.runs.get('sibling')?.status, AgentRunStatus.Running);
  });

  test('failure does not override any, manual, or deadline semantics and empty historical Watches stay inert', async () => {
    const repo = new WatchRepo();
    repo.runs.set('failed', run('failed', AgentRunStatus.Failed));
    repo.runs.set('sibling', run('sibling', AgentRunStatus.Running));
    const coordinator = new AgentRunWatchCoordinator(repo as any, { notify: async () => {} }, { deliver: async () => 'delivered' },
      { now: () => 5, setTimeout: () => 0, clearTimeout: () => {} });
    const any = coordinator.create('owner', 'ws', ['failed', 'sibling'], { version: 1, kind: 'any' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'any-op');
    const manual = coordinator.create('owner', 'ws', ['failed', 'sibling'], { version: 1, kind: 'manual' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'manual-op');
    const deadline = coordinator.create('owner', 'ws', ['failed', 'sibling'], { version: 1, kind: 'deadline', at: 10 }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'deadline-op');
    const empty = coordinator.create('owner', 'ws', ['failed'], { version: 1, kind: 'deadline', at: 1 }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'empty-op');
    repo.watches.set(empty.id, { ...empty, runIds: [] });
    assert.equal(await coordinator.evaluate('owner', any.id), true);
    assert.equal(await coordinator.evaluate('owner', manual.id), false);
    assert.equal(await coordinator.evaluate('owner', deadline.id), false);
    assert.equal(await coordinator.evaluate('owner', empty.id, true), false);
  });

  test('fire is claimed once and crash-after-delivery retry is idempotent by deliveryId', async () => {
    const repo = new WatchRepo();
    repo.runs.set('a', run('a', AgentRunStatus.Completed));
    const delivered = new Set<string>(); let calls = 0;
    const sink = { deliver: async ({ deliveryId }: { deliveryId: string }) => { calls += 1; delivered.add(deliveryId); return 'delivered' as const; } };
    const coordinator = new AgentRunWatchCoordinator(repo as any, { notify: async () => {} }, sink,
      { now: () => 5, setTimeout: () => 0, clearTimeout: () => {} });
    const watch = coordinator.create('owner', 'ws', ['a'], { version: 1, kind: 'all' }, 'wake',
      { parentRunId: 'parent', parentNodeId: null, parentTurnId: null }, 'op');
    assert.equal(await coordinator.evaluate('owner', watch.id), true);
    assert.equal(await coordinator.evaluate('owner', watch.id), false);
    await coordinator.redeliverFired('owner', watch.id);
    assert.equal(calls, 2, 'transport may retry after a crash');
    assert.equal(delivered.size, 1, 'deliveryId keeps the Parent effect exactly once');
  });

  test('startup recovery pages active and fired-pending Watches, continues after one delivery failure', async () => {
    const repo = new WatchRepo();
    repo.runs.set('complete', run('complete', AgentRunStatus.Completed));
    repo.runs.set('wake-a', run('wake-a', AgentRunStatus.Completed));
    repo.runs.set('wake-b', run('wake-b', AgentRunStatus.Completed));
    let notifications = 0;
    const bootstrap = new AgentRunWatchCoordinator(repo as any, { notify: async () => { notifications += 1; } }, { deliver: async () => 'delivered' },
      { now: () => 5, setTimeout: () => 0, clearTimeout: () => {} });
    bootstrap.create('owner-a', 'ws', ['complete'], { version: 1, kind: 'all' }, 'notify',
      { parentRunId: null, parentNodeId: null, parentTurnId: null }, 'active-op');
    const failedDelivery = bootstrap.create('owner-a', 'ws', ['wake-a'], { version: 1, kind: 'all' }, 'wake',
      { parentRunId: 'parent', parentNodeId: null, parentTurnId: null }, 'wake-a-op');
    const successfulDelivery = bootstrap.create('owner-b', 'ws', ['wake-b'], { version: 1, kind: 'all' }, 'wake',
      { parentRunId: 'parent', parentNodeId: null, parentTurnId: null }, 'wake-b-op');
    repo.fireWatch('owner-a', failedDelivery.id);
    repo.fireWatch('owner-b', successfulDelivery.id);

    const delivered: string[] = [];
    const restarted = new AgentRunWatchCoordinator(repo as any, { notify: async () => { notifications += 1; } }, {
      deliver: async ({ deliveryId }: { deliveryId: string }) => {
        if (deliveryId === failedDelivery.deliveryId) throw new Error('Parent unavailable');
        delivered.push(deliveryId);
        return 'delivered';
      },
    }, { now: () => 6, setTimeout: () => 0, clearTimeout: () => {} });
    const result = await restarted.recoverStartupWatches(1);
    assert.equal(result.activeEvaluated, 1);
    assert.equal(result.deliveriesRetried, 1);
    assert.deepEqual(result.failures, [{ watchId: failedDelivery.id, message: 'Parent unavailable' }]);
    assert.equal(notifications, 1);
    assert.deepEqual(delivered, [successfulDelivery.deliveryId]);
  });
});
