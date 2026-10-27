/**
 * BackgroundSubagentRegistry: per (owner, node) union of the background
 * subagent ids live sessions report, with a grace period before a removal
 * reaches subscribers. Timers are mocked so the grace is deterministic.
 */
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_SUBAGENT_LIMITS, SUBAGENT_END_LIMITS, type SubagentEnd } from 'michi-shared';
import {
  BackgroundSubagentRegistry,
  RECENT_END_LIMITS,
  REMOVAL_GRACE_MS,
  type BackgroundSubagentContext,
  type BackgroundSubagentEndRecorder,
  type EndedBackgroundSubagents,
} from '../src/services/backgroundSubagentRegistry';
import { log } from '../src/services/logger';

const GRACE = 1_000;
const CTX: BackgroundSubagentContext = { ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' };

type Delivery = [owner: string, workspace: string, nodes: Record<string, string[]>];

function harness(t: TestContext, opts: { resolveWorkspace?: (nodeId: string) => string | null; graceMs?: number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resolved: string[] = [];
  const registry = new BackgroundSubagentRegistry({
    graceMs: opts.graceMs ?? GRACE,
    resolveWorkspace: (nodeId) => {
      resolved.push(nodeId);
      return opts.resolveWorkspace ? opts.resolveWorkspace(nodeId) : 'ws-resolved';
    },
  });
  const deliveries: Delivery[] = [];
  const unsubscribe = registry.subscribe((owner, workspace, nodes) => deliveries.push([owner, workspace, nodes]));
  return { registry, deliveries, resolved, unsubscribe, tick: (ms: number) => t.mock.timers.tick(ms) };
}

describe('BackgroundSubagentRegistry', () => {
  test('defaults to a two second removal grace', () => {
    assert.equal(REMOVAL_GRACE_MS, 2_000);
  });

  test('a node shows the union of its sources; additions publish at once', (t) => {
    const { registry, deliveries } = harness(t);
    registry.report(CTX, 'claude:a', ['agent-1']);
    assert.deepEqual(deliveries, [['owner-a', 'ws-a', { 'node-1': ['agent-1'] }]], 'synchronous, no grace for an addition');
    registry.report(CTX, 'claude:b', ['agent-2']);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': ['agent-1', 'agent-2'] }]);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1', 'agent-2'] });
  });

  test('withdrawing one source keeps the ids the other still reports', (t) => {
    const { registry, deliveries, tick } = harness(t);
    const shown = () => [...(registry.snapshot('owner-a', 'ws-a')['node-1'] ?? [])].sort();
    const lastDelivered = () => [...deliveries.at(-1)![2]['node-1']].sort();
    registry.report(CTX, 'old', ['agent-1', 'shared']);
    registry.report(CTX, 'new', ['shared', 'agent-2']);

    registry.report(CTX, 'old', []);
    // Order aside (see the reorder test below), nothing leaves yet.
    assert.deepEqual(shown(), ['agent-1', 'agent-2', 'shared'], 'the removal waits for the grace');
    assert.deepEqual(lastDelivered(), ['agent-1', 'agent-2', 'shared']);

    tick(GRACE);
    assert.deepEqual(lastDelivered(), ['agent-2', 'shared'], 'only the withdrawn source\'s own id leaves');
    assert.deepEqual(shown(), ['agent-2', 'shared']);
  });

  // Spec: "subscribe fires only on visible changes". publish() compares the
  // shown list by position, and a removal moves the leaving id behind the
  // ids still reported (union first, then `leaving`), so a removal inside its
  // grace, or a source reporting the same ids in another order, republishes
  // an unchanged set. Harmless to a client that treats the list as a set,
  // but it is a delivery with no visible change.
  test('fires only on visible changes: the same ids in another order publish nothing', (t) => {
    const { registry, deliveries } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    registry.report(CTX, 'b', ['agent-2']);
    assert.equal(deliveries.length, 2);
    registry.report(CTX, 'a', []);
    assert.equal(deliveries.length, 2, 'agent-1 is still shown during its grace: nothing visible changed');

    registry.report({ ...CTX, nodeId: 'node-2' }, 'c', ['x', 'y']);
    const before = deliveries.length;
    registry.report({ ...CTX, nodeId: 'node-2' }, 'c', ['y', 'x']);
    assert.equal(deliveries.length, before, 'the same set in another order');
  });

  test('an id another source still reports never leaves, so nothing is published', (t) => {
    const { registry, deliveries, tick } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    registry.report(CTX, 'b', ['agent-1']);
    assert.equal(deliveries.length, 1, 'the second source adds nothing visible');
    registry.report(CTX, 'a', []);
    tick(GRACE * 3);
    assert.equal(deliveries.length, 1);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });
  });

  test('a removal reaches subscribers only after the grace, then the node is dropped', (t) => {
    const { registry, deliveries, tick } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    registry.report(CTX, 'a', []);
    assert.equal(deliveries.length, 1);
    tick(GRACE - 1);
    assert.equal(deliveries.length, 1, 'still inside the grace');
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] }, 'still shown to new subscribers too');
    tick(1);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': [] }]);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), {});
    assert.equal((registry as any).nodes.size, 0, 'an empty node is not kept');
  });

  test('a partial removal publishes the remaining ids after the grace', (t) => {
    const { registry, deliveries, tick } = harness(t);
    registry.report(CTX, 'a', ['agent-1', 'agent-2']);
    registry.report(CTX, 'a', ['agent-1']);
    assert.equal(deliveries.length, 1);
    tick(GRACE);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': ['agent-1'] }]);
  });

  test('re-adding an id within the grace cancels its removal', (t) => {
    const { registry, deliveries, tick } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    registry.report(CTX, 'a', []);
    tick(GRACE / 2);
    // A replacement session for the same node reports it back in time.
    registry.report(CTX, 'b', ['agent-1']);
    tick(GRACE * 3);
    assert.equal(deliveries.length, 1, 'subscribers never saw it leave');
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });

    // A later removal gets a fresh grace, not the cancelled timer's.
    registry.report(CTX, 'b', []);
    tick(GRACE - 1);
    assert.equal(deliveries.length, 1);
    tick(1);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': [] }]);
  });

  test('an addition during another id\'s grace publishes at once and keeps the leaving id until its timer', (t) => {
    const { registry, deliveries, tick } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    registry.report(CTX, 'a', []);
    tick(GRACE / 2);
    registry.report(CTX, 'a', ['agent-2']);
    // Ids already shown keep their place; new ones are appended.
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': ['agent-1', 'agent-2'] }]);
    tick(GRACE / 2);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': ['agent-2'] }], 'agent-1 leaves on its original deadline');
  });

  test('an unchanged report publishes nothing', (t) => {
    const { registry, deliveries } = harness(t);
    registry.report(CTX, 'a', ['agent-1', 'agent-2']);
    registry.report(CTX, 'a', ['agent-1', 'agent-2']);
    registry.report(CTX, 'a', ['agent-1', 'agent-1', 'agent-2']);
    assert.equal(deliveries.length, 1);
  });

  test('an empty report for an untracked node does nothing and resolves no workspace', (t) => {
    const { registry, deliveries, resolved } = harness(t);
    registry.report({ ...CTX, workspaceId: null }, 'a', []);
    assert.deepEqual(deliveries, []);
    assert.deepEqual(resolved, []);
    assert.equal((registry as any).nodes.size, 0);
  });

  test('payloads are copies: a listener mutating its payload changes nothing', (t) => {
    const { registry, deliveries } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    deliveries[0][2]['node-1'].push('forged');
    registry.snapshot('owner-a', 'ws-a')['node-1'].push('forged');
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });
  });

  test('owners and workspaces are isolated in snapshots and listener payloads', (t) => {
    const { registry, deliveries } = harness(t);
    registry.report(CTX, 'a', ['mine']);
    // Same node id, another owner: a separate entry.
    registry.report({ ...CTX, ownerUserId: 'owner-b' }, 'b', ['theirs']);
    registry.report({ ...CTX, workspaceId: 'ws-b', nodeId: 'node-2' }, 'c', ['other-ws']);

    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['mine'] });
    assert.deepEqual(registry.snapshot('owner-b', 'ws-a'), { 'node-1': ['theirs'] });
    assert.deepEqual(registry.snapshot('owner-a', 'ws-b'), { 'node-2': ['other-ws'] });
    assert.deepEqual(registry.snapshot('owner-b', 'ws-b'), {});
    assert.deepEqual(deliveries, [
      ['owner-a', 'ws-a', { 'node-1': ['mine'] }],
      ['owner-b', 'ws-a', { 'node-1': ['theirs'] }],
      ['owner-a', 'ws-b', { 'node-2': ['other-ws'] }],
    ]);

    // Withdrawing owner-b's report leaves owner-a's node alone.
    registry.report({ ...CTX, ownerUserId: 'owner-b' }, 'b', []);
    t.mock.timers.tick(GRACE);
    assert.deepEqual(deliveries.at(-1), ['owner-b', 'ws-a', { 'node-1': [] }]);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['mine'] });
  });

  test('the node\'s workspace is resolved when the session has not learned it', (t) => {
    const { registry, deliveries, resolved } = harness(t, { resolveWorkspace: (nodeId) => (nodeId === 'node-1' ? 'ws-a' : null) });
    registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1']);
    assert.deepEqual(resolved, ['node-1']);
    assert.deepEqual(deliveries, [['owner-a', 'ws-a', { 'node-1': ['agent-1'] }]]);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });
    // Resolved once, when the entry is created.
    registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1', 'agent-2']);
    assert.deepEqual(resolved, ['node-1']);
  });

  test('a context workspace is used as is, without a lookup', (t) => {
    const { registry, resolved } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    assert.deepEqual(resolved, []);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });
  });

  test('a node without a workspace is not tracked, with one warning', (t) => {
    const warnings: string[] = [];
    t.mock.method(log, 'warn', (_stage: string, msg: string) => { warnings.push(msg); });
    const { registry, deliveries, resolved } = harness(t, { resolveWorkspace: () => null });
    registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1']);
    registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1', 'agent-2']);
    assert.deepEqual(deliveries, []);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), {});
    assert.deepEqual(registry.snapshot('owner-a', 'ws-resolved'), {});
    assert.equal(resolved.length, 2, 'looked up again on the next report');
    assert.equal(warnings.filter((msg) => /no workspace/.test(msg)).length, 1, 'warned once per node');
  });

  test('a failing workspace lookup is treated as no workspace', (t) => {
    t.mock.method(log, 'warn', () => {});
    const { registry, deliveries } = harness(t, { resolveWorkspace: () => { throw new Error('db closed'); } });
    assert.doesNotThrow(() => registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1']));
    assert.deepEqual(deliveries, []);
  });

  test('ids that are empty or longer than the limit are dropped', (t) => {
    const { registry } = harness(t);
    const max = 'x'.repeat(BACKGROUND_SUBAGENT_LIMITS.idLength);
    const tooLong = 'y'.repeat(BACKGROUND_SUBAGENT_LIMITS.idLength + 1);
    registry.report(CTX, 'a', ['', tooLong, max, 42 as unknown as string, 'ok']);
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': [max, 'ok'] });
  });

  test('a report of only invalid ids does not create a node', (t) => {
    const { registry, deliveries, resolved } = harness(t);
    registry.report({ ...CTX, workspaceId: null }, 'a', ['y'.repeat(BACKGROUND_SUBAGENT_LIMITS.idLength + 1)]);
    assert.deepEqual(deliveries, []);
    assert.deepEqual(resolved, []);
  });

  test('a node shows at most the per-node limit of ids', (t) => {
    const { registry, deliveries } = harness(t);
    const ids = Array.from({ length: BACKGROUND_SUBAGENT_LIMITS.idsPerNode + 20 }, (_, i) => `agent-${i}`);
    registry.report(CTX, 'a', ids);
    assert.equal(registry.snapshot('owner-a', 'ws-a')['node-1'].length, BACKGROUND_SUBAGENT_LIMITS.idsPerNode);
    assert.equal(deliveries[0][2]['node-1'].length, BACKGROUND_SUBAGENT_LIMITS.idsPerNode);
  });

  test('a snapshot lists at most the node limit', (t) => {
    const { registry } = harness(t);
    for (let i = 0; i < BACKGROUND_SUBAGENT_LIMITS.nodes + 5; i += 1) {
      registry.report({ ...CTX, nodeId: `node-${i}` }, 'a', ['agent']);
    }
    assert.equal(Object.keys(registry.snapshot('owner-a', 'ws-a')).length, BACKGROUND_SUBAGENT_LIMITS.nodes);
  });

  test('a listener that throws does not stop the others or the report', (t) => {
    const warnings: string[] = [];
    t.mock.method(log, 'warn', (_stage: string, msg: string) => { warnings.push(msg); });
    const { registry, deliveries } = harness(t);
    registry.subscribe(() => { throw new Error('socket gone'); });
    const later: Delivery[] = [];
    registry.subscribe((owner, workspace, nodes) => later.push([owner, workspace, nodes]));
    assert.doesNotThrow(() => registry.report(CTX, 'a', ['agent-1']));
    assert.equal(deliveries.length, 1);
    assert.equal(later.length, 1, 'a listener after the failing one still hears it');
    assert.deepEqual(registry.snapshot('owner-a', 'ws-a'), { 'node-1': ['agent-1'] });
    assert.ok(warnings.some((msg) => /listener failed/.test(msg)));
  });

  test('an unsubscribed listener hears nothing more', (t) => {
    const { registry, deliveries, unsubscribe } = harness(t);
    registry.report(CTX, 'a', ['agent-1']);
    unsubscribe();
    registry.report(CTX, 'a', ['agent-1', 'agent-2']);
    assert.equal(deliveries.length, 1);
  });
});

describe('BackgroundSubagentRegistry.end', () => {
  const stopped = (sessionId: string): SubagentEnd => ({ sessionId, outcome: 'cancelled', endedAt: 5, error: 'gone' });

  function endHarness(t: TestContext, recordEnds?: BackgroundSubagentEndRecorder) {
    const base = harness(t);
    if (recordEnds) base.registry.setEndRecorder(recordEnds);
    const ended: EndedBackgroundSubagents[] = [];
    base.registry.subscribeEnded((update) => ended.push(update));
    return { ...base, ended };
  }

  test('withdraws the source, stores the ends, then tells ended subscribers with the stored workspace', (t) => {
    const calls: Array<[string, string, SubagentEnd[]]> = [];
    const order: string[] = [];
    const { registry, deliveries, ended, tick } = endHarness(t, (owner, nodeId, ends) => {
      order.push('record');
      calls.push([owner, nodeId, [...ends]]);
      return { workspaceId: 'ws-from-db' };
    });
    registry.subscribeEnded(() => order.push('ended'));
    registry.report(CTX, 'claude:a', ['agent-1', 'agent-2']);
    registry.end(CTX, 'claude:a', [stopped('agent-1'), { sessionId: 'agent-2', outcome: 'completed', endedAt: 4, result: 'done' }]);
    assert.deepEqual(calls, [['owner-a', 'node-1', [stopped('agent-1'), { sessionId: 'agent-2', outcome: 'completed', endedAt: 4, result: 'done' }]]]);
    assert.deepEqual(order, ['record', 'ended'], 'stored before anyone hears of it');
    assert.deepEqual(ended, [{
      ownerUserId: 'owner-a', workspaceId: 'ws-from-db', nodeId: 'node-1',
      ends: [stopped('agent-1'), { sessionId: 'agent-2', outcome: 'completed', endedAt: 4, result: 'done' }],
    }]);
    tick(GRACE);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': [] }], 'the liveness feed drops them after the grace');
  });

  test('nothing to end only withdraws: no store, no ended event', (t) => {
    let recorded = 0;
    const { registry, ended, tick, deliveries } = endHarness(t, () => { recorded += 1; return { workspaceId: 'ws-a' }; });
    registry.report(CTX, 'a', ['agent-1']);
    registry.end(CTX, 'a', []);
    assert.equal(recorded, 0);
    assert.deepEqual(ended, []);
    tick(GRACE);
    assert.deepEqual(deliveries.at(-1), ['owner-a', 'ws-a', { 'node-1': [] }]);
  });

  test('a node the recorder does not find or own publishes nothing', (t) => {
    const { registry, ended } = endHarness(t, () => null);
    registry.end(CTX, 'a', [stopped('agent-1')]);
    assert.deepEqual(ended, []);
  });

  test('a failing recorder still tells subscribers, under the workspace the node was tracked in', (t) => {
    const warnings: string[] = [];
    t.mock.method(log, 'warn', (_stage: string, msg: string) => { warnings.push(msg); });
    const { registry, ended } = endHarness(t, () => { throw new Error('database is locked'); });
    registry.report({ ...CTX, workspaceId: null }, 'a', ['agent-1']);
    registry.end({ ...CTX, workspaceId: null }, 'a', [stopped('agent-1')]);
    assert.deepEqual(ended.map((update) => update.workspaceId), ['ws-resolved']);
    assert.ok(warnings.some((msg) => /were not stored/.test(msg)));
  });

  test('without a recorder nothing is looked up: the context or tracked workspace, else nothing', (t) => {
    const { registry, ended, resolved } = endHarness(t);
    registry.end(CTX, 'a', [stopped('agent-1')]);
    registry.end({ ...CTX, nodeId: 'node-unknown', workspaceId: null }, 'a', [stopped('agent-2')]);
    assert.deepEqual(resolved, [], 'the database is the recorder\'s; tests without one never open it');
    assert.deepEqual(ended.map((update) => [update.workspaceId, update.nodeId]), [['ws-a', 'node-1']]);
  });

  test('drops ends with invalid or repeated ids and bounds the list', (t) => {
    const { registry, ended } = endHarness(t);
    const tooLong = 'y'.repeat(SUBAGENT_END_LIMITS.idLength + 1);
    registry.end(CTX, 'a', [stopped(''), stopped(tooLong), stopped('ok'), stopped('ok'), null as unknown as SubagentEnd]);
    assert.deepEqual(ended[0].ends, [stopped('ok')]);
    const many = Array.from({ length: SUBAGENT_END_LIMITS.ends + 5 }, (_, i) => stopped(`agent-${i}`));
    registry.end(CTX, 'a', many);
    assert.equal(ended[1].ends.length, SUBAGENT_END_LIMITS.ends);
  });

  test('a throwing ended listener does not stop the others', (t) => {
    t.mock.method(log, 'warn', () => {});
    const { registry, ended } = endHarness(t);
    registry.subscribeEnded(() => { throw new Error('socket gone'); });
    const later: EndedBackgroundSubagents[] = [];
    registry.subscribeEnded((update) => later.push(update));
    assert.doesNotThrow(() => registry.end(CTX, 'a', [stopped('agent-1')]));
    assert.equal(ended.length, 1);
    assert.equal(later.length, 1);
  });
});

describe('BackgroundSubagentRegistry.recentEnds', () => {
  const stopped = (sessionId: string, extra: Partial<SubagentEnd> = {}): SubagentEnd => ({ sessionId, outcome: 'cancelled', endedAt: 5, ...extra });

  test('keeps the published ends of a workspace, by node, for the owner only', (t) => {
    const { registry } = harness(t);
    registry.end(CTX, 'a', [stopped('agent-1'), stopped('agent-2')]);
    registry.end({ ...CTX, nodeId: 'node-2' }, 'b', [stopped('agent-3')]);
    registry.end({ ...CTX, ownerUserId: 'owner-b' }, 'c', [stopped('agent-4')]);
    registry.end({ ...CTX, workspaceId: 'ws-b', nodeId: 'node-9' }, 'd', [stopped('agent-5')]);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-a'), [
      { nodeId: 'node-1', ends: [stopped('agent-1'), stopped('agent-2')] },
      { nodeId: 'node-2', ends: [stopped('agent-3')] },
    ]);
    assert.deepEqual(registry.recentEnds('owner-b', 'ws-a'), [{ nodeId: 'node-1', ends: [stopped('agent-4')] }]);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-b'), [{ nodeId: 'node-9', ends: [stopped('agent-5')] }]);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-none'), []);
  });

  test('a later end of the same agent replaces the earlier one', (t) => {
    const { registry } = harness(t);
    registry.end(CTX, 'a', [stopped('agent-1')]);
    registry.end(CTX, 'b', [stopped('agent-2')]);
    registry.end(CTX, 'c', [stopped('agent-1', { outcome: 'completed', result: 'done' })]);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-a'), [
      { nodeId: 'node-1', ends: [stopped('agent-2'), stopped('agent-1', { outcome: 'completed', result: 'done' })] },
    ]);
  });

  test('keeps nothing the recorder did not store and publish', (t) => {
    const { registry } = harness(t);
    registry.setEndRecorder(() => null);
    registry.end(CTX, 'a', [stopped('agent-1')]);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-a'), []);
  });

  test('a returned list is a copy', (t) => {
    const { registry } = harness(t);
    registry.end(CTX, 'a', [stopped('agent-1')]);
    registry.recentEnds('owner-a', 'ws-a')[0].ends[0].outcome = 'failed';
    assert.equal(registry.recentEnds('owner-a', 'ws-a')[0].ends[0].outcome, 'cancelled');
  });

  test('replays in chunks the wire accepts', (t) => {
    const { registry } = harness(t);
    const count = SUBAGENT_END_LIMITS.ends + 3;
    for (let i = 0; i < count; i += 1) registry.end(CTX, 'a', [stopped(`agent-${i}`)]);
    const recent = registry.recentEnds('owner-a', 'ws-a');
    assert.deepEqual(recent.map((group) => [group.nodeId, group.ends.length]), [['node-1', SUBAGENT_END_LIMITS.ends], ['node-1', 3]]);
    assert.equal(recent[1].ends.at(-1)?.sessionId, `agent-${count - 1}`);
  });

  test('drops the oldest past the per-workspace and total byte bounds', (t) => {
    const { registry } = harness(t);
    const result = 'r'.repeat(7_900);
    const size = Buffer.byteLength(JSON.stringify(stopped('agent-00000', { result }))) + 'node-1'.length;
    const perWorkspace = Math.floor(RECENT_END_LIMITS.workspaceBytes / size);
    for (let i = 0; i < perWorkspace + 5; i += 1) registry.end(CTX, 'a', [stopped(`agent-${String(i).padStart(5, '0')}`, { result })]);
    const kept = registry.recentEnds('owner-a', 'ws-a').flatMap((group) => group.ends.map((end) => end.sessionId));
    assert.equal(kept.length, perWorkspace);
    assert.equal(kept[0], 'agent-00005', 'the oldest went first');

    // Across workspaces the total bound applies; each stays within its own.
    // A node belongs to one workspace: each gets its own, named as long as
    // node-1 so every entry has the size measured above.
    const workspaces = Math.ceil(RECENT_END_LIMITS.totalBytes / RECENT_END_LIMITS.workspaceBytes) + 2;
    for (let w = 0; w < workspaces; w += 1) {
      const nodeId = `node-${String.fromCharCode(97 + w)}`;
      for (let i = 0; i < perWorkspace; i += 1) {
        registry.end({ ...CTX, workspaceId: `ws-${w}`, nodeId }, 'a', [stopped(`agent-${String(i).padStart(5, '0')}`, { result })]);
      }
    }
    let total = 0;
    for (const ws of ['ws-a', ...Array.from({ length: workspaces }, (_, w) => `ws-${w}`)]) {
      for (const group of registry.recentEnds('owner-a', ws)) total += group.ends.length;
    }
    assert.ok(total * size <= RECENT_END_LIMITS.totalBytes, `${total * size} bytes kept`);
    assert.deepEqual(registry.recentEnds('owner-a', 'ws-a'), [], 'the oldest workspace\'s went first');
    assert.equal(registry.recentEnds('owner-a', `ws-${workspaces - 1}`)[0].ends.length, perWorkspace);
  });
});
