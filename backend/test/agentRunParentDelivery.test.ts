import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AgentRunParentDelivery,
  type ParentContinuationDeliveryInput,
  type ParentDeliveryRecord,
  type ParentDeliveryRecordStore,
} from '../src/agents/agentRunParentDelivery';

class FakeDeliveryStore implements ParentDeliveryRecordStore {
  readonly records = new Map<string, ParentDeliveryRecord>();
  failNextTerminalWrite = false;

  get(deliveryId: string) { return this.records.get(deliveryId) ?? null; }
  createPending(input: ParentContinuationDeliveryInput) {
    const existing = this.records.get(input.deliveryId);
    if (existing) return existing;
    const record: ParentDeliveryRecord = { deliveryId: input.deliveryId, requestedTurnId: input.requestedTurnId, state: 'pending' };
    this.records.set(input.deliveryId, record);
    return record;
  }
  markDelivering(deliveryId: string) {
    const current = this.records.get(deliveryId)!;
    const next = { ...current, state: 'delivering' as const };
    this.records.set(deliveryId, next);
    return next;
  }
  markTerminal(deliveryId: string, state: 'delivered' | 'undeliverable') {
    if (this.failNextTerminalWrite) {
      this.failNextTerminalWrite = false;
      throw new Error('simulated crash after Parent commit');
    }
    const current = this.records.get(deliveryId)!;
    const next = { ...current, state };
    this.records.set(deliveryId, next);
    return next;
  }
}

const input = (overrides: Partial<ParentContinuationDeliveryInput> = {}): ParentContinuationDeliveryInput => ({
  deliveryId: 'delivery-a',
  requestedTurnId: 'agent-watch-watch-a',
  ownerUserId: 'owner-a',
  workspaceId: 'ws-a',
  parentRunId: null,
  parentNodeId: 'node-a',
  parentTurnId: 'turn-a',
  runIds: ['run-a'],
  handoff: 'Run run-a completed. Compact result only.',
  ...overrides,
});

describe('AgentRunParentDelivery', () => {
  test('concurrent delivery calls create one Parent continuation', async () => {
    const store = new FakeDeliveryStore();
    let continuations = 0;
    const sink = new AgentRunParentDelivery(store, {
      async continueParent() { continuations += 1; return 'delivered'; },
    });
    assert.deepEqual(await Promise.all([sink.deliver(input()), sink.deliver(input())]), ['delivered', 'delivered']);
    assert.equal(continuations, 1);
    assert.equal(store.get('delivery-a')?.state, 'delivered');
  });

  test('retry after crash-after-commit reuses requestedTurnId and creates one durable Parent turn', async () => {
    const store = new FakeDeliveryStore();
    store.failNextTerminalWrite = true;
    const createdTurns = new Set<string>();
    let targetCalls = 0;
    const sink = new AgentRunParentDelivery(store, {
      async continueParent(value) {
        targetCalls += 1;
        createdTurns.add(value.requestedTurnId);
        return 'delivered';
      },
    });
    await assert.rejects(() => sink.deliver(input()), /simulated crash/);
    assert.equal(store.get('delivery-a')?.state, 'delivering');
    assert.equal(await sink.deliver(input()), 'delivered');
    assert.equal(targetCalls, 2);
    assert.equal(createdTurns.size, 1);
    assert.equal(store.get('delivery-a')?.state, 'delivered');
  });

  test('deleted Parent records undeliverable without mutating Run ownership or handoff', async () => {
    const store = new FakeDeliveryStore();
    const received: ParentContinuationDeliveryInput[] = [];
    const sink = new AgentRunParentDelivery(store, {
      async continueParent(value) { received.push(value); return 'undeliverable'; },
    });
    const value = input({ parentNodeId: 'deleted-node' });
    assert.equal(await sink.deliver(value), 'undeliverable');
    assert.equal(store.get(value.deliveryId)?.state, 'undeliverable');
    assert.deepEqual(received[0]?.runIds, ['run-a']);
    assert.equal(received[0]?.handoff, value.handoff);
  });

  test('terminal delivery record short-circuits retries and rejects delivery-id aliasing', async () => {
    const store = new FakeDeliveryStore();
    let calls = 0;
    const sink = new AgentRunParentDelivery(store, {
      async continueParent() { calls += 1; return 'delivered'; },
    });
    await sink.deliver(input());
    assert.equal(await sink.deliver(input()), 'delivered');
    assert.equal(calls, 1);
    await assert.rejects(() => sink.deliver(input({ requestedTurnId: 'different-turn' })), /different requested turn/);
  });
});
