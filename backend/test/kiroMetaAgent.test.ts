import { restrictedChatProfile } from './helpers/restrictedChatProfile';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { michiKiroRestrictedAgent } from '../src/agents/kiro/kiroMetaAgent';
/**
 * The Meta agent on Kiro: the generated agent config, catalog normalization
 * and checks for both engines, and AcpAgentRuntime opening a per-toolset worker,
 * shared by that toolset's sessions, whose sessions are each selected,
 * checked and locked. kiro-cli is replaced by an
 * AcpClient whose RPCs are scripted; no real process runs.
 */

import { afterEach, beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import {
    KIRO_META_AGENT_NAMES, ensureKiroMetaAgent, kiroMetaAgentClientOptions, kiroMetaAgentConfig, kiroMetaAgentDir,
    kiroV2MetaAgentCatalog, kiroV3MetaAgentCatalog, verifyKiroMetaAgentCatalog,
} from '../src/agents/kiro/kiroMetaAgent';
import { KiroProcessCapError, AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { MetaAgentGuardError, isMetaAgentGuardError } from '../src/agents/metaAgentGuard';
import { META_AGENT_MAINTENANCE_TOOL_NAMES, MaintenanceRuntimeUnsupportedError, maintenanceToolProfile } from '../src/agents/maintenancePolicy';
import { AssistantRuntimeUnsupportedError, META_AGENT_CHAT_TOOL_NAMES, assistantToolProfile } from '../src/assistant/policy';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { closeDb, initDb } from '../src/services/db';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
const michi = (names: readonly string[]) => names.map((name) => ({ source: 'mcp', tag: `@michi/${name}` }));

describe('the generated Kiro agent', () => {
    let dataDir: string;
    beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-meta-')); });
    afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    test('only Michi\'s toolset tools: no built-ins, no user MCP config, no resources, hooks or fs_read', () => {
        const config = kiroMetaAgentConfig('chat', ['read_node', 'list_threads']) as any;
        assert.equal(config.name, KIRO_META_AGENT_NAMES.chat);
        assert.match(config.prompt, /^You are Michi\./);
        assert.deepEqual(config.tools, ['@michi']);
        assert.deepEqual(config.allowedTools, ['@michi/read_node', '@michi/list_threads']);
        assert.deepEqual(config.mcpServers, {});
        assert.equal(config.includeMcpJson, false);
        assert.deepEqual(config.resources, []);
        assert.deepEqual(config.hooks, []);
        assert.deepEqual(config.permissions, { rules: [{ capability: 'mcp', match: ['michi/read_node', 'michi/list_threads'], effect: 'allow' }] });
        assert.doesNotMatch(JSON.stringify(config), /fs_read|fs_write|shell|@builtin|"\*"/);
    });

    test('one directory per toolset inside a .michi folder, rewritten only when the tools change', () => {
        const chat = ensureKiroMetaAgent(dataDir, 'chat', ['read_node']);
        const maintenance = ensureKiroMetaAgent(dataDir, 'maintenance', ['maintenance_no_change']);
        assert.notEqual(chat.dir, maintenance.dir);
        assert.equal(chat.dir, kiroMetaAgentDir(dataDir, 'chat'));
        assert.ok(chat.dir.startsWith(path.resolve(dataDir)) && chat.dir.split(path.sep).includes('.michi'));
        assert.equal(kiroMetaAgentDir(path.join(dataDir, '.michi'), 'chat'), path.join(dataDir, '.michi', 'meta-agent', 'kiro', 'chat'));
        const file = path.join(chat.dir, '.kiro', 'agents', `${chat.agentName}.json`);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allowedTools, ['@michi/read_node']);
        const stamp = new Date(2000, 0, 1);
        fs.utimesSync(file, stamp, stamp);
        ensureKiroMetaAgent(dataDir, 'chat', ['read_node']);
        assert.equal(fs.statSync(file).mtimeMs, stamp.getTime(), 'an unchanged config is not rewritten');
        ensureKiroMetaAgent(dataDir, 'chat', ['read_node', 'read_page']);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).allowedTools, ['@michi/read_node', '@michi/read_page']);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${chat.agentName}.json`], 'no temp file is left');
    });

    test('kiro-cli selects it on v2, preserves the environment on v3 and rejects permission requests', () => {
        const v2 = kiroMetaAgentClientOptions('v2', 'michi-meta-agent-chat', { HOME: '/h' });
        assert.deepEqual(v2, { extraArgs: ['--agent', 'michi-meta-agent-chat'], childEnv: { HOME: '/h' }, rejectPermissions: true });
        const v3 = kiroMetaAgentClientOptions('v3', 'michi-meta-agent-chat', { HOME: '/h', MICHI_KIRO_PRELOAD_TOOLS: 'false' });
        assert.deepEqual(v3.extraArgs, [], 'v3 rejects --agent');
        assert.deepEqual(v3.childEnv, { HOME: '/h', MICHI_KIRO_PRELOAD_TOOLS: 'false' });
        assert.equal(v3.rejectPermissions, true);
    });
});

describe('Kiro catalogs', () => {
    test('v2: Michi tools by name, anything else by source; no list fails closed', () => {
        assert.deepEqual(kiroV2MetaAgentCatalog({ data: { tools: [
            { name: 'read_node', source: 'mcp:michi' }, { name: 'shell', source: 'built-in' }, { name: 'post', source: 'mcp:slack' },
        ] } }), ['read_node', 'built-in:shell', 'mcp:slack:post']);
        assert.deepEqual(kiroV2MetaAgentCatalog({ success: true }), ['(no tool list)']);
    });

    test('v3: @michi/<tool> tags by tool name; builtin and other MCP tags stay visible', () => {
        assert.deepEqual(kiroV3MetaAgentCatalog([
            { source: 'mcp', tag: '@michi/read_node' }, { source: 'builtin', tag: 'read' },
            { source: 'mcp', tag: '@example-tools/get' }, { source: 'mcp', tag: '@michi' },
        ]), ['read_node', 'builtin:read', 'mcp:@example-tools/get', 'mcp:@michi']);
    });
});

interface Script {
    engine: 'v2' | 'v3';
    /** v3: tags Kiro publishes after session/set_mode. */
    tagsAfterMode?: unknown[][];
    /** v3: tags of the default agent, published right after session/new. */
    tagsAfterNew?: unknown[];
    /** v2: the tools command answer. */
    v2Tools?: unknown[];
    /** v2: whether Michi's MCP server reports initialized. */
    v2MichiReady?: boolean;
    currentModeId?: string;
    setModeError?: string;
}

function scriptedClient(script: Script) {
    const client = new AcpClient('/bin/false', '/tmp/meta', undefined, script.engine) as any;
    const calls: Array<{ method: string; params: any }> = [];
    let sid = 0;
    client.initialization = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: true } } };
    client.isAlive = () => true;
    client.shutdown = async () => {};
    client.cancel = async (id: string) => { calls.push({ method: 'session/cancel', params: { sessionId: id } }); return true; };
    const publish = (sessionId: string, tags: unknown[]) => client.dispatch({ method: '_kiro/tools/didChange', params: { sessionId, tags } });
    client.send = async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'session/new' || method === 'session/load') {
            const sessionId = method === 'session/new' ? `sid-${sid++}` : params.sessionId;
            // Real v3 publishes the default agent's catalog before answering session/new.
            if (script.engine === 'v3' && script.tagsAfterNew) publish(sessionId, script.tagsAfterNew);
            setImmediate(() => {
                if (script.engine === 'v2' && script.v2MichiReady !== false) {
                    client.dispatch({ method: '_kiro.dev/mcp/server_initialized', params: { sessionId, serverName: 'michi' } });
                }
            });
            return { ...(method === 'session/new' ? { sessionId } : {}), modes: { currentModeId: script.currentModeId ?? 'kiro_default' } };
        }
        if (method === 'session/set_mode') {
            if (script.setModeError) throw new Error(script.setModeError);
            let delay = 5;
            for (const tags of script.tagsAfterMode ?? []) { setTimeout(() => publish(params.sessionId, tags), delay); delay += 5; }
            return {};
        }
        if (method === 'session/list') return { sessions: [{ sessionId: 'sid-old', cwd: params.cwd }] };
        if (method === '_kiro.dev/commands/execute') return { success: true, data: { tools: script.v2Tools ?? [] } };
        return {};
    };
    return { client: client as AcpClient, calls, publish };
}

function makeRegistry() {
    const slots = new Map<string, any>();
    let next = 0;
    return {
        slots,
        get: (id: string) => slots.get(id),
        dispose: async (id: string) => { slots.delete(id); },
        create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: any, opts?: any) => {
            const slot = { slotId: `slot-${next++}`, parentChatId, cwd, ownerUserId, ...cbs, ...opts };
            slots.set(slot.slotId, slot);
            return slot;
        },
    };
}

describe('verifyKiroMetaAgentCatalog', () => {
    const run = async (script: Script, profile = restrictedChatProfile(), timeoutMs = 2_000) => {
        const { client } = scriptedClient(script);
        const { sessionId } = await client.newSession([]);
        const since = client.toolCatalog(sessionId)?.seq ?? 0;
        if (script.engine === 'v3') await client.setMode(sessionId, KIRO_META_AGENT_NAMES.chat);
        return verifyKiroMetaAgentCatalog({ client, sessionId, engine: script.engine, runtimeId: 'kiro', profile, sinceSeq: since, timeoutMs, settleMs: 50 });
    };

    test('v3: the settled catalog after the switch, with only Michi tools, passes', async () => {
        const observed = await run({ engine: 'v3', tagsAfterNew: [{ source: 'builtin', tag: 'shell' }], tagsAfterMode: [[], michi(['read_node', 'list_threads'])] });
        assert.deepEqual(observed, ['read_node', 'list_threads']);
    });

    test('v3: one extra tag, builtin or not in the toolset, throws MetaAgentGuardError', async () => {
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [[...michi(['read_node']), { source: 'builtin', tag: 'read' }]] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'builtin:read');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [michi(['read_node', 'send_to_thread'])] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'send_to_thread');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [michi(['read_node']), [...michi(['read_node']), { source: 'mcp', tag: '@example-tools/x' }]] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'mcp:@example-tools/x',
            'a later catalog before it settles counts');
    });

    test('v3: no catalog after the switch fails closed within the timeout', async () => {
        await assert.rejects(run({ engine: 'v3', tagsAfterNew: michi(['read_node']), tagsAfterMode: [] }, restrictedChatProfile(), 100),
            (error: unknown) => isMetaAgentGuardError(error) && /no tool catalog/.test((error as Error).message),
            'the default agent\'s catalog from before the switch is not accepted');
        await assert.rejects(run({ engine: 'v3', tagsAfterMode: [[]] }, restrictedChatProfile(), 150),
            (error: unknown) => isMetaAgentGuardError(error) && /none of the Michi tools/.test((error as Error).message));
    });

    test('v2: the tools command lists only Michi tools, or the run fails', async () => {
        assert.deepEqual(await run({ engine: 'v2', v2Tools: [{ name: 'read_node', source: 'mcp:michi' }] }), ['read_node']);
        await assert.rejects(run({ engine: 'v2', v2Tools: [{ name: 'read_node', source: 'mcp:michi' }, { name: 'fs_read', source: 'built-in' }] }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.unexpectedTools.join() === 'built-in:fs_read');
        await assert.rejects(run({ engine: 'v2', v2Tools: [], v2MichiReady: false }, restrictedChatProfile(), 100),
            (error: unknown) => isMetaAgentGuardError(error) && /none of the Michi tools/.test((error as Error).message));
    });

});

describe('AcpAgentRuntime Meta agent sessions', () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-meta-rt-'));
        process.env.MICHI_DATA_DIR = tmpDir;
        closeDb();
        initDb();
    });
    afterEach(() => {
        closeDb();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function setup(t: TestContext, script: Script, ordinary = false) {
        const scripted = scriptedClient(script);
        const opened: Array<{ cwd: string; options: unknown; runtime: any }> = [];
        t.mock.method(AcpAgentRuntime.prototype, 'ensureClient', async function (this: any, cwd: string) {
            if (!ordinary && !this.runtimeOptions.metaAgent) throw new Error('an ordinary client was asked for');
            opened.push({ cwd, options: this.clientOptions(), runtime: this });
            this.pool.set(cwd, scripted.client);
            return scripted.client;
        });
        const registry = makeRegistry();
        const runtime = new AcpAgentRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(registry as any, { mcpPort: 9999 }), defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({ engine: script.engine, sidecarTitles: false }) });
        t.after(() => runtime.shutdown());
        return { ...scripted, registry, runtime, opened };
    }

    test('interactive Assistant accepts the ordinary Kiro catalog', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterNew: [
            { source: 'builtin', tag: 'shell' },
        ] }, true);
        const session = await env.runtime.newSession({ sessionId: 'n-chat-open', cwd: tmpDir, toolProfile: assistantToolProfile() });
        assert.equal((session as any).cwd, tmpDir);
        assert.ok(!env.calls.some((call) => call.method === 'session/set_mode'));
        assert.equal(env.opened[0].options, undefined);
        assert.equal([...env.registry.slots.values()][0].restricted, undefined);
    });

    test('resuming an old restricted Assistant reconstructs history instead of retaining the closed agent', async (t) => {
        const env = setup(t, { engine: 'v3', currentModeId: KIRO_META_AGENT_NAMES.chat }, true);
        await assert.rejects(env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-old-open', nativeEngine: 'v3', cwd: tmpDir, toolProfile: assistantToolProfile() }), /retired restricted profile/);
        assert.equal(env.registry.slots.size, 0);
    });

    test('a chat session runs in its own kiro-cli and agent directory, selected and checked before it is returned', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterNew: [{ source: 'builtin', tag: 'shell' }], tagsAfterMode: [[], michi(['read_node', 'list_threads'])] });
        const session = await env.runtime.newSession({ sessionId: 'n-chat', cwd: '/home/u/assistant', toolProfile: restrictedChatProfile() }) as any;
        const dir = kiroMetaAgentDir(tmpDir, 'chat');
        assert.equal(env.opened.length, 1);
        assert.equal(env.opened[0].cwd, dir, 'never the chat\'s own cwd or the shared pool');
        assert.deepEqual(env.opened[0].options, kiroMetaAgentClientOptions('v3', KIRO_META_AGENT_NAMES.chat));
        assert.ok(fs.existsSync(path.join(dir, '.kiro', 'agents', `${KIRO_META_AGENT_NAMES.chat}.json`)));
        const methods = env.calls.map((call) => call.method);
        assert.ok(methods.indexOf('session/new') < methods.indexOf('session/set_mode'));
        assert.equal(env.calls.find((call) => call.method === 'session/set_mode')!.params.modeId, KIRO_META_AGENT_NAMES.chat);
        const server = env.calls.find((call) => call.method === 'session/new')!.params.mcpServers[0];
        assert.deepEqual(server.headers, [], 'Kiro HTTP MCP entries need headers: []');
        const slot = [...env.registry.slots.values()][0];
        assert.equal(slot.restricted, true);
        assert.equal(slot.maintenance, undefined);
        assert.deepEqual([...slot.exposedToolNames].sort(), [...META_AGENT_CHAT_TOOL_NAMES].sort());
        assert.equal(slot.isServing(), true);
        assert.equal(slot.parentChatId, session.nativeSessionId);
        assert.equal(session.cwd, dir);
        assert.ok(env.runtime.getBinding('n-chat'));
        assert.equal(session.getEnableFollowUps(), false);

        await assert.rejects(async () => { for await (const _ of session.send('/agent swap kiro_default')) { /* none */ } }, /commands are off/);
        assert.deepEqual(await session.executeCommand('agent', { value: 'kiro_default' }), { success: false, message: 'Kiro commands are off for the Meta agent.' });
        await assert.rejects(session.setMode('kiro_default'), /cannot switch/);
        await assert.rejects(env.runtime.forkSession({ sessionId: 'n-fork', cwd: '/x', sourceNativeSessionId: 's', toolProfile: restrictedChatProfile() }),
            NativeResumeUnavailableError);

        // A later catalog with a built-in stops its tools, cancels the turn and fails the next send.
        env.publish(session.nativeSessionId, [...michi(['read_node']), { source: 'builtin', tag: 'write' }]);
        assert.equal(slot.isServing(), false);
        assert.ok(env.calls.some((call) => call.method === 'session/cancel'));
        await assert.rejects(async () => { for await (const _ of session.send('hello')) { /* none */ } }, MetaAgentGuardError);
    });


    test('a catalog with one extra tool refuses the session, releases its slot and stops its kiro-cli', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterMode: [[...michi(['read_node']), { source: 'builtin', tag: 'read' }]] });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-bad', cwd: '/x', toolProfile: restrictedChatProfile() }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.runtimeId === 'kiro'
                && error.violation.toolset === 'chat' && error.violation.unexpectedTools.join() === 'builtin:read');
        assert.equal(env.registry.slots.size, 0);
        assert.equal((env.runtime as any).sessionWorkers.size, 0);
        assert.equal(env.opened[0].runtime.closing, true, 'its worker, and so its kiro-cli, is shut down');
        assert.equal(env.runtime.getBinding('n-bad'), undefined);
    });

    test('fresh, repeated and restored chat turns contain no title, follow-up or overview instructions', async (t) => {
        const env = setup(t, { engine: 'v3', tagsAfterMode: [michi(['read_node'])] });
        const fresh = await env.runtime.newSession({ sessionId: 'n-plain-replies', cwd: '/x', toolProfile: restrictedChatProfile(), enableFollowUps: true });
        for (const message of ['Summarize this page.', 'What changed?']) {
            for await (const _event of fresh.send(message)) { /* drain */ }
        }
        const restored = await env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-restored-replies', nativeEngine: 'v3', cwd: '/x', toolProfile: restrictedChatProfile(), enableFollowUps: true });
        for await (const _event of restored.send('Continue.')) { /* drain */ }
        const prompts = env.calls.filter((call) => call.method === 'session/prompt').map((call) =>
            call.params.prompt.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n'));
        assert.equal(prompts.length, 3);
        assert.match(prompts[0], /^You are Michi,/);
        for (const prompt of prompts) {
            assert.doesNotMatch(prompt, /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|MICHI_METADATA_DONE/);
        }
    });

    test('a Kiro agent that cannot be selected fails the check', async (t) => {
        const env = setup(t, { engine: 'v3', setModeError: 'unknown mode' });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-mode', cwd: '/x', toolProfile: restrictedChatProfile() }),
            (error: unknown) => isMetaAgentGuardError(error) && /did not select the Meta agent/.test((error as Error).message));
    });

    test('v2 maintenance: --agent picks the agent, the tools command is checked, its slot is the maintenance catalog', async (t) => {
        const env = setup(t, {
            engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
            v2Tools: [{ name: 'maintenance_read_source', source: 'mcp:michi' }, { name: 'maintenance_no_change', source: 'mcp:michi' }],
        });
        const session = await env.runtime.newSession({
            sessionId: 'n-maint', cwd: '/x', workspaceId: 'ws-1', ownerUserId: null, toolProfile: maintenanceToolProfile(),
        }) as any;
        assert.deepEqual((env.opened[0].options as any).extraArgs, ['--agent', KIRO_META_AGENT_NAMES.maintenance]);
        assert.equal(env.opened[0].cwd, kiroMetaAgentDir(tmpDir, 'maintenance'));
        assert.ok(!env.calls.some((call) => call.method === 'session/set_mode'), 'already selected by --agent');
        assert.ok(env.calls.some((call) => call.method === '_kiro.dev/commands/execute' && call.params.command.command === 'tools'));
        const slot = [...env.registry.slots.values()][0];
        assert.equal(slot.maintenance, true);
        assert.equal(slot.assistant, undefined);
        assert.deepEqual([...slot.exposedToolNames], [...META_AGENT_MAINTENANCE_TOOL_NAMES]);
        assert.equal(slot.getActiveMaintenanceExecutionContext(), null);
        assert.equal(session.getEnableFollowUps(), false);
        await assert.rejects(async () => { for await (const _ of session.send('maintain')) { /* none */ } }, /missing a valid owner/,
            'a maintenance send needs its trusted context');
    });

    const v2Maintenance: Script = {
        engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
        v2Tools: [{ name: 'maintenance_read_source', source: 'mcp:michi' }, { name: 'maintenance_no_change', source: 'mcp:michi' }],
    };
    const maintain = (runtime: AcpAgentRuntime, sessionId: string, toolProfile = maintenanceToolProfile()) =>
        runtime.newSession({ sessionId, cwd: '/x', workspaceId: 'ws-1', ownerUserId: null, toolProfile }) as Promise<any>;

    test('maintenance sessions share one kiro-cli with a slot each; the last release stops it after the idle TTL', async (t) => {
        const env = setup(t, v2Maintenance);
        const rt = env.runtime as any;
        rt.idleTtlMs = 20;
        rt.processCap = 1;
        const [a, b] = await Promise.all([maintain(env.runtime, 'n-a'), maintain(env.runtime, 'n-b')]);
        const worker = env.opened[0].runtime;
        assert.equal(env.opened.length, 2);
        assert.ok(env.opened.every((open) => open.runtime === worker), 'one worker, even for sessions opened at once');
        assert.equal(env.runtime.activeProcessCount, 1, 'the second session does not hit a cap of one');
        assert.notEqual(a.nativeSessionId, b.nativeSessionId);
        assert.equal(env.registry.slots.size, 2);

        await env.runtime.releaseSession('n-a');
        assert.equal(worker.closing, false, 'its neighbour keeps the process');
        assert.equal(env.runtime.getBinding('n-a'), undefined);
        assert.ok(env.runtime.getBinding('n-b'));
        await env.runtime.releaseSession('n-b');
        assert.equal(env.registry.slots.size, 0);
        assert.equal(worker.closing, false, 'kept for the idle TTL');
        assert.equal(env.runtime.activeProcessCount, 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(worker.closing, true);
        assert.equal(env.runtime.activeProcessCount, 0);
        await maintain(env.runtime, 'n-c');
        assert.notEqual(env.opened.at(-1)!.runtime, worker, 'a later session starts a new one');
    });

    test('a session whose turn did not stop retires the shared kiro-cli: neighbours finish there, new sessions get a fresh one', async (t) => {
        const env = setup(t, v2Maintenance);
        const a = await maintain(env.runtime, 'n-a');
        await maintain(env.runtime, 'n-b');
        const worker = env.opened[0].runtime;
        t.mock.method(env.client as any, 'needsSessionRecovery', (sid: string) => sid === a.nativeSessionId);
        await env.runtime.releaseSession('n-a');
        assert.equal(worker.closing, false, 'n-b still runs there');
        await maintain(env.runtime, 'n-c');
        const fresh = env.opened.at(-1)!.runtime;
        assert.notEqual(fresh, worker);
        assert.equal(env.runtime.activeProcessCount, 2);
        await env.runtime.releaseSession('n-b');
        assert.equal(worker.closing, true, 'stopped with its last session');
        assert.equal(fresh.closing, false);
        assert.equal(env.runtime.activeProcessCount, 1);
    });

    test('a changed agent config starts a new shared worker and the old one drains', async (t) => {
        const env = setup(t, v2Maintenance);
        await maintain(env.runtime, 'n-a');
        const old = env.opened[0].runtime;
        await maintain(env.runtime, 'n-b', { ...maintenanceToolProfile(), allowedToolNames: [...META_AGENT_MAINTENANCE_TOOL_NAMES, 'maintenance_future_tool'] });
        const next = env.opened.at(-1)!.runtime;
        assert.notEqual(next, old);
        assert.equal(old.closing, false, 'n-a finishes on the old config');
        await env.runtime.releaseSession('n-a');
        assert.equal(old.closing, true);
        assert.equal(next.closing, false);
    });

    test('at the process cap an idle shared worker gives way; one with sessions reports the cap', async (t) => {
        const env = setup(t, v2Maintenance);
        const rt = env.runtime as any;
        rt.processCap = 1;
        await maintain(env.runtime, 'n-a');
        await assert.rejects(rt.ensureProcessSlot(),
            (error: unknown) => error instanceof KiroProcessCapError && /^Kiro process cap \(1\) reached/.test((error as Error).message));
        await env.runtime.releaseSession('n-a');
        const worker = env.opened[0].runtime;
        assert.equal(worker.closing, false);
        await rt.ensureProcessSlot();
        assert.equal(worker.closing, true, 'the idle worker was stopped to make room');
        assert.equal(env.runtime.activeProcessCount, 0);
    });

    test('v2: a built-in in the tools answer refuses the session', async (t) => {
        const env = setup(t, {
            engine: 'v2', currentModeId: KIRO_META_AGENT_NAMES.maintenance,
            v2Tools: [{ name: 'maintenance_no_change', source: 'mcp:michi' }, { name: 'execute_bash', source: 'built-in' }],
        });
        await assert.rejects(env.runtime.newSession({ sessionId: 'n-v2bad', cwd: '/x', workspaceId: 'ws-1', toolProfile: maintenanceToolProfile() }),
            (error: unknown) => error instanceof MetaAgentGuardError && error.violation.toolset === 'maintenance'
                && error.violation.unexpectedTools.join() === 'built-in:execute_bash');
    });

    test('a restored session is selected and checked again', async (t) => {
        const env = setup(t, { engine: 'v3', currentModeId: KIRO_META_AGENT_NAMES.chat, tagsAfterMode: [michi(['read_node'])] });
        const session = await env.runtime.loadSession({ sessionId: 'sid-old', nodeId: 'n-old', nativeEngine: 'v3', cwd: '/x', toolProfile: restrictedChatProfile() }) as any;
        assert.equal(session.nativeSessionId, 'sid-old');
        assert.ok(env.calls.some((call) => call.method === 'session/load'));
        assert.ok(env.calls.some((call) => call.method === 'session/set_mode'), 'v3 always switches, even when the loaded mode matches');
        assert.equal([...env.registry.slots.values()][0].isServing(), true);
    });

    test('Crew still refuses both toolsets with its own reason', async () => {
        const crew = new AcpAgentRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: fakeMcpRegistry(makeRegistry() as any, { mcpPort: 9999 }), defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({
            id: 'crew', engine: 'v2', launch: { bin: '/bin/false', args: () => [] }, sidecarTitles: false,
        }) });
        try {
            await assert.rejects(crew.newSession({ sessionId: 'n', cwd: '/x', toolProfile: maintenanceToolProfile() }),
                (error: unknown) => error instanceof MaintenanceRuntimeUnsupportedError && /Kiro Crew/.test(error.message));
            await assert.rejects(crew.loadSession({ sessionId: 'n', cwd: '/x', toolProfile: restrictedChatProfile() }),
                (error: unknown) => error instanceof AssistantRuntimeUnsupportedError && /Kiro Crew/.test(error.message));
            await assert.rejects(crew.forkSession({ sessionId: 'n', cwd: '/x', sourceNativeSessionId: 's', toolProfile: restrictedChatProfile() }),
                AssistantRuntimeUnsupportedError);
        } finally {
            await crew.shutdown();
        }
    });
});
