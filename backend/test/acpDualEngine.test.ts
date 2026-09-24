import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/services/acpClient';
import type { KiroEngine } from '../src/agents/kiro/kiroProtocol';

function fixture(engine: KiroEngine) {
    const c = new AcpClient('/bin/false', '/tmp', undefined, engine);
    const internal = c as any;
    const calls: any[] = [];
    internal.send = async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: {} } } };
        if (method === 'session/new' || method === 'session/load') return { sessionId: 'parent',
            ...(engine === 'v3' ? { configOptions: [{ id: 'model', type: 'select', currentValue: 'old', options: [{ value: 'old' }, { value: 'new' }] }] }
                : { models: { currentModelId: 'old' } }),
        };
        if (method === 'session/set_config_option') return { configOptions: [{ id: 'model', type: 'select', currentValue: params.value }] };
        if (method === '_kiro.dev/commands/execute') return params.command.args?.value === undefined
            ? { success: true, data: { turns: [{ logIndex: 19 }, { logIndex: 3 }] } }
            : { success: true, data: { sessionId: 'child', switchSession: true } };
        if (method === 'session/fork') return { sessionId: 'child' };
        if (method === '_session/steer') return { queued: true, ...(engine === 'v3' ? { messageId: 'steer-id' } : {}) };
        if (method === '_session/steer/clear') return { cleared: true, ...(engine === 'v3' ? { messageIds: ['steer-id'] } : {}) };
        return {};
    };
    return { c, internal, calls };
}

for (const engine of ['v2', 'v3'] as const) {
    test(`${engine}: numeric handshake, session config, and model switch use the correct wire API`, async () => {
        const { c, calls } = fixture(engine);
        await c.initialize();
        assert.equal(calls[0].params.protocolVersion, 1);
        assert.ok(c.capabilities?.sessionCapabilities?.fork);
        const result = await c.newSession([{ name: 'michi', type: 'http', url: 'http://localhost', headers: [] }]);
        assert.equal(result.models.currentModelId, 'old');
        await c.setModel('parent', 'new');
        assert.equal(calls[2].method, engine === 'v3' ? 'session/set_config_option' : 'session/set_model');
        assert.equal(c.getSessionInfo('parent')?.models.currentModelId, 'new');
    });

    test(`${engine}: fork creates an independent child and uses only native anchors`, async () => {
        const { c, calls } = fixture(engine);
        await c.initialize();
        await c.newSession();
        assert.equal(await c.forkSession('parent', engine === 'v3' ? { messageId: 'native-user-id' } : undefined), 'child');
        if (engine === 'v2') {
            assert.deepEqual(calls[2].params.command, { command: 'rewind', args: {} });
            assert.deepEqual(calls[3].params.command, { command: 'rewind', args: { value: '19' } });
        } else assert.deepEqual(calls[2].params._meta, { kiro: { messageId: 'native-user-id', createdReason: 'rewind' } });
        assert.ok(c.hasSession('parent'));
    });

    test(`${engine}: rejects fork during a prompt and steers only a live turn`, async () => {
        const { c, internal, calls } = fixture(engine);
        assert.deepEqual(await c.steer('parent', 'late'), { queued: false });
        assert.equal(calls.length, 0);
        internal.sessionInFlight.set('parent', Promise.resolve());
        await assert.rejects(c.forkSession('parent'), /active/);
        assert.deepEqual(await c.steer('parent', 'locked but not prompting'), { queued: false });
        internal.activePrompts.add('parent');
        assert.equal((await c.steer('parent', 'change direction')).queued, true);
        assert.deepEqual(calls[0], { method: '_session/steer', params: { sessionId: 'parent', message: 'change direction' } });
        const cleared = await c.clearSteer('parent');
        assert.equal(cleared.cleared, true);
        assert.deepEqual(cleared.messageIds, engine === 'v3' ? ['steer-id'] : undefined);
    });

    test(`${engine}: load absorbs identity/config but drops replay before the next prompt`, async () => {
        const { c, internal } = fixture(engine);
        const send = internal.send;
        internal.send = async (method: string, params: any) => {
            if (method === 'session/load') internal.dispatch({ method: 'session/update', params: {
                sessionId: 'parent', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' }, _meta: { kiro: { replay: true } } },
            } });
            if (method === 'session/prompt') {
                c.injectUpdate('parent', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW' } });
                return { stopReason: 'end_turn' };
            }
            return send(method, params);
        };
        await c.loadSession('parent', '/tmp');
        const updates = [];
        for await (const event of c.prompt('parent', 'continue')) updates.push(event);
        assert.deepEqual(updates.map((u) => u.content?.text ?? u.sessionUpdate), ['NEW', 'turn_end']);
    });
}

test('v3 emits one usage summary and waits for prompt response despite early turn_end', async () => {
    const { c, internal } = fixture('v3');
    await c.newSession();
    let complete!: () => void;
    internal.send = async () => new Promise((resolve) => { complete = () => resolve({ stopReason: 'end_turn' }); });
    const stream = c.prompt('parent', 'hello');
    const first = stream.next();
    internal.dispatch({ method: 'session/update', params: { sessionId: 'parent', update: {
        sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_completion', elapsedTime: 5, promptTurnSummaries: [{ unit: 'credit', usage: 0.4 }] } },
    } } });
    internal.dispatch({ method: 'session/update', params: { sessionId: 'parent', update: {
        sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end' } },
    } } });
    let resolved = false; void first.then(() => { resolved = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    complete();
    assert.equal((await first).value?.totalCredits, 0.4);
    assert.equal((await stream.next()).value?.sessionUpdate, 'turn_end');
    await stream.return?.();
});

test('v3 persistent permission uses kind and exact triggering resource; unknown callbacks fail closed', async () => {
    const { c, internal } = fixture('v3');
    await c.newSession();
    const writes: any[] = [];
    internal.proc = { stdin: { destroyed: false, write: (text: string) => writes.push(JSON.parse(text)) } };
    internal.dispatch({ id: 10, method: 'session/request_permission', params: { sessionId: 'parent',
        options: [{ optionId: 'always-accept', kind: 'allow_always' }],
        _meta: { kiro: { consent: { capability: 'shell', resource: 'echo a', triggeringResource: 'echo a && echo b', workspaceRoot: '/tmp' } } },
    } });
    assert.throws(() => c.respondToPermission(10, 'allow'), /Unknown/);
    c.respondToPermission(10, 'always-accept');
    assert.equal(writes[0].result._meta.kiro.consent.resource, 'echo a && echo b');
    assert.equal(writes[0].result._meta.kiro.consent.scope, 'session');
    internal.dispatch({ id: 11, method: 'terminal/create', params: {} });
    assert.equal(writes[1].error.code, -32601);
});

test('v2 compact waits for its own completion notification, locks the session, and cleans up', async () => {
    const { c, internal } = fixture('v2');
    await c.newSession();
    internal.send = async () => ({ success: true, message: 'Compacting conversation...' });
    let done = false;
    const compact = c.compact('parent').then((result) => { done = true; return result; });
    const status = (sessionId: string, type: string) => internal.dispatch({
        method: '_kiro.dev/compaction/status', params: { sessionId, status: { type } },
    });
    status('parent', 'started');
    status('peer', 'completed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(done, false, 'command acknowledgement is not completion');
    assert.equal((await c.compact('parent')).success, false, 'cannot start overlapping compaction');
    await assert.rejects(c.forkSession('parent'), /active/);
    status('parent', 'completed');
    assert.equal((await compact).success, true);
    assert.equal(internal.sessionInFlight.size, 0);
    assert.equal(internal.compactions.size, 0);
    assert.equal(c.needsSessionRecovery('parent'), false);
});

test('v2 compact accepts a completion arriving before the command acknowledgement', async () => {
    const { c, internal } = fixture('v2');
    internal.send = async () => {
        internal.dispatch({ method: '_kiro.dev/compaction/status', params: { sessionId: 'parent', status: { type: 'completed' } } });
        return { success: true };
    };
    assert.equal((await c.compact('parent')).success, true);
});

test('v2 compact timeout quarantines the session and blocks subsequent prompts', async () => {
    const { c, internal } = fixture('v2');
    await c.newSession();
    internal.send = async () => ({ success: true });
    await assert.rejects(c.compact('parent', undefined, 10), /completion timed out/);
    assert.equal(c.needsSessionRecovery('parent'), true);
    await assert.rejects(c.prompt('parent', 'must not start').next(), /needs recovery/);
    assert.equal(internal.compactions.size, 0);
    assert.equal(internal.sessionInFlight.size, 0);
});

for (const failure of ['refused', 'failed', 'released', 'shutdown']) {
    test(`v2 compact ${failure} settles without leaking its session lock`, async () => {
        const { c, internal } = fixture('v2');
        internal.send = async () => ({ success: failure !== 'refused' });
        const compact = c.compact('parent');
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failure === 'refused') assert.equal((await compact).success, false);
        else {
            const rejected = assert.rejects(compact);
            if (failure === 'failed') internal.dispatch({ method: '_kiro.dev/compaction/status', params: {
                sessionId: 'parent', status: { type: 'failed', message: 'native failure' },
            } });
            if (failure === 'released') c.destroySession('parent');
            if (failure === 'shutdown') await c.shutdown();
            await rejected;
        }
        assert.equal(internal.compactions.size, 0);
        assert.equal(internal.sessionInFlight.size, 0);
    });
}

test('v3 compact uses the dedicated RPC and a queued prompt waits for its completion', async () => {
    const { c, internal } = fixture('v3');
    await c.newSession();
    const methods: string[] = [];
    let complete!: () => void;
    internal.send = async (method: string) => {
        methods.push(method);
        if (method === '_kiro/session/compact') return new Promise((resolve) => { complete = () => resolve({}); });
        return { stopReason: 'end_turn' };
    };
    const compact = c.compact('parent');
    const prompt = c.prompt('parent', 'continue');
    const next = prompt.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(methods, ['_kiro/session/compact']);
    complete();
    assert.equal((await compact).success, true);
    assert.equal((await next).value?.sessionUpdate, 'turn_end');
    await prompt.return?.();
    assert.deepEqual(methods, ['_kiro/session/compact', 'session/prompt']);
    assert.equal(internal.sessionInFlight.size, 0);
});

test('v3 compact immediately after done waits for native steer cleanup', async () => {
    const { c, internal } = fixture('v3');
    await c.newSession();
    let clear!: () => void;
    let compactionCalls = 0;
    internal.steeredSessions.add('parent');
    internal.send = async (method: string) => {
        if (method === 'session/prompt') return { stopReason: 'end_turn' };
        if (method === '_session/steer/clear') return new Promise((resolve) => { clear = () => resolve({ cleared: true }); });
        if (method === '_kiro/session/compact') compactionCalls++;
        return {};
    };
    const stream = c.prompt('parent', 'first');
    assert.equal((await stream.next()).value?.sessionUpdate, 'turn_end');
    const cleanup = stream.return?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const compact = c.compact('parent');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(compactionCalls, 0);
    clear();
    await cleanup;
    assert.equal((await compact).success, true);
    assert.equal(compactionCalls, 1);
    assert.equal(internal.sessionInFlight.size, 0);
});

for (const engine of ['v2', 'v3'] as const) {
    for (const clearSucceeds of [true, false]) {
        test(`${engine}: cancelled steer settles before reuse; clear=${clearSucceeds}`, async () => {
            const { c, internal } = fixture(engine);
            await c.newSession();
            let finishPrompt!: (result: any) => void;
            let finishSteer!: (result: any) => void;
            let cleared = 0;
            internal.notify = async () => {};
            internal.send = async (method: string) => {
                if (method === 'session/prompt') return new Promise((resolve) => { finishPrompt = resolve; });
                if (method === '_session/steer') return new Promise((resolve) => { finishSteer = resolve; });
                if (method === '_session/steer/clear') { cleared++; return { cleared: clearSucceeds }; }
                return {};
            };
            const stream = c.prompt('parent', 'hello');
            const terminal = stream.next();
            const steering = c.steer('parent', 'pending');
            await c.cancel('parent');
            finishPrompt({ stopReason: 'cancelled' });
            assert.equal((await terminal).value?.stopReason, 'cancelled');
            let finished = false;
            const cleanup = stream.return?.().then(() => { finished = true; });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(finished, false, 'late steer response must settle before releasing turn lock');
            finishSteer({ queued: true });
            assert.equal((await steering).queued, false);
            await cleanup;
            assert.equal(cleared, 1);
            assert.equal(c.needsSessionRecovery('parent'), !clearSucceeds);
            assert.equal(internal.sessionInFlight.has('parent'), false);
        });
    }

    test(`${engine}: an aborted queued consumer cannot clear active predecessor steering`, async () => {
        const { c, internal } = fixture(engine);
        await c.newSession();
        let finish!: (result: any) => void;
        internal.send = async () => new Promise((resolve) => { finish = resolve; });
        const stream = c.prompt('parent', 'first'); const first = stream.next();
        internal.cancelledPrompts.add('parent');
        internal.steeredSessions.add('parent');
        const abort = new AbortController(); abort.abort();
        for await (const _ of c.prompt('parent', 'never sent', [], abort.signal)) { /* drain cancelled consumer */ }
        assert.equal(internal.cancelledPrompts.has('parent'), true);
        assert.equal(internal.steeredSessions.has('parent'), true);
        internal.send = async () => ({ cleared: true });
        finish({ stopReason: 'cancelled' }); await first; await stream.return?.();
        assert.equal(internal.steeredSessions.has('parent'), false);
    });
}
