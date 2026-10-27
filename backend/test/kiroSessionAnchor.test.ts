import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import { initDb, closeDb } from '../src/services/db';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { michiTestHost } from './helpers/michiTestHost';
import { hostOwner, runOwner } from './helpers/owners';

test('v3 defaults to shared warm sessions with a stable MCP definition and per-turn context', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-anchor-unit-'));
    const oldDir = process.env.MICHI_DATA_DIR;
    const oldCustomAgents = process.env.MICHI_CUSTOM_AGENTS;
    const oldCloud = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_CUSTOM_AGENTS;
    process.env.MICHI_DATA_DIR = dir; initDb();
    const registry = new McpSlotRegistry();
    const clients: AcpClient[] = [];
    const definitions: unknown[] = [];
    const prompts: Array<{ sid: string; text: string }> = [];
    let group = '';
    let count = 0;
    t.mock.method(AcpClient.prototype, 'start', function(this: AcpClient) { clients.push(this); });
    t.mock.method(AcpClient.prototype, 'initialize', async () => {});
    t.mock.method(AcpClient.prototype, 'isAlive', () => true);
    t.mock.method(AcpClient.prototype, 'shutdown', async () => {});
    t.mock.method(AcpClient.prototype, 'cancel', async () => false);
    t.mock.method(AcpClient.prototype, 'newSession', async (servers: unknown[]) => {
        definitions.push(servers);
        const url = (servers[0] as { url: string }).url;
        if (url.includes('/mcp-session/')) group = url.split('/').at(-1)!;
        return { sessionId: `native-${++count}`, modes: { currentModeId: 'default', availableModes: [] } };
    });
    t.mock.method(AcpClient.prototype, 'loadSession', async (_sid: string, _cwd: string, servers: unknown[]) => {
        definitions.push(servers);
        group = (servers[0] as { url: string }).url.split('/').at(-1)!;
        return { modes: { currentModeId: 'default', availableModes: [] } };
    });
    t.mock.method(AcpClient.prototype, 'prompt', async function* (sid: string, text: string) {
        assert.equal(registry.resolveSessionSlot(group, sid)?.parentChatId, sid,
            'each prompt must activate its current routing group after recovery');
        prompts.push({ sid, text });
        yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } };
    });
    const bridge: AgentToolBridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null,
        agentRunToolsForSession: () => process.env.MICHI_CUSTOM_AGENTS === '1' ? { invoke: async () => ({}) } : null };
    const runtime = new KiroRuntime({ bridge, mcpSlots: registry, defaultCwd: dir, host: michiTestHost(), engine: 'v3' });
    try {
        await runtime.warm(dir);
        const warmSid = runtime.listWarmedSessions()[0]?.sid;
        assert.ok(warmSid);
        assert.equal(registry.getSessionGroupCatalog(group)?.agentRuns, undefined,
            'a present factory must not advertise disabled Custom Agents');
        const a = await runtime.newSession({ sessionId: 'node-a', cwd: dir });
        const b = await runtime.newSession({ sessionId: 'node-b', cwd: dir });
        assert.equal(a.nativeSessionId, warmSid);
        assert.equal(clients.length, 1, 'chats must reuse one ACP process');
        assert.notEqual(a.nativeSessionId, b.nativeSessionId);
        for (const definition of definitions) assert.deepEqual(definition, definitions[0]);
        assert.match(JSON.stringify(definitions[0]), /mcp-session/);
        await Promise.all([a, b].map(async session => { for await (const _ of session.send('hello')) { /* drain */ } }));
        assert.equal(prompts.length, 2);
        for (const prompt of prompts) {
            assert.ok(prompt.text.includes(`current ACP SessionID is ${JSON.stringify(prompt.sid)}`));
            assert.ok(prompt.text.includes('session_id'));
            assert.deepEqual((prompt.sid === a.nativeSessionId ? a : b).getHistory()[0], { role: 'user', content: 'hello' });
        }
        await runtime.releaseSession(a.id);
        assert.equal(runtime.getBinding(a.id), undefined);
        assert.equal(runtime.getBinding(b.id)?.nativeSessionId, b.nativeSessionId);
        sessionRegistry.registerSession(b);
        const oldGroup = group;
        assert.equal(await runtime.recoverSession(b.nativeSessionId!, dir), true);
        assert.notEqual(group, oldGroup, 'process replacement must create a new MCP group');
        assert.equal(registry.getSessionGroupCatalog(oldGroup), undefined);
        assert.equal(sessionRegistry.getSession(b.id), b);
        for await (const _ of b.send('after process recovery')) { /* drain */ }
        assert.equal(registry.resolveSessionSlot(group, b.nativeSessionId!), undefined);
        const quarantined = runtime.getClient(dir)!;
        t.mock.method(quarantined, 'needsSessionRecovery', () => true);
        for await (const _ of b.send('after cancel watchdog recovery')) { /* drain */ }
        assert.notEqual(runtime.getClient(dir), quarantined);
        assert.equal(registry.resolveSessionSlot(group, b.nativeSessionId!), undefined);
        const run = await runtime.newSession({ sessionId: 'attempt', cwd: dir,
            owner: runOwner('run', 'attempt') });
        assert.equal(clients.length, 4, 'Run Attempts retain their isolated tool profiles after two chat recoveries');
        assert.equal(hostOwner(runtime.getBinding(run.id)!.owner).kind, 'agent_run');
        assert.equal(runtime.getBinding(b.id)?.nativeSessionId, b.nativeSessionId);
        assert.equal(runtime.activeProcessCount, 2, 'shared chat process and isolated Run both count toward the cap');
        (runtime as any).processCap = 2;
        await assert.rejects(runtime.ensureClient(path.join(dir, 'another-cwd')), /process cap/i);
        await assert.rejects(runtime.newSession({ sessionId: 'another-attempt', cwd: dir,
            owner: runOwner('run', 'another-attempt') }), /process cap/i);
        process.env.MICHI_CUSTOM_AGENTS = '1';
        const enabled = new KiroRuntime({ bridge, mcpSlots: registry, defaultCwd: dir, host: michiTestHost(), engine: 'v3', customAgents: () => true });
        try {
            await enabled.warm(dir);
            assert.ok(registry.getSessionGroupCatalog(group)?.agentRuns,
                'enabled Custom Agents must be present in the stable warm catalog');
        } finally { await enabled.shutdown(); }
    } finally {
        await runtime.shutdown(); closeDb();
        if (oldDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldDir;
        if (oldCustomAgents === undefined) delete process.env.MICHI_CUSTOM_AGENTS; else process.env.MICHI_CUSTOM_AGENTS = oldCustomAgents;
        if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
