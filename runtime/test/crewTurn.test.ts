import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { CrewTurn } from '../src/adapters/crew/acp/crewTurn';
import type { CrewGateway, CrewHistoryRow, CrewSlotDetail } from '../src/adapters/crew/acp/gatewayTypes';

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

test('approval input joins the same native tool call when approval arrives before its row', async () => {
    const f = fixture();
    const input = JSON.stringify({ tool: 'read_page', arguments: { pageId: 'page-1' } });
    f.turn.recordApprovalInput('native-call-1', input);
    await f.turn.tool(row('page-read-row', 'native-call-1'));
    const created = f.cards()[0];
    assert.equal(created.rawInput, input);
    assert.equal(created.status, 'in_progress');
    assert.match(created.toolCallId, /^crew-row-/);
    await f.turn.finish(false);
    assert.equal(f.updates.at(-1).toolCallId, created.toolCallId);
    assert.equal(f.updates.at(-1).rawInput, input);
    assert.equal(f.updates.at(-1).status, 'completed');
});

test('approval input enriches the same existing card and rejects nonmatching or missing native IDs', async () => {
    const f = fixture();
    await f.turn.tool(row('page-read-row', 'native-call-2'));
    const created = f.cards()[0];
    f.turn.recordApprovalInput('request-mid-only', JSON.stringify({ tool: 'read_page', arguments: {} }));
    assert.equal(f.updates.at(-1).rawInput, undefined);
    const input = JSON.stringify({ tool: 'read_page', arguments: { pageId: 'page-2' } });
    f.turn.recordApprovalInput('native-call-2', input);
    assert.equal(f.updates.at(-1).toolCallId, created.toolCallId);
    assert.equal(f.updates.at(-1).rawInput, input);
    assert.equal(f.cards().length, 1);
    await f.turn.finish(false);
    assert.equal(f.updates.at(-1).toolCallId, created.toolCallId);
    assert.equal(f.updates.at(-1).rawInput, input);
    assert.equal(f.updates.at(-1).status, 'completed');
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

describe('CrewTurn subagents', () => {
    it('folds the official subagent frames for its own slot into roster patches and activity', async () => {
        const { applySubagentActivity, mergeSubagentRoster, parseSubagentActivityPayload, parseSubagentRoster } = await import('michi-shared');
        const emitted: any[] = [];
        const turn = new CrewTurn('dashboard:main', { getSlot: async () => ({ messages: [] }) } as any, (update) => emitted.push(update), () => 'id');
        const frames = [
            { type: 'subagent_spawn', data: { id: 'sa-1', slot: 'dashboard:main', task: 'Audit the README\nfor stale commands', agent: 'reviewer', model: 'claude-sonnet' } },
            { type: 'subagent_spawn', data: { id: 'other', slot: 'dashboard:other', task: 'Not ours', agent: 'x' } },
            { type: 'subagent_chunk', data: { id: 'sa-1', slot: 'dashboard:main', text: 'Reading the README now.' } },
            { type: 'subagent_tool', data: { id: 'sa-1', slot: 'dashboard:main', tool: 'Reading README.md', tool_kind: 'read', tool_count: 1 } },
            { type: 'subagent_tool', data: { id: 'sa-1', slot: 'dashboard:main', tool: 'Searching for npm', tool_kind: 'grep', tool_count: 2 } },
            { type: 'subagent_done', data: { id: 'sa-1', slot: 'dashboard:main', elapsed: 4.2, error: null, stopped: false, outcome: 'success', result: 'Two stale commands found.' } },
        ];
        for (const frame of frames) turn.event(frame as any);
        let roster: any[] | undefined;
        for (const update of emitted) {
            assert.equal(update.michi, true);
            if (update.sessionUpdate === 'subagent_list_update') roster = mergeSubagentRoster(roster, parseSubagentRoster(update.subagents));
            if (update.sessionUpdate === 'subagent_tool_activity') roster = applySubagentActivity(roster, parseSubagentActivityPayload(update));
        }
        assert.equal(roster?.length, 1, 'frames for another slot are ignored');
        const [sub] = roster!;
        assert.equal(sub.agentName, 'reviewer');
        assert.equal(sub.prompt, 'Audit the README\nfor stale commands');
        assert.equal(sub.model, 'claude-sonnet');
        assert.equal(sub.outcome, 'completed');
        assert.equal(sub.result, 'Two stale commands found.');
        assert.equal(sub.usage?.durationMs, 4200);
        const tools = sub.activity.filter((a: any) => a.kind === 'tool');
        assert.deepEqual(tools.map((a: any) => [a.title, a.status]), [['Reading README.md', 'completed'], ['Searching for npm', 'completed']]);
        assert.ok(sub.activity.some((a: any) => a.kind === 'message' && a.title === 'Reading the README now.'));
    });

    it('keeps narration and tools in order, one row per narration run, without tool_count', async () => {
        const { applySubagentActivity, mergeSubagentRoster, parseSubagentActivityPayload, parseSubagentRoster } = await import('michi-shared');
        const emitted: any[] = [];
        const turn = new CrewTurn('s', { getSlot: async () => ({ messages: [] }) } as any, (update) => emitted.push(update), () => 'id');
        const frames = [
            { type: 'subagent_spawn', data: { id: 'a', slot: 's', task: 'Audit' } },
            { type: 'subagent_chunk', data: { id: 'a', slot: 's', text: 'First I will read the README.' } },
            { type: 'subagent_tool', data: { id: 'a', slot: 's', tool: 'Read README' } },
            { type: 'subagent_chunk', data: { id: 'a', slot: 's', text: 'Now I will search for npm.' } },
            { type: 'subagent_tool', data: { id: 'a', slot: 's', tool: 'grep npm' } },
            { type: 'subagent_chunk', data: { id: 'a', slot: 's', text: 'Done; two stale commands.' } },
            { type: 'subagent_done', data: { id: 'a', slot: 's', result: 'Two stale commands.' } },
        ];
        for (const frame of frames) turn.event(frame as any);
        let roster: any[] | undefined;
        for (const update of emitted) {
            if (update.sessionUpdate === 'subagent_list_update') roster = mergeSubagentRoster(roster, parseSubagentRoster(update.subagents));
            if (update.sessionUpdate === 'subagent_tool_activity') roster = applySubagentActivity(roster, parseSubagentActivityPayload(update));
        }
        assert.deepEqual(roster![0].activity.map((a: any) => [a.kind, a.title]), [
            ['message', 'First I will read the README.'],
            ['tool', 'Read README'],
            ['message', 'Now I will search for npm.'],
            ['tool', 'grep npm'],
            ['message', 'Done; two stale commands.'],
        ]);
    });

    it('records a user stop and an error as distinct outcomes', async () => {
        const { mergeSubagentRoster, parseSubagentRoster } = await import('michi-shared');
        const emitted: any[] = [];
        const turn = new CrewTurn('s', { getSlot: async () => ({ messages: [] }) } as any, (update) => emitted.push(update), () => 'id');
        turn.event({ type: 'subagent_spawn', data: { id: 'a', slot: 's', task: 'A' } } as any);
        turn.event({ type: 'subagent_spawn', data: { id: 'b', slot: 's', task: 'B' } } as any);
        turn.event({ type: 'subagent_done', data: { id: 'a', slot: 's', stopped: true } } as any);
        turn.event({ type: 'subagent_done', data: { id: 'b', slot: 's', error: 'turn_limit:30' } } as any);
        const roster = emitted.filter((u) => u.sessionUpdate === 'subagent_list_update')
            .reduce((acc, u) => mergeSubagentRoster(acc, parseSubagentRoster(u.subagents)), [] as any[]);
        assert.equal(roster.find((s: any) => s.sessionId === 'a').outcome, 'cancelled');
        assert.equal(roster.find((s: any) => s.sessionId === 'b').outcome, 'failed');
        assert.equal(roster.find((s: any) => s.sessionId === 'b').error, 'turn_limit:30');
    });
});
