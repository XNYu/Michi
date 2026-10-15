/** Opt-in, real authenticated validation of default Kiro v3 routing.
 * All Michi data and tool effects live in a temporary directory.
 * Does not modify global CLI config. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AgentSession } from '../src/agents/types';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AcpClient } from '../src/services/acpClient';

if (process.env.MICHI_KIRO_ANCHOR_LIVE !== '1') throw new Error('Set MICHI_KIRO_ANCHOR_LIVE=1 to use real Kiro');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-anchor-live-')));
const output = path.resolve(process.env.MICHI_KIRO_ANCHOR_OUTPUT ?? root);
fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, { MICHI_DATA_DIR: root, MICHI_TITLE_MODEL_KIRO: 'off' });
delete process.env.MICHI_CLOUD;
const { initDb, closeDb } = require('../src/services/db') as typeof import('../src/services/db');
const repo = require('../src/services/dbRepository') as typeof import('../src/services/dbRepository');
const { McpSlotRegistry, mountMcp } = require('../src/services/mcpServer') as typeof import('../src/services/mcpServer');
const { KiroRuntime: Runtime } = require('../src/agents/kiro/KiroRuntime') as typeof import('../src/agents/kiro/KiroRuntime');
initDb();
repo.saveWorkspace({ id: 'anchor-live', name: 'Disposable session-anchor experiment', cwd: root, created_at: 1, updated_at: 1 });
const registry = new McpSlotRegistry();
const requests: Array<{ url: string; method: string; name?: string; arguments?: any }> = [];
const effects: Array<Record<string, any>> = [];
const turns: Array<Record<string, any>> = [];
const timings: Array<Record<string, any>> = [];
const app = express(); app.use(express.json());
app.use((req, _res, next) => {
    if (req.body?.method) requests.push({ url: req.path, method: req.body.method,
        name: req.body.params?.name, arguments: req.body.params?.arguments });
    next();
});
const router = express.Router(); mountMcp(router, registry); app.use('/api', router);
const server = app.listen(0, '127.0.0.1');
const bridge = {
    spawnBranches: async (args: any) => {
        effects.push({ tool: 'spawn_branches', ...args });
        return args.topics.map((topic: any) => ({ ...topic, chatId: randomUUID(), nodeId: randomUUID() }));
    },
    saveContext: (args: any) => {
        effects.push({ tool: 'save_artifact', ...args });
        const filePath = path.join(root, `${args.name}.md`);
        fs.writeFileSync(filePath, args.body);
        return { name: args.name, filePath, size: Buffer.byteLength(args.body) };
    },
    updateContext: () => null,
};
const model = process.env.MICHI_KIRO_ANCHOR_MODEL ?? 'claude-opus-5.5';
let runtime: KiroRuntime | undefined;
let unused: { sid: string; slotId?: string } | undefined;
let passed = false;
const watchdog = setTimeout(() => {
    console.error('LIVE watchdog elapsed');
    void runtime?.shutdown();
}, 600_000);
function nativeInfo(client?: AcpClient) {
    return { pid: (client as any)?.proc?.pid, agent: (client as any)?.initialization?.agentInfo };
}
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const value = await work();
    const entry = { label, ms: Math.round(performance.now() - start) };
    timings.push(entry); console.info(`LIVE timing ${JSON.stringify(entry)}`);
    return value;
}
function node(id: string, parent?: string) {
    repo.saveNode({ id, workspace_id: 'anchor-live', parent_node_id: parent ?? null,
        kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0,
        runtime_id: 'kiro', created_at: 1 });
}
function bind(session: AgentSession) {
    repo.updateNodeResumeBinding(session.id, { acp_session_id: session.nativeSessionId!, runtime_id: 'kiro', runtime_engine: 'v3', model_id: model });
}
async function answer(session: AgentSession, marker: string, opts?: { branch?: boolean; cancel?: boolean }) {
    const start = performance.now();
    const record: Record<string, any> = { marker, nodeId: session.id, nativeId: session.nativeSessionId,
        events: [], mcpErrors: [], text: '' };
    turns.push(record);
    const before = effects.length;
    const prompt = opts?.cancel
        ? 'Write a long implementation plan for a fictional project with ten detailed phases. Do not use tools except the required Michi metadata.'
        : `Use the Michi MCP save_artifact tool to save a fictional note with name ${marker} and body ${marker}. `
            + (opts?.branch ? `Then call Michi spawn_branches with one topic titled ${marker} and prompt "Discuss fictional ${marker}". ` : '')
            + `Record branch overview mentioning ${marker}, then answer briefly. Actual MCP calls are required. Do not use file, shell, web, or other external tools.`;
    let cancelled = false;
    for await (const event of session.send(prompt)) {
        record.events.push(event.kind);
        if (['chunk', 'tool_call'].includes(event.kind) && record.firstActivityMs === undefined) {
            record.firstActivityMs = Math.round(performance.now() - start);
        }
        if (event.kind === 'mcp_server_error') record.mcpErrors.push({ server: event.serverName, error: event.error });
        if (event.kind === 'turn_end') record.stopReason = event.stopReason;
        if (event.kind === 'chunk') record.text += event.text;
        if (event.kind === 'permission_request') {
            const option = event.options.find(o => o.kind === 'allow_once');
            if (/michi|branch.overview/i.test(event.title) && option) session.respondToPermission?.(event.requestId, option.optionId);
            else session.cancelPermission?.(event.requestId);
        }
        if (event.kind === 'user_input_request') session.skipUserInput?.(event.requestId);
        if (event.kind === 'runtime_error') throw new Error(event.error);
        if (opts?.cancel && !cancelled && event.kind === 'chunk') { cancelled = true; record.cancelAck = await session.cancel(); }
    }
    record.durationMs = Math.round(performance.now() - start);
    if (opts?.cancel) {
        assert.ok(cancelled);
        assert.ok(record.events.includes('turn_end'));
        assert.equal(record.stopReason, 'cancelled', 'cancel must settle as a cancelled turn');
    } else {
        assert.ok(record.events.includes('artifact_saved'), `${marker}: artifact callback missing`);
        assert.ok(record.events.includes('branch_overview'), `${marker}: overview callback missing`);
        const saves = effects.slice(before).filter(e => e.tool === 'save_artifact' && e.name === marker);
        assert.equal(saves.length, 1);
        assert.equal(saves[0].chatId, session.nativeSessionId, `${marker}: artifact attributed to wrong session`);
        assert.equal(fs.readFileSync(path.join(root, `${marker}.md`), 'utf8'), marker);
        if (opts?.branch) {
            assert.ok(record.events.includes('spawn_branches'));
            const spawn = effects.slice(before).find(e => e.tool === 'spawn_branches' && e.topics[0]?.title === marker);
            assert.equal(spawn?.parentChatId, session.id, `${marker}: branch callback used wrong parent`);
        }
    }
    console.info(`LIVE turn passed ${marker} node=${session.id} events=${record.events.join(',')}`);
}

async function main() {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const options = { cwd: root, workspaceId: 'anchor-live', enableFollowUps: false, model };
    try {
        runtime = new Runtime(bridge, registry, port, root, undefined, { engine: 'v3' });
        await timed('anchor_real_warm', () => runtime!.warm(root, { model }));
        const firstWarm = runtime.listWarmedSessions()[0]?.sid;
        assert.ok(firstWarm);
        node('anchor-a'); node('anchor-b');
        const a = await timed('anchor_new_A', () => runtime!.newSession({ ...options, sessionId: 'anchor-a' })); bind(a);
        const b = await timed('anchor_new_B', () => runtime!.newSession({ ...options, sessionId: 'anchor-b' })); bind(b);
        assert.equal(a.nativeSessionId, firstWarm, 'must consume the actual prewarmed session');
        assert.equal(runtime.activeProcessCount, 1);
        console.info(`LIVE anchored process ${JSON.stringify(nativeInfo(runtime.getClient(root)))}`);
        if (process.env.MICHI_KIRO_ANCHOR_CONNECTION_ONLY === '1') {
            const target = Math.max(1, parseInt(process.env.MICHI_KIRO_WARM_POOL_SIZE ?? '3', 10));
            await timed('anchor_wait_full_pool', async () => {
                while (runtime!.listWarmedSessions().length < target) await runtime!.warm(root, { model });
            });
            for (let i = 0; i < target; i++) {
                const id = `ready-${i}`;
                node(id);
                await timed(`anchor_ready_${i}`, () => runtime!.newSession({ ...options, sessionId: id }));
            }
            passed = true;
            console.info('LIVE ALL CONNECTION CHECKS PASSED');
            return;
        }
        await answer(a, 'AnchorAlpha', { branch: true });
        await answer(b, 'AnchorBeta', { branch: true });
        const newCount = requests.filter(r => r.method === 'initialize').length;
        unused = runtime.consumeWarmedSession(root);
        await runtime.warm(root, { model });
        assert.ok(unused && runtime.listWarmedSessions().length > 0, 'unused warm sessions must coexist');
        assert.equal(requests.filter(r => r.method === 'initialize').length, newCount, 'warm refill must reuse the existing MCP connection');
        await answer(a, 'AfterUnusedWarm');
        await Promise.all([answer(a, 'ParallelAlpha'), answer(b, 'ParallelBeta')]);
        await runtime.releaseSession(b.id);
        const resumed = await timed('anchor_load_B', () => runtime!.loadSession({ ...options,
            sessionId: b.nativeSessionId!, nodeId: b.id, nativeEngine: 'v3' }));
        assert.equal(resumed.nativeSessionId, b.nativeSessionId);
        await answer(resumed, 'ResumedBeta');
        node('anchor-child', a.id);
        const child = await timed('anchor_fork_A', () => runtime!.forkSession({ ...options,
            sessionId: 'anchor-child', parentChatId: a.id, sourceNativeSessionId: a.nativeSessionId! })); bind(child);
        assert.notEqual(child.nativeSessionId, a.nativeSessionId);
        await answer(child, 'ForkedChild');
        await answer(a, 'CancelledTurn', { cancel: true });
        await answer(a, 'AfterCancelAlpha');
        const expected = new Map(turns.filter(t => t.marker !== 'CancelledTurn').map(t => [t.marker, t.nativeId]));
        const calls = requests.filter(r => r.method === 'tools/call' && r.url.includes('/mcp-session/'));
        assert.ok(calls.length >= expected.size * 2);
        assert.equal(new Set(calls.map(r => r.url)).size, 1, 'every chat must use the same MCP URL');
        for (const call of calls) {
            if (call.name === 'save_artifact') assert.equal(call.arguments.session_id, expected.get(call.arguments.name));
            assert.equal(typeof call.arguments.session_id, 'string');
        }
        passed = true;
        console.info('LIVE ALL ANCHOR CHECKS PASSED');
    } finally {
        clearTimeout(watchdog);
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed, model, root,
            timings, turns, effects, requests, native: nativeInfo(runtime?.getClient(root)) }, null, 2));
        if (unused) {
            runtime?.getClient(root)?.destroySession(unused.sid);
            if (unused.slotId) await registry.dispose(unused.slotId);
        }
        await runtime?.shutdown();
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        closeDb();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
