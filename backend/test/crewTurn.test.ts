import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CrewTurn } from '../src/agents/crew/acp/crewTurn';
import type { CrewGateway, CrewHistoryRow, CrewSlotDetail } from '../src/agents/crew/acp/gatewayTypes';

const row = (ts: string, id: string, extra: Record<string, unknown> = {}): CrewHistoryRow =>
    ({ type: 'tool', role: 'tool', ts, content: '🔧 Read file', meta: { tool_call_id: id, ...extra } });
function fixture(getSlot?: CrewGateway['getSlot']) {
    const updates: any[] = [];
    let sequence = 0;
    const turn = new CrewTurn('own', { getSlot } as CrewGateway, (event) => updates.push(event), () => String(++sequence));
    const event = (type: string, tool_call_id: string, data: Record<string, unknown> = {}) =>
        turn.event({ type, data: { slot: 'own', tool_call_id, ...data } });
    return { turn, event, updates, cards: () => updates.filter((u) => u.sessionUpdate === 'tool_call') };
}

test('out-of-order WS enrichment joins exact SSE timestamps, dedupes approvals and stays running on partial output', async () => {
    const rows = [row('old', 'old-call'), row('t1', 'call', { input: 'file.ts' }),
        { ...row('t2', 'call'), content: '✅ Read file' }];
    const f = fixture(async () => ({ key: 'own', messages: rows }));
    f.event('tool_result', 'call', { output: 'partial' });
    f.event('tool_call', 'call', { tool: 'Read source', kind: 'read' });
    f.event('tool_result', 'other-call', { output: 'not ours' });
    await f.turn.tool({ type: 'tool', ts: 't1', content: '🔧 Read file' });
    await f.turn.reconcile();
    await f.turn.tool({ type: 'tool', ts: 't2', content: '✅ Read file' });
    await f.turn.tool({ type: 'tool', ts: 't1', content: 'duplicate' });
    await f.turn.reconcile();
    assert.equal(f.cards().length, 1);
    const current = f.updates.at(-1);
    assert.equal(current.status, 'in_progress');
    assert.equal(current.rawInput, 'file.ts');
    assert.equal(current.rawOutput, 'partial');
    assert.equal(current.kind, 'read');
    assert.equal(current.title, 'Read source');
    await f.turn.finish(false);
    assert.equal(f.updates.at(-1).status, 'completed');
    assert.equal(new Set(f.updates.map((u) => u.toolCallId)).size, 1);
});

test('reconnect recovers newer full output from detail without replaying previous turns', async () => {
    const detail: CrewSlotDetail = { key: 'own', title: 'New title', messages: [row('t1', 'call', { output: 'first' }), row('old', 'earlier')] };
    const f = fixture(async () => detail);
    await f.turn.tool({ type: 'tool', ts: 't1', content: 'Read' });
    await f.turn.reconcile();
    f.event('tool_result', 'call', { output: 'partial' });
    detail.messages[0].meta!.output = 'recovered final';
    f.turn.event({ type: 'reconnected', data: {} });
    await f.turn.reconcile();
    assert.equal(f.updates.at(-1).rawOutput, 'recovered final');
    assert.equal(f.cards().length, 1);
    await f.turn.finish(false);
    assert.deepEqual(f.updates.at(-1), { sessionUpdate: 'session_info_update', title: 'New title' });
});

test('failed detail falls back to SSE and later binds the same card to its native id', async () => {
    let fail = true;
    const f = fixture(async () => {
        if (fail) throw new Error('offline');
        return { key: 'own', messages: [row('t1', 'call')] };
    });
    await f.turn.tool({ type: 'tool', ts: 't1', content: '🔧 Read file' });
    await f.turn.reconcile();
    const id = f.cards()[0].toolCallId;
    fail = false;
    await f.turn.reconcile();
    f.event('tool_result', 'call', { output: 'recovered' });
    assert.equal(f.cards().length, 1);
    assert.equal(f.updates.at(-1).toolCallId, id);
    assert.equal(f.updates.at(-1).rawOutput, 'recovered');
    await f.turn.finish(false);
});

test('cancellation settles cards once and discards in-flight detail and late socket events', async () => {
    let resolve!: (value: CrewSlotDetail) => void;
    const detail = new Promise<CrewSlotDetail>((r) => { resolve = r; });
    const f = fixture(() => detail);
    await f.turn.tool({ type: 'tool', ts: 't1', content: 'Read' });
    const finishing = f.turn.finish(false);
    await f.turn.finish(true);
    const length = f.updates.length;
    assert.equal(f.updates.at(-1).status, 'failed');
    resolve({ key: 'own', messages: [row('t1', 'call', { output: 'too late' })] });
    await finishing;
    f.event('tool_result', 'call', { output: 'also late' });
    await f.turn.tool({ type: 'tool', ts: 't2', content: 'late' });
    assert.equal(f.updates.length, length);
});

test('foreign slot events cannot enrich cards or change the title', async () => {
    const f = fixture(async () => ({ key: 'own', messages: [row('t', 'call')] }));
    await f.turn.tool({ type: 'tool', ts: 't', content: 'Read' });
    await f.turn.reconcile();
    f.turn.event({ type: 'tool_result', data: { slot: 'foreign', tool_call_id: 'call', output: 'secret' } });
    f.turn.event({ type: 'slot_title', data: { key: 'foreign', title: 'foreign title' } });
    await f.turn.finish(false);
    assert.doesNotMatch(JSON.stringify(f.updates), /secret|foreign title/);
});

test('context and plans use own-slot data without inventing usage costs or in-progress tasks', async () => {
    const f = fixture();
    f.turn.event({ type: 'context_usage', data: { slot: 'foreign', pct: 90 } });
    for (const pct of [null, '55', NaN, -1, 101]) f.turn.event({ type: 'context_usage', data: { slot: 'own', pct } });
    assert.equal(f.updates.length, 0);
    f.turn.event({ type: 'context_usage', data: { slot: 'own', pct: 22.3, used_tokens: 123, window_tokens: 1000 } });
    f.turn.event({ type: 'context_usage', data: { slot: 'own', pct: 22.3 } });
    const todo = { tasks: [{ text: 'Read', completed: true }, { text: 'Implement', completed: false }] };
    f.turn.event({ type: 'todo_update', data: { slot: 'own', todo } });
    f.turn.event({ type: 'todo_update', data: { slot: 'own', todo } });
    assert.deepEqual(f.updates, [
        { sessionUpdate: 'context_usage', contextUsagePercentage: 22.3 },
        { sessionUpdate: 'plan', entries: [
            { content: 'Read', priority: 'medium', status: 'completed' },
            { content: 'Implement', priority: 'medium', status: 'pending' },
        ] },
    ]);
    await f.turn.finish(false);
    f.turn.event({ type: 'context_usage', data: { slot: 'own', pct: 44 } });
    assert.equal(f.updates.length, 2);
});

test('snapshot metadata recovers tool-free turns and omits stale context measurements', async () => {
    const detail = { key: 'own', messages: [], title: 'Tool-free title', context_pct: 41, context_stale: true, todo: { tasks: [] } };
    const f = fixture(async () => detail);
    await f.turn.reconcile();
    assert.ok(!f.updates.some((u) => u.sessionUpdate === 'context_usage'));
    detail.context_stale = false;
    await f.turn.finish(false);
    assert.ok(f.updates.some((u) => u.contextUsagePercentage === 41));
    assert.deepEqual(f.updates.at(-1), { sessionUpdate: 'session_info_update', title: 'Tool-free title' });
});

test('pagination finds exact tool rows outside the latest page and is bounded', async () => {
    const beforeValues: Array<number | undefined> = [];
    const f = fixture(async (_slot, _limit, before) => {
        beforeValues.push(before);
        return { key: 'own', has_more: true, next_before: before === undefined ? 500 : 0,
            messages: before === undefined ? [] : [row('t', 'call', { output: 'older row' })] };
    });
    await f.turn.tool({ type: 'tool', ts: 't', content: 'Read' });
    await f.turn.finish(false);
    assert.equal(f.updates.at(-1).rawOutput, 'older row');
    assert.ok(beforeValues.includes(500));
    assert.ok(beforeValues.length <= 4);
});

test('unknown result completion flags are not treated as success and output is bounded', async () => {
    const f = fixture(async () => ({ key: 'own', messages: [row('t', 'call', { done: true })] }));
    await f.turn.tool({ type: 'tool', ts: 't', content: 'Read' });
    await f.turn.reconcile();
    f.event('tool_result', 'call', { output: 'x'.repeat(20000) });
    assert.equal(f.updates.at(-1).status, 'in_progress');
    assert.equal(f.updates.at(-1).rawOutput.length, 16000);
    await f.turn.finish(true);
});
