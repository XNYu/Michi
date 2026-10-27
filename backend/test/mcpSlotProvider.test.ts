/**
 * McpSlotRegistry as the runtime package's McpSlotProvider: endpoint(),
 * sessionEndpoint() and hookEndpoint() give byte for byte the URLs the Kiro,
 * Codex and Claude adapters build today (and Crew's relay accepts), and
 * rebind() patches the live binding that tool calls read, observed through a
 * real MCP client on mountMcp.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentRunToolInvoker, McpSlotProvider } from 'michi-runtime';
import * as dbRepository from '../src/services/dbRepository';
import { McpSlotRegistry, mountMcp, type McpSlotCallbacks } from '../src/services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from '../src/services/requestBodyLimit';
import { michiMcpServer, michiSessionMcpServer } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';
import { buildCodexMcpConfig } from 'michi-runtime/internal/adapters/codex/codexProtocol';
import { buildCodexFollowUpsHookPocConfig } from 'michi-runtime/internal/adapters/codex/codexFollowUpsHookPoc';
import { buildClaudeMcpConfig, MICHI_INTERNAL_MCP_NAME } from 'michi-runtime/internal/adapters/claude/claudeMcpConfig';
import { validateMichiEndpoint } from 'michi-runtime/internal/adapters/crew/crewMcpBinding';
import { mcpSlotProviderInternals } from 'michi-runtime/internal/mcp-host/slotProviderInternals';
import { CursorRuntime } from '../src/agents/cursor/CursorRuntime';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { injectedHostEvent } from 'michi-runtime/internal/adapters/kiro/kiroHostEvents';
import { chatOwner, runOwner } from './helpers/owners';
import { michiTestHost } from './helpers/michiTestHost';

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: CallResult) => result.content.map((part) => part.text ?? '').join('');

const callbacks = (over: Partial<McpSlotCallbacks> = {}): McpSlotCallbacks => ({
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    ...over,
});

/** The host slot behind a registry slot (white box: the registry keeps it private). */
function hostSlot(registry: McpSlotRegistry, slotId: string) {
    return mcpSlotProviderInternals((registry as unknown as { provider: McpSlotProvider }).provider).hostSlot(slotId)!;
}

/**
 * An express app with express.json and the router under /api, as server.ts
 * mounts them, listening on loopback first so the registry can be built with
 * the real port and then mounted.
 */
async function startMcpApp(t: TestContext) {
    const app = express();
    app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
    const router = express.Router();
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const registry = new McpSlotRegistry({ mcpPort: (server.address() as AddressInfo).port });
    mountMcp(router, registry);
    const connect = async (url: string) => {
        const client = new Client({ name: 'michi-slot-provider', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        t.after(() => client.close());
        return client;
    };
    return { registry, connect };
}

for (const port of [3000, 43117]) {
    test(`endpoint URLs equal the adapters' URLs byte for byte (port ${port})`, async (t) => {
        const registry = port === 3000 ? new McpSlotRegistry() : new McpSlotRegistry({ mcpPort: port });
        const provider: McpSlotProvider = registry;
        const slot = provider.create('chat-a', '/tmp', null, callbacks(), { nodeId: 'node-a' });
        const groupId = provider.createSessionGroup(slot);
        t.after(async () => { provider.disposeSessionGroup(groupId); await provider.dispose(slot.slotId); });
        const slotId = slot.slotId;
        const kiroBaseUrl = `http://127.0.0.1:${port}/api`;

        const endpoint = provider.endpoint(slotId);
        assert.deepEqual(endpoint, { type: 'http', url: `http://127.0.0.1:${port}/api/mcp/${slotId}`, headers: [] });
        for (const engine of ['v2', 'v3'] as const) {
            // Kiro's entry carries the provider's URL unchanged, with no headers.
            const kiro = michiMcpServer(engine, endpoint);
            assert.equal(kiro.url, `${kiroBaseUrl}/mcp/${slotId}`, `Kiro ${engine}`);
            assert.deepEqual({ type: kiro.type, url: kiro.url, headers: kiro.headers }, endpoint, `Kiro ${engine}`);
        }
        // Codex builds its entry from endpoint(), keeping the empty headers and its approval mode.
        const codex = (buildCodexMcpConfig(endpoint).mcp_servers as Record<string, unknown>).__michi_internal__;
        assert.deepEqual(codex, { url: `http://127.0.0.1:${port}/api/mcp/${slotId}`, headers: [], default_tools_approval_mode: 'approve' });
        // Claude's entry is the endpoint's URL alone: no headers.
        const claude = JSON.parse(buildClaudeMcpConfig(endpoint)).mcpServers[MICHI_INTERNAL_MCP_NAME];
        assert.deepEqual(claude, { type: endpoint.type, url: endpoint.url });
        // Crew's relay validates the URL and refuses headers.
        assert.equal(validateMichiEndpoint(endpoint.url), endpoint.url);
        assert.deepEqual(endpoint.headers, []);

        const session = provider.sessionEndpoint(groupId);
        const kiroSession = michiSessionMcpServer(session);
        assert.equal(kiroSession.url, `${kiroBaseUrl}/mcp-session/${groupId}`);
        assert.deepEqual({ type: kiroSession.type, url: kiroSession.url, headers: kiroSession.headers }, session);
        assert.throws(() => validateMichiEndpoint(session.url), /Invalid Michi MCP endpoint/,
            'Crew cannot use the session group URL');

        const hook = provider.hookEndpoint(slotId, 'stop');
        assert.equal(hook, `http://127.0.0.1:${port}/api/codex-hooks/${slotId}/stop`);
        const hookConfig = buildCodexFollowUpsHookPocConfig(slotId, hook, { nodePath: '/usr/bin/node', runnerPath: '/opt/runner.cjs' }) as {
            hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
        };
        assert.equal(hookConfig.hooks.Stop[0].hooks[0].command, `ELECTRON_RUN_AS_NODE=1 '/usr/bin/node' '/opt/runner.cjs' '${hook}'`);

        // The package host got the same base URL, so its own endpoint() agrees.
        assert.deepEqual(hostSlot(registry, slotId).endpoint(), endpoint);
        // URLs are built from the id alone: a disposed slot keeps its URL, which then answers 404.
        await provider.dispose(slotId);
        assert.deepEqual(provider.endpoint(slotId), endpoint);
        assert.equal(provider.hookEndpoint(slotId, 'stop'), hook);
    });
}

test('a port function is read each time a URL is built, by the registry and its host alike', async (t) => {
    let port = 0;
    const registry = new McpSlotRegistry({ mcpPort: () => port });
    const slot = registry.create('chat-a', '/tmp', null, callbacks(), { nodeId: 'node-a' });
    const groupId = registry.createSessionGroup(slot);
    t.after(async () => { registry.disposeSessionGroup(groupId); await registry.dispose(slot.slotId); });
    for (const bound of [43118, 43119]) {
        port = bound;
        const fixed = new McpSlotRegistry({ mcpPort: bound });
        assert.deepEqual(registry.endpoint(slot.slotId), fixed.endpoint(slot.slotId));
        assert.equal(registry.endpoint(slot.slotId).url, `http://127.0.0.1:${bound}/api/mcp/${slot.slotId}`);
        assert.deepEqual(registry.sessionEndpoint(groupId), fixed.sessionEndpoint(groupId));
        assert.equal(registry.hookEndpoint(slot.slotId, 'stop'), fixed.hookEndpoint(slot.slotId, 'stop'));
        assert.deepEqual(hostSlot(registry, slot.slotId).endpoint(), registry.endpoint(slot.slotId));
    }
});

test('rebind assigns on the binding get() returns and moves the host sessionKey with parentChatId', async () => {
    const registry = new McpSlotRegistry();
    const first: AgentRunToolInvoker = { invoke: async () => ({ invoker: 'first' }) };
    const second: AgentRunToolInvoker = { invoke: async () => ({ invoker: 'second' }) };
    const submit = () => { throw new Error('not called'); };
    const slot = registry.create('__pending__', '/tmp', null, callbacks({
        owner: chatOwner('warm'),
        exposedToolNames: new Set(['save_artifact']),
        agentRuns: first,
    }));
    assert.equal(hostSlot(registry, slot.slotId).sessionKey, '__pending__');

    registry.rebind(slot.slotId, {
        owner: runOwner('run-1', 'attempt-1'),
        exposedToolNames: undefined,
        parentChatId: 'native-1',
        nodeId: 'node-1',
        workspaceId: 'ws-1',
        ownerUserId: 'user-1',
        agentRuns: second,
        agentRunToolNames: ['list_agents'],
        onSubmitAgentResult: submit,
    });
    assert.equal(registry.get(slot.slotId), slot, 'the same object, not a replacement');
    assert.deepEqual(slot.owner, runOwner('run-1', 'attempt-1'));
    assert.ok('exposedToolNames' in slot);
    assert.equal(slot.exposedToolNames, undefined);
    assert.equal(slot.parentChatId, 'native-1');
    assert.equal(slot.nodeId, 'node-1');
    assert.equal(slot.workspaceId, 'ws-1');
    assert.equal(slot.ownerUserId, 'user-1');
    assert.equal(slot.agentRuns, second);
    assert.deepEqual(slot.agentRunToolNames, ['list_agents']);
    assert.equal(slot.onSubmitAgentResult, submit);
    assert.equal(slot.cwd, '/tmp');
    assert.equal(hostSlot(registry, slot.slotId).sessionKey, 'native-1');

    // Absent keys are left alone; undefined clears optional fields only.
    registry.rebind(slot.slotId, {});
    registry.rebind(slot.slotId, { parentChatId: undefined, nodeId: undefined, workspaceId: undefined, ownerUserId: undefined });
    assert.equal(slot.parentChatId, 'native-1');
    assert.equal(slot.nodeId, 'node-1');
    assert.equal(slot.workspaceId, 'ws-1');
    assert.equal(slot.ownerUserId, 'user-1');
    assert.equal(hostSlot(registry, slot.slotId).sessionKey, 'native-1');
    registry.rebind(slot.slotId, { nodeId: null, workspaceId: null, ownerUserId: null, agentRuns: undefined });
    assert.equal(slot.nodeId, null);
    assert.equal(slot.workspaceId, null);
    assert.equal(slot.ownerUserId, null);
    assert.equal(slot.agentRuns, undefined);

    // Unknown and disposed slots: nothing to patch, as get() answers undefined.
    assert.doesNotThrow(() => registry.rebind('f'.repeat(32), { parentChatId: 'other' }));
    await registry.dispose(slot.slotId);
    assert.equal(registry.get(slot.slotId), undefined);
    assert.doesNotThrow(() => registry.rebind(slot.slotId, { parentChatId: 'after-dispose' }));
    assert.equal(slot.parentChatId, 'native-1');
});

test('tool calls on endpoint() see a rebind from the next call on', async (t) => {
    // The catalog resolves the slot's node binding on every request; no database here.
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const seenParents: string[] = [];
    const invoked: string[] = [];
    let slotId = '';
    const slot = registry.create('__pending__', '/tmp', null, callbacks({
        // As Kiro's handleSpawnBranches does: read the slot's identity at call time.
        onSpawnBranches: async (topics) => {
            seenParents.push(registry.get(slotId)!.parentChatId);
            return topics.map((topic, i) => ({ ...topic, chatId: `child-${i}` }));
        },
    }));
    slotId = slot.slotId;
    t.after(() => registry.dispose(slotId));
    const client = await connect(registry.endpoint(slotId).url);

    const spawn = async () => client.callTool({
        name: 'spawn_branches', arguments: { topics: [{ title: 'A', prompt: 'Explore A' }] },
    }) as Promise<CallResult>;
    const before = await spawn();
    assert.notEqual(before.isError, true, textOf(before));
    const toolsBefore = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!toolsBefore.includes('list_agents'), toolsBefore.join(', '));

    registry.rebind(slotId, {
        parentChatId: 'native-1',
        nodeId: 'node-1',
        agentRuns: { invoke: async (name) => { invoked.push(name); return { agents: [] }; } },
        agentRunToolNames: ['list_agents'],
    });

    // Same client, same URL: the host serves the patched binding.
    const after = await spawn();
    assert.notEqual(after.isError, true, textOf(after));
    assert.deepEqual(seenParents, ['__pending__', 'native-1']);
    const toolsAfter = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolsAfter.includes('list_agents'), toolsAfter.join(', '));
    assert.ok(!toolsAfter.includes('spawn_agent'), 'only the rebound Agent Run tool names are listed');
    const listed = await client.callTool({ name: 'list_agents', arguments: {} }) as CallResult;
    assert.notEqual(listed.isError, true, textOf(listed));
    assert.deepEqual(JSON.parse(textOf(listed)), { agents: [] });
    assert.deepEqual(invoked, ['list_agents']);

    // An exposed-tool allow-list set by rebind gates the very next listing.
    registry.rebind(slotId, { exposedToolNames: new Set(['save_artifact']) });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['save_artifact']);
});

test('sessionEndpoint() and hookEndpoint() reach mountMcp routes', async (t) => {
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const saved: string[] = [];
    const slot = registry.create('chat-a', '/tmp', null, callbacks({
        onSaveArtifact: (name, body) => { saved.push(name); return { name, filePath: `/tmp/${name}`, size: body.length }; },
        onValidateFollowUps: () => ({ decision: 'block', reason: 'Call set_follow_ups first.' }),
    }), { nodeId: 'node-a' });
    const groupId = registry.createSessionGroup(slot);
    registry.bindSession(groupId, 'chat-a', slot.slotId);
    const endTurn = registry.beginSessionTurn(groupId, 'chat-a');
    t.after(async () => { endTurn(); registry.disposeSessionGroup(groupId); await registry.dispose(slot.slotId); });

    const shared = await connect(registry.sessionEndpoint(groupId).url);
    const routed = await shared.callTool({ name: 'save_artifact', arguments: { session_id: 'chat-a', name: 'routed', body: 'x' } }) as CallResult;
    assert.equal(textOf(routed), 'Saved artifact: @routed');
    assert.deepEqual(saved, ['routed']);

    const post = async (url: string) => {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false }),
        });
        return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await post(registry.hookEndpoint(slot.slotId, 'stop')),
        { status: 200, body: { decision: 'block', reason: 'Call set_follow_ups first.' } });
    assert.deepEqual(await post(registry.hookEndpoint('f'.repeat(32), 'stop')), { status: 200, body: {} },
        'an unknown slot fails open with {}');
    assert.throws(() => registry.hookEndpoint(slot.slotId, 'start' as 'stop'), /Unknown MCP slot hook/);
});

test("create() hands the session's sink to the slot's tools, which report after the callback and before answering", async (t) => {
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const steps: string[] = [];
    const reports: Array<{ type: string; payload?: unknown }> = [];
    const spawned = [{ title: 'A', prompt: 'Explore A', chatId: 'child-1' }];
    const slot = registry.create('chat-a', '/tmp', null, {
        sink: { emit: (event) => { steps.push(`report ${event.type}`); reports.push(event); } },
        onSpawnBranches: async (topics) => {
            steps.push('callback spawn_branches');
            if (topics[0]?.title === 'fail') throw new Error('spawn failed');
            return spawned;
        },
        onSaveArtifact: (name, body) => {
            steps.push('callback save_artifact');
            return name === 'missing' ? null : { id: 'ctx-1', name, filePath: `.contexts/${name}.md`, size: body.length };
        },
        onUpdateArtifact: (name, body) => {
            steps.push('callback update_artifact');
            return name === 'missing' ? null : { name, filePath: `.contexts/${name}.md`, size: body.length };
        },
        onShowImage: (path) => {
            steps.push('callback show_image');
            return path === 'missing.png' ? { error: 'no such file' } : { relPath: path, mimeType: 'image/png', size: 16 };
        },
    }, { nodeId: 'node-a' });
    assert.equal('sink' in slot, false, 'the binding does not carry the sink');
    const groupId = registry.createSessionGroup(slot);
    registry.bindSession(groupId, 'chat-a', slot.slotId);
    const endTurn = registry.beginSessionTurn(groupId, 'chat-a');
    t.after(async () => { endTurn(); registry.disposeSessionGroup(groupId); await registry.dispose(slot.slotId); });

    const direct = await connect(registry.endpoint(slot.slotId).url);
    const shared = await connect(registry.sessionEndpoint(groupId).url);
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }) as CallResult;
        steps.push(`answer ${name}${result.isError ? ' (error)' : ''}`);
    };
    await call(direct, 'spawn_branches', { topics: [{ title: 'A', prompt: 'Explore A' }] });
    await call(direct, 'save_artifact', { name: 'notes', body: 'saved' });
    await call(direct, 'update_artifact', { name: 'notes', body: 'updated' });
    await call(direct, 'show_image', { path: 'chart.png', caption: 'Chart' });
    await call(direct, 'show_image', { path: 'chart.png' });
    // A callback that fails reports nothing.
    await call(direct, 'spawn_branches', { topics: [{ title: 'fail', prompt: 'x' }] });
    await call(direct, 'save_artifact', { name: 'missing', body: 'x' });
    await call(direct, 'update_artifact', { name: 'missing', body: 'x' });
    await call(direct, 'show_image', { path: 'missing.png' });
    // Through the session group, the bound slot's sink gets the report.
    await call(shared, 'save_artifact', { session_id: 'chat-a', name: 'routed', body: 'x' });

    assert.deepEqual(reports, [
        { type: 'spawn_branches', payload: { topics: spawned } },
        { type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 5 } },
        { type: 'artifact_updated', payload: { contextId: undefined, name: 'notes', filePath: '.contexts/notes.md', size: 7 } },
        { type: 'image', payload: { path: 'chart.png', caption: 'Chart', mimeType: 'image/png', size: 16 } },
        { type: 'image', payload: { path: 'chart.png', caption: undefined, mimeType: 'image/png', size: 16 } },
        { type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'routed', filePath: '.contexts/routed.md', size: 1 } },
    ]);
    assert.equal((reports[0].payload as { topics: unknown }).topics, spawned, "the callback's result, as it returned it");
    assert.deepEqual(steps, [
        'callback spawn_branches', 'report spawn_branches', 'answer spawn_branches',
        'callback save_artifact', 'report artifact_saved', 'answer save_artifact',
        'callback update_artifact', 'report artifact_updated', 'answer update_artifact',
        'callback show_image', 'report image', 'answer show_image',
        'callback show_image', 'report image', 'answer show_image',
        'callback spawn_branches', 'answer spawn_branches (error)',
        'callback save_artifact', 'answer save_artifact (error)',
        'callback update_artifact', 'answer update_artifact (error)',
        'callback show_image', 'answer show_image (error)',
        'callback save_artifact', 'report artifact_saved', 'answer save_artifact',
    ]);
});

test("each slot's tools report only to its own session's sink, directly and through a session group", async (t) => {
    // One registry serves every session and user, so a report must never reach another session's sink.
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const reports: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const make = (key: 'a' | 'b') => registry.create(`chat-${key}`, '/tmp', 'user-1', {
        sink: { emit: (event) => { reports[key].push(`${event.type} ${(event.payload as { name: string }).name}`); } },
        onSaveArtifact: (name, body) => ({ id: `ctx-${key}`, name, filePath: `.contexts/${name}.md`, size: body.length }),
    }, { nodeId: `node-${key}` });
    const a = make('a');
    const b = make('b');
    // The group's catalog copy comes from A; calls still run with the bound slot's sink.
    const groupId = registry.createSessionGroup(a);
    registry.bindSession(groupId, 'chat-a', a.slotId);
    registry.bindSession(groupId, 'chat-b', b.slotId);
    const endA = registry.beginSessionTurn(groupId, 'chat-a');
    const endB = registry.beginSessionTurn(groupId, 'chat-b');
    t.after(async () => {
        endA(); endB(); registry.disposeSessionGroup(groupId);
        await registry.dispose(a.slotId); await registry.dispose(b.slotId);
    });

    const save = async (client: Client, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'save_artifact', arguments: { body: 'x', ...args } }) as CallResult;
        assert.notEqual(result.isError, true, textOf(result));
    };
    const direct = { a: await connect(registry.endpoint(a.slotId).url), b: await connect(registry.endpoint(b.slotId).url) };
    const shared = await connect(registry.sessionEndpoint(groupId).url);
    await save(direct.b, { name: 'from-b' });
    await save(direct.a, { name: 'from-a' });
    await save(shared, { session_id: 'chat-b', name: 'routed-b' });
    await save(shared, { session_id: 'chat-a', name: 'routed-a' });

    assert.deepEqual(reports, {
        a: ['artifact_saved from-a', 'artifact_saved routed-a'],
        b: ['artifact_saved from-b', 'artifact_saved routed-b'],
    });
});

test("a Kiro slot's tool events reach only its own ACP session, directly and through a session group", async (t) => {
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const cwd = '/tmp/michi-kiro-sink';
    const runtime = new KiroRuntime({
        bridge: {
            spawnBranches: async () => [],
            saveContext: ({ chatId, name, body }) => ({ id: `ctx-${chatId}`, name, filePath: `.contexts/${name}.md`, size: body.length }),
            updateContext: () => null,
        },
        mcpSlots: registry, defaultCwd: cwd, host: michiTestHost(),
    });
    const rt = runtime as any;
    // Both sessions run on the cwd's one ACP client: only the session id tells them apart.
    const injected: string[] = [];
    rt.pool.set(cwd, {
        injectUpdate: (sessionId: string, update: Record<string, unknown>) => {
            const event = injectedHostEvent(update);
            if (event?.kind !== 'host_event') return true;
            // contextId names the chat whose callback saved it (ctx-<sid>).
            const { name, contextId } = event.payload as { name: string; contextId: string };
            injected.push(`${sessionId} ${event.type} ${name} ${contextId}`);
            return true;
        },
    });
    // As KiroRuntime opens two chats on one cwd, each slot with the runtime's own callbacks.
    const open = (sid: string, nodeId: string) => {
        let slotId: string | undefined;
        const slot = registry.create(sid, cwd, 'user-1', rt.makeSlotCallbacks(() => slotId), { nodeId });
        slotId = slot.slotId;
        return slot;
    };
    const a = open('sid-a', 'node-a');
    const b = open('sid-b', 'node-b');
    // KiroRuntime.chatMcpServer: the group's catalog copy comes from A.
    const groupId = registry.createSessionGroup(a);
    registry.bindSession(groupId, 'sid-a', a.slotId);
    registry.bindSession(groupId, 'sid-b', b.slotId);
    const endA = registry.beginSessionTurn(groupId, 'sid-a');
    const endB = registry.beginSessionTurn(groupId, 'sid-b');
    t.after(async () => {
        endA(); endB(); registry.disposeSessionGroup(groupId);
        await registry.dispose(a.slotId); await registry.dispose(b.slotId);
        rt.pool.clear();
        await runtime.shutdown();
    });

    const save = async (client: Client, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'save_artifact', arguments: { body: 'x', ...args } }) as CallResult;
        assert.notEqual(result.isError, true, textOf(result));
    };
    const direct = { a: await connect(registry.endpoint(a.slotId).url), b: await connect(registry.endpoint(b.slotId).url) };
    const shared = await connect(registry.sessionEndpoint(groupId).url);
    await save(direct.b, { name: 'from-b' });
    await save(direct.a, { name: 'from-a' });
    await save(shared, { session_id: 'sid-b', name: 'routed-b' });
    await save(shared, { session_id: 'sid-a', name: 'routed-a' });

    assert.deepEqual(injected, [
        'sid-b artifact_saved from-b ctx-sid-b',
        'sid-a artifact_saved from-a ctx-sid-a',
        'sid-b artifact_saved routed-b ctx-sid-b',
        'sid-a artifact_saved routed-a ctx-sid-a',
    ]);
});

test("a Kiro slot serves a business tool only when the runtime's bridge has its effect", async (t) => {
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const effects = ['spawn_branches', 'save_artifact', 'update_artifact'];
    const served = async (bridge: Record<string, unknown>) => {
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry, defaultCwd: '/tmp/michi-kiro-bridge', host: michiTestHost() });
        let slotId: string | undefined;
        const slot = registry.create('sid-bridge', '/tmp/michi-kiro-bridge', null,
            (runtime as any).makeSlotCallbacks(() => slotId), { nodeId: 'node-bridge' });
        slotId = slot.slotId;
        try {
            const { tools } = await (await connect(registry.endpoint(slot.slotId).url)).listTools();
            return tools.map((tool) => tool.name).filter((name) => effects.includes(name)).sort();
        } finally {
            await registry.dispose(slot.slotId);
            await runtime.shutdown();
        }
    };
    assert.deepEqual(await served({ spawnBranches: async () => [], saveContext: () => null, updateContext: () => null }), [...effects].sort());
    assert.deepEqual(await served({ saveContext: () => null }), ['save_artifact']);
    assert.deepEqual(await served({}), []);
});

test("public ACP tool events and output backfills reach only its own ACP session, directly and through a session group", async (t) => {
    t.mock.method(dbRepository, 'getNodeSessionBinding', () => null);
    const { registry, connect } = await startMcpApp(t);
    const cwd = '/tmp/michi-acp-sink';
    const runtime = new CursorRuntime({
        spawnBranches: async () => [],
        saveContext: ({ chatId, name, body }) => ({ id: `ctx-${chatId}`, name, filePath: `.contexts/${name}.md`, size: body.length }),
        updateContext: () => null,
    }, registry, 3000, cwd);
    const rt = runtime as any;
    // Both sessions run on the cwd's one ACP client: only the session id tells them apart.
    const injected: string[] = [];
    const outputs: string[] = [];
    rt.pool.set(cwd, {
        backfillToolOutput: (sid: string, result: CallResult) => { outputs.push(`${sid} ${textOf(result)}`); },
        injectUpdate: (sessionId: string, update: Record<string, unknown>) => {
            const event = injectedHostEvent(update);
            if (event?.kind !== 'host_event') return true;
            // contextId names the chat whose callback saved it (ctx-<sid>).
            const { name, contextId } = event.payload as { name: string; contextId: string };
            injected.push(`${sessionId} ${event.type} ${name} ${contextId}`);
            return true;
        },
    });
    // Two chats share one ACP client but keep their own slot callbacks.
    const open = (sid: string, nodeId: string) => {
        let slotId: string | undefined;
        const slot = registry.create(sid, cwd, 'user-1', rt.makeSlotCallbacks(() => slotId), { nodeId });
        slotId = slot.slotId;
        return slot;
    };
    const a = open('sid-a', 'node-a');
    const b = open('sid-b', 'node-b');
    // The group's catalog copy comes from A.
    const groupId = registry.createSessionGroup(a);
    registry.bindSession(groupId, 'sid-a', a.slotId);
    registry.bindSession(groupId, 'sid-b', b.slotId);
    const endA = registry.beginSessionTurn(groupId, 'sid-a');
    const endB = registry.beginSessionTurn(groupId, 'sid-b');
    t.after(async () => {
        endA(); endB(); registry.disposeSessionGroup(groupId);
        await registry.dispose(a.slotId); await registry.dispose(b.slotId);
        rt.pool.clear();
        await runtime.shutdown();
    });

    const save = async (client: Client, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'save_artifact', arguments: { body: 'x', ...args } }) as CallResult;
        assert.notEqual(result.isError, true, textOf(result));
    };
    const direct = { a: await connect(registry.endpoint(a.slotId).url), b: await connect(registry.endpoint(b.slotId).url) };
    const shared = await connect(registry.sessionEndpoint(groupId).url);
    await save(direct.b, { name: 'from-b' });
    await save(direct.a, { name: 'from-a' });
    await save(shared, { session_id: 'sid-b', name: 'routed-b' });
    await save(shared, { session_id: 'sid-a', name: 'routed-a' });

    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(outputs, [
        "sid-b Saved artifact: @from-b", "sid-a Saved artifact: @from-a",
        "sid-b Saved artifact: @routed-b", "sid-a Saved artifact: @routed-a",
    ]);
    assert.deepEqual(injected, [
        'sid-b artifact_saved from-b ctx-sid-b',
        'sid-a artifact_saved from-a ctx-sid-a',
        'sid-b artifact_saved routed-b ctx-sid-b',
        'sid-a artifact_saved routed-a ctx-sid-a',
    ]);
});
