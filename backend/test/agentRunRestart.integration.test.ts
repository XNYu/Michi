import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunStatus, type AgentRunDtoV1, type DurableTurnSnapshot } from 'michi-shared';
import { ChatHub, type TurnPersistence } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { createAgentRunAssembly, ProductionParentTarget } from '../src/agents/agentRunAssembly';
import { closeDb, initDb } from '../src/services/db';

function events(items: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      return index < items.length
        ? { done: false, value: items[index++] }
        : { done: true, value: undefined };
    },
  };
}

function session(send: () => AsyncIterableIterator<NormalizedEvent>): AgentSession {
  return {
    id: 'parent-node', runtimeId: 'pi',
    getHistory: () => [], getPendingAssistant: () => undefined,
    send: () => send(), cancel: () => {},
  };
}

describe('Agent Run restart integration', () => {
  test('requested Parent turn resumes after durable begin and dedupes every later retry', async () => {
    const durable = new Map<string, { turnId: string; nodeId: string; assistantId: string; status: 'active' | 'completed' | 'cancelled' | 'error' }>();
    let durableBegins = 0;
    const persistence: TurnPersistence = {
      begin(snapshot: DurableTurnSnapshot) {
        if (!durable.has(snapshot.turnId)) durableBegins += 1;
        durable.set(snapshot.turnId, {
          turnId: snapshot.turnId, nodeId: snapshot.nodeId,
          assistantId: snapshot.assistantMessage.id, status: 'active',
        });
      },
      checkpoint() {},
      finalize(snapshot: DurableTurnSnapshot) {
        const row = durable.get(snapshot.turnId)!;
        durable.set(snapshot.turnId, { ...row, status: snapshot.status });
      },
    };
    const lookup = (turnId: string) => durable.get(turnId) ?? null;
    const firstBlocked = new Promise<void>(() => {});
    const firstHub = new ChatHub({ persistence, workspaceIdForNode: () => 'workspace-1', lookupDurableTurn: lookup });
    const first = await firstHub.startRequestedSelfTurn({
      chatId: 'parent-node', nodeId: 'parent-node', ownerUserId: 'owner-1',
      turnId: 'requested-turn-1', text: 'compact Run handoff',
      session: session(() => ({
        [Symbol.asyncIterator]() { return this; },
        async next() { await firstBlocked; return { done: true, value: undefined }; },
      })),
    });
    assert.equal(first.existing, false);
    assert.equal(durable.get('requested-turn-1')?.status, 'active');

    // Simulate a backend restart after durable begin but before delivery ack.
    const restartedHub = new ChatHub({ persistence, workspaceIdForNode: () => 'workspace-1', lookupDurableTurn: lookup });
    let resumedSends = 0;
    const resumed = await restartedHub.startRequestedSelfTurn({
      chatId: 'parent-node', nodeId: 'parent-node', ownerUserId: 'owner-1',
      turnId: 'requested-turn-1', text: 'compact Run handoff',
      session: session(() => {
        resumedSends += 1;
        return events([{ kind: 'chunk', text: 'Parent continued' }, { kind: 'turn_end', stopReason: 'end_turn' }]);
      }),
    });
    await resumed.done;
    assert.equal(resumed.existing, true);
    assert.equal(resumed.assistantId, first.assistantId);
    assert.equal(resumedSends, 1);
    assert.equal(durableBegins, 1, 'retry must reuse one durable requested-turn identity');
    assert.equal(durable.get('requested-turn-1')?.status, 'completed');

    const terminalRetry = await new ChatHub({ persistence, workspaceIdForNode: () => 'workspace-1', lookupDurableTurn: lookup })
      .startRequestedSelfTurn({
        chatId: 'parent-node', nodeId: 'parent-node', ownerUserId: 'owner-1',
        turnId: 'requested-turn-1', text: 'compact Run handoff',
        session: session(() => { throw new Error('terminal retry must not invoke the runtime'); }),
      });
    await terminalRetry.done;
    assert.equal(terminalRetry.existing, true);
    assert.equal(resumedSends, 1);
  });

  test('requested Parent terminal error and cancellation are not successful deliveries', async () => {
    for (const status of ['error', 'cancelled'] as const) {
      const durable = new Map<string, { turnId: string; nodeId: string; assistantId: string; status: 'active' | 'completed' | 'cancelled' | 'error' }>();
      const turnId = `requested-${status}`;
      durable.set(turnId, { turnId, nodeId: 'parent-node', assistantId: `self-parent-node-${turnId}`, status });
      const hub = new ChatHub({
        persistence: { begin() {}, checkpoint() {}, finalize() {} },
        workspaceIdForNode: () => 'workspace-1',
        lookupDurableTurn: (id) => durable.get(id) ?? null,
      });
      const existing = await hub.startRequestedSelfTurn({
        chatId: 'parent-node', nodeId: 'parent-node', ownerUserId: 'owner-1', turnId,
        text: 'compact handoff', session: session(() => { throw new Error('must not replay terminal turn'); }),
      });
      await existing.done;
      assert.equal(hub.requestedTurnStatus(turnId), status);
      assert.notEqual(hub.requestedTurnStatus(turnId), 'completed');
    }
  });

  test('Parent delivery acknowledges only a completed requested turn', async () => {
    for (const status of ['completed', 'error', 'cancelled'] as const) {
      const target = new ProductionParentTarget({
        ensureParentSession: async () => ({ id: 'parent-chat' }),
      } as any, {
        startRequestedSelfTurn: async () => ({
          turnId: 'requested-turn', assistantId: 'assistant', existing: false, done: Promise.resolve(),
        }),
        requestedTurnStatus: () => status,
      } as any, {} as any);
      const result = await target.continueParent({
        deliveryId: `delivery-${status}`, requestedTurnId: 'requested-turn', ownerUserId: 'owner-1',
        workspaceId: 'workspace-1', parentRunId: null, parentNodeId: 'parent-node', parentTurnId: 'parent-turn',
        runIds: ['run-1'], handoff: 'done',
      });
      assert.equal(result, status === 'completed' ? 'delivered' : 'undeliverable');
    }
  });

  describe('assembly lease recovery', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-run-restart-'));
      process.env.MICHI_DATA_DIR = tmpDir;
      closeDb(); initDb();
    });
    afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

    test('two assembly instances cannot reclaim and execute the same expired lease', async () => {
      const record = {
        run: {
          version: 1, id: 'run-expired', ownerUserId: 'owner-1', workspaceId: 'workspace-1', definitionId: null,
          definitionRevision: null, effectiveDefinition: {}, invocationMode: 'manual', completionMode: 'detach',
          parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null,
          task: 'Recover', contextManifest: {}, expectedResult: null, executionEnvironment: {}, status: AgentRunStatus.Running,
          waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null, latestEventSeq: 2,
          createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null,
        } as AgentRunDtoV1,
        leaseExpiresAt: 999,
      };
      let claimed = false;
      const recoverySource = {
        list: (afterId: string | null) => afterId ? [] : [record],
        reclaimExpired: () => { if (claimed) return false; claimed = true; return true; },
      };
      const starts: string[] = [];
      const coordinator = {
        events: { subscribeAll: () => () => {} },
        start: async (_owner: string, id: string) => { starts.push(id); return null; },
        shutdown: async () => {},
      } as any;
      const watches = { recoverStartupWatches: async () => ({ activeEvaluated: 0, deliveriesRetried: 0, failures: [] }) } as any;
      const clock = { now: () => 1_000, setTimeout: () => 1, clearTimeout: () => {} };
      const first = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, instanceId: 'one', clock, coordinator, watches, recoverySource,
        heartbeatIntervalMs: 0, maintenanceIntervalMs: 0 });
      const second = createAgentRunAssembly({ enabled: true, dataDir: tmpDir, instanceId: 'two', clock, coordinator, watches, recoverySource,
        heartbeatIntervalMs: 0, maintenanceIntervalMs: 0 });
      const [a, b] = await Promise.all([first.recoverStartup(), second.recoverStartup()]);
      assert.equal(a.reclaimed + b.reclaimed, 1);
      assert.equal(a.launched + b.launched, 1);
      assert.deepEqual(starts, ['run-expired']);
    });
  });
});
