import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError } from '../src/services/acpClient';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

const config = [
    { id: 'mode', type: 'select', currentValue: 'vibe', options: [{ value: 'vibe' }, { value: 'plan' }] },
    { id: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1' }, { value: 'm2' }] },
    { id: 'effortLevel', type: 'select', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
];
function fixture() {
    const c = new AcpClient('/bin/false', '/tmp', undefined, 'v3');
    const internal = c as any;
    const calls: any[] = [];
    internal.initialization = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} },
        _meta: { kiro: { extensionMethods: ['_kiro/session/context'] } } } };
    internal.send = async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'session/new') return { sessionId: 'sid', configOptions: config };
        if (method === 'session/list') return { sessions: [{ sessionId: 'sid', cwd: '/tmp' }] };
        if (method === 'session/set_config_option') return { configOptions: config.map((c) => c.id === params.configId ? { ...c, currentValue: params.value } : c) };
        return { stopReason: 'end_turn' };
    };
    const update = (value: unknown) => internal.dispatch({ method: 'session/update', params: { sessionId: 'sid', update: value } });
    const mcp = (status: string) => internal.dispatch({ method: '_kiro/mcp/status', params: {
        sessionId: 'sid', servers: [{ name: 'test', status, errorMessage: 'Authorization failed', failedAuthorization: true }],
    } });
    return { c, internal, update, mcp, calls };
}

test('pre-new snapshots and inter-turn MCP state survive draining without cancelled text', async () => {
    const { c, internal, update, mcp } = fixture();
    const send = internal.send;
    internal.send = async (method: string, params: any) => {
        if (method === 'session/new') {
            update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'context', description: 'Latest context' }, { name: 'unsupported' }] });
            mcp('failed');
        }
        return send(method, params);
    };
    await c.newSession();
    c.injectUpdate('sid', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE' } });
    const events = [];
    const runtime = { engine: 'v3', ensureClient: async () => c, getClient: () => c } as unknown as KiroRuntime;
    for await (const event of new KiroSession('node', 'sid', runtime, '/tmp').send('hello')) events.push(event);
    const state = events.find((event) => event.kind === 'session_state');
    assert.ok(state?.kind === 'session_state');
    assert.ok(state.state.commands?.some((c) => c.name === 'context' && c.description === 'Latest context'));
    assert.ok(!state.state.commands?.some((c) => c.name === 'unsupported'));
    assert.deepEqual(state.state.mcpErrors, [{ serverName: 'test', error: 'Authorization failed' }]);
    assert.ok(!events.some((event) => event.kind === 'chunk'));
    mcp('connected'); assert.deepEqual(c.getSessionState('sid').mcpErrors, []);
    mcp('failed'); assert.equal(c.getSessionState('sid').mcpErrors?.length, 1);
    const second = [];
    for await (const event of c.prompt('sid', 'again')) second.push(event);
    assert.equal(second[0].state.mcpErrors[0].error, 'Authorization failed');
});

test('load retains snapshots while dropping replay text and updates observers', async () => {
    const { c, internal, update, mcp } = fixture();
    const send = internal.send;
    internal.send = async (method: string, params: any) => {
        if (method === 'session/load') {
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HISTORY' }, _meta: { kiro: { replay: true } } });
            update({ sessionUpdate: 'config_option_update', configOptions: config });
            mcp('failed');
            return {}; // load need not return sessionId or repeat config
        }
        return send(method, params);
    };
    await c.loadSession('sid', '/tmp');
    const states: unknown[] = [];
    const stop = c.onSessionState('sid', () => states.push(c.getSessionState('sid')));
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    assert.equal(c.getSessionInfo('sid')?.modes.currentModeId, 'plan');
    assert.equal(states.length, 1);
    const events = [];
    for await (const event of c.prompt('sid', 'continue')) events.push(event);
    assert.deepEqual(events.map((e) => e.sessionUpdate), ['session_state', 'turn_end']);
    stop(); mcp('connected'); assert.equal(states.length, 1);
});

for (const order of ['mode-first', 'config-first']) test(`latest config wins in ${order} order`, async () => {
    const { c, update } = fixture(); await c.newSession();
    const mode = () => update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    const configUpdate = () => update({ sessionUpdate: 'config_option_update', configOptions: config.map((option) => option.id === 'model' ? { ...option, currentValue: 'm2' } : option) });
    if (order === 'mode-first') { mode(); configUpdate(); } else { configUpdate(); mode(); }
    const state = c.getSessionState('sid');
    assert.equal(state.currentModeId, order === 'mode-first' ? 'vibe' : 'plan');
    assert.equal(state.modelId, 'm2');
});

test('V3 effort and tools use session configuration and tool snapshots', async () => {
    const { c, internal, calls } = fixture(); await c.newSession();
    assert.equal((await c.executeCommand('sid', 'effort', { value: 'high' })).success, true);
    assert.equal(c.getSessionState('sid').reasoning, 'high');
    assert.equal((await c.executeCommand('sid', 'effort', { value: 'invented' })).success, false);
    internal.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 'sid', tools: [{ name: 'read' }] } });
    assert.deepEqual((await c.executeCommand('sid', 'tools')).data, [{ name: 'read' }]);
    assert.ok(!calls.some((call) => call.method === 'session/prompt'));
});

test('reduced capabilities block unadvertised methods; compatibility failures are remembered', async () => {
    const { c, internal, calls } = fixture(); await c.newSession();
    internal.initialization.agentCapabilities._meta.kiro.extensionMethods = [];
    assert.equal((await c.executeCommand('sid', 'context')).success, false);
    assert.ok(!calls.some((call) => call.method === '_kiro/session/context'));
    let usage = 0;
    internal.send = async () => { usage++; throw new ACPError('Method not found', { rpcCode: -32601 }); };
    for (let i = 0; i < 2; i++) assert.equal((await c.executeCommand('sid', 'usage')).success, false);
    assert.equal(usage, 1, 'probe only the explicitly supported compatibility exception');
    assert.equal(c.supportsExtension('_kiro/account/getUsage'), false);
    assert.equal(c.supportsExtension('_session/steer'), true);
});
