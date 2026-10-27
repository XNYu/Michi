import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentRunToolInvoker } from '../src/contract/tools';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import { createMcpHost, createMcpSlotProvider, type HostToolDef, type McpHost, type McpHostOptions } from '../src/mcp-host';
import { DEFAULT_ANCHOR_DESCRIPTION } from '../src/mcp-host/tools';
import { mcpSlotProviderInternals } from '../src/mcp-host/slotProviderInternals';
import { michiMcpServer, michiSessionMcpServer } from '../src/adapters/kiro/kiroProtocol';
import { buildCodexMcpConfig } from '../src/adapters/codex/codexProtocol';
import { buildClaudeMcpConfig, MICHI_INTERNAL_MCP_NAME } from '../src/adapters/claude/claudeMcpConfig';
import { validateMichiEndpoint } from '../src/adapters/crew/crewMcpBinding';

type Event = { type: string; payload?: unknown };
type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

const chat = (key: string) => ({ mode: 'interactive' as const, key });
const run = (key: string) => ({ mode: 'headless' as const, key });

/** Reports what the handler saw, so tests can assert on routing and on the binding. */
const probe: HostToolDef<McpSlot> = {
  name: 'probe',
  description: 'Report the slot the call arrived on.',
  inputSchema: { type: 'object', properties: {} },
  async handler(_args, ctx) {
    ctx.sink.emit({ type: 'probed', payload: ctx.slot.binding.parentChatId });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          slotId: ctx.slot.slotId,
          sessionKey: ctx.slot.sessionKey,
          cwd: ctx.slot.cwd,
          parentChatId: ctx.slot.binding.parentChatId,
          nodeId: ctx.slot.binding.nodeId,
          bindingHasSink: 'sink' in ctx.slot.binding,
        }),
      }],
    };
  },
};

function eventSink() {
  const events: Event[] = [];
  return { events, sink: { emit: (event: Event) => { events.push(event); } } };
}

/** A host with probe and `other` registered, listening on loopback, and a provider on it. */
async function start(t: TestContext, hostOptions: McpHostOptions = {}, providerOptions?: Parameters<typeof createMcpSlotProvider>[1]) {
  const mcpHost = createMcpHost<McpSlot>(hostOptions);
  mcpHost.registerTool(probe);
  mcpHost.registerTool({ ...probe, name: 'other' });
  const listener = await mcpHost.listen();
  t.after(() => mcpHost.close());
  return { mcpHost, listener, provider: createMcpSlotProvider(mcpHost, providerOptions) };
}

/**
 * A host mounted on a server of its own under /api with basePath /mcp, the
 * way Michi mounts it: the server strips /api before calling handler().
 */
async function startMounted(t: TestContext) {
  let port = 0;
  const mcpHost = createMcpHost<McpSlot>({ basePath: '/mcp', publicBaseUrl: () => `http://127.0.0.1:${port}/api` });
  mcpHost.registerTool(probe);
  const handle = mcpHost.handler();
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/')) { res.writeHead(404).end(); return; }
    req.url = req.url.slice('/api'.length);
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  t.after(async () => {
    await mcpHost.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { mcpHost, port, provider: createMcpSlotProvider(mcpHost) };
}

async function connect(t: TestContext, url: string): Promise<Client> {
  const client = new Client({ name: 'slot-provider-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  return await client.callTool({ name, arguments: args }) as CallResult;
}

function textOf(result: CallResult): string {
  return result.content.map((part) => part.text ?? '').join('');
}

function probed(result: CallResult): Record<string, any> {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

function post(url: string, body = INITIALIZE): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: MCP_HEADERS, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function create(provider: McpSlotProvider, parentChatId: string, cbs: McpSlotCallbacks = {},
  opts: { nodeId?: string | null; workspaceId?: string | null } = { nodeId: `node-${parentChatId}` }): McpSlot {
  return provider.create(parentChatId, `/work/${parentChatId}`, null, cbs, opts);
}

// ---------------------------------------------------------------------------
// URLs

test('Michi topology: basePath /mcp under a server mounted at /api gives /api/mcp/<id>, which every adapter accepts', async (t) => {
  const { mcpHost, port, provider } = await startMounted(t);
  const slot = create(provider, 'chat-a');
  const groupId = provider.createSessionGroup(slot);
  const base = `http://127.0.0.1:${port}/api`;

  const endpoint = provider.endpoint(slot.slotId);
  assert.deepEqual(endpoint, { type: 'http', url: `${base}/mcp/${slot.slotId}`, headers: [] });
  assert.deepEqual(mcpSlotProviderInternals(provider).hostSlot(slot.slotId)!.endpoint(), endpoint);
  assert.deepEqual(provider.sessionEndpoint(groupId), { type: 'http', url: `${base}/mcp-session/${groupId}`, headers: [] });
  assert.equal(provider.hookEndpoint(slot.slotId, 'stop'), mcpHost.hookUrl(slot.slotId, 'stop'));
  assert.equal(provider.hookEndpoint(slot.slotId, 'stop'), `${base}/mcp-hooks/${slot.slotId}/stop`);
  for (const engine of ['v2', 'v3'] as const) assert.equal(michiMcpServer(engine, endpoint).url, endpoint.url);
  assert.equal(michiSessionMcpServer(provider.sessionEndpoint(groupId)).url, `${base}/mcp-session/${groupId}`);
  assert.equal((buildCodexMcpConfig(endpoint).mcp_servers as Record<string, { url: string }>).__michi_internal__.url, endpoint.url);
  assert.equal(JSON.parse(buildClaudeMcpConfig(endpoint)).mcpServers[MICHI_INTERNAL_MCP_NAME].url, endpoint.url);
  assert.equal(validateMichiEndpoint(endpoint.url), endpoint.url);

  assert.equal(probed(await call(await connect(t, endpoint.url), 'probe')).slotId, slot.slotId);
});

test('standalone topology: basePath /api/mcp on listen() gives /api/mcp/<id>, which Crew\'s relay accepts', async (t) => {
  const { listener, provider } = await start(t, { basePath: '/api/mcp' });
  const slot = create(provider, 'chat-a');
  const groupId = provider.createSessionGroup(slot);
  assert.match(listener.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const endpoint = provider.endpoint(slot.slotId);
  assert.deepEqual(endpoint, { type: 'http', url: `${listener.baseUrl}/api/mcp/${slot.slotId}`, headers: [] });
  assert.equal(validateMichiEndpoint(endpoint.url), endpoint.url);
  assert.equal(michiMcpServer('v2', endpoint).url, endpoint.url);
  assert.equal(provider.sessionEndpoint(groupId).url, `${listener.baseUrl}/api/mcp-session/${groupId}`);
  assert.throws(() => validateMichiEndpoint(provider.sessionEndpoint(groupId).url), /Invalid Michi MCP endpoint/);
  assert.equal(provider.hookEndpoint(slot.slotId, 'stop'), `${listener.baseUrl}/api/mcp-hooks/${slot.slotId}/stop`);
  assert.equal(probed(await call(await connect(t, endpoint.url), 'probe')).slotId, slot.slotId);

  // Built from the id alone: a disposed slot keeps its URLs, which answer 404.
  const hook = provider.hookEndpoint(slot.slotId, 'stop');
  await provider.dispose(slot.slotId);
  assert.deepEqual(provider.endpoint(slot.slotId), endpoint);
  assert.equal(provider.hookEndpoint(slot.slotId, 'stop'), hook);
  assert.equal(await post(endpoint.url), 404);
});

test('hookEndpoint: the host hook route by default, the option\'s URL when given', async (t) => {
  const seen: Array<[string, string]> = [];
  const { listener, provider } = await start(t, {}, {
    hookEndpoint: (slotId, hook) => { seen.push([slotId, hook]); return `http://127.0.0.1:1/api/own-hooks/${slotId}/${hook}`; },
  });
  const slot = create(provider, 'chat-a');
  assert.equal(provider.hookEndpoint(slot.slotId, 'stop'), `http://127.0.0.1:1/api/own-hooks/${slot.slotId}/stop`);
  assert.deepEqual(seen, [[slot.slotId, 'stop']]);
  const plainHost = createMcpHost<McpSlot>({ publicBaseUrl: listener.baseUrl });
  t.after(() => plainHost.close());
  const plain = createMcpSlotProvider(plainHost);
  assert.equal(plain.hookEndpoint('a'.repeat(32), 'stop'), `${listener.baseUrl}/mcp-hooks/${'a'.repeat(32)}/stop`);
});

test('invalid options are refused when the provider is built', () => {
  const mcpHost = createMcpHost<McpSlot>();
  assert.throws(() => createMcpSlotProvider(mcpHost, { sessionAnchorDescription: ' ' }), /sessionAnchorDescription/);
  assert.throws(() => createMcpSlotProvider(mcpHost, { hookEndpoint: 'url' as never }), /hookEndpoint must be a function/);
  void mcpHost.close();
});

// ---------------------------------------------------------------------------
// Slots

test('create: the binding has the given fields and callbacks; the sink reaches the tools, never the binding', async (t) => {
  const { provider } = await start(t);
  const { events, sink } = eventSink();
  const onSaveArtifact = () => null;
  const slot = provider.create('chat-a', '/work/a', 'user-1', { owner: chat('node-a'), sink, onSaveArtifact }, { nodeId: 'node-a' });
  assert.match(slot.slotId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(slot), [
    'slotId', 'owner', 'nodeId', 'parentChatId', 'cwd', 'workspaceId', 'ownerUserId', 'exposedToolNames', 'onSaveArtifact',
  ]);
  assert.deepEqual({ ...slot, onSaveArtifact: undefined }, {
    slotId: slot.slotId, owner: chat('node-a'), nodeId: 'node-a', parentChatId: 'chat-a', cwd: '/work/a',
    workspaceId: null, ownerUserId: 'user-1', exposedToolNames: undefined, onSaveArtifact: undefined,
  });
  assert.equal(slot.onSaveArtifact, onSaveArtifact);
  assert.equal(provider.get(slot.slotId), slot);
  const bare = provider.create('chat-b', '/work/b', null, {});
  assert.deepEqual([bare.nodeId, bare.workspaceId], [null, null]);

  const seen = probed(await call(await connect(t, provider.endpoint(slot.slotId).url), 'probe'));
  assert.deepEqual(seen, {
    slotId: slot.slotId, sessionKey: 'chat-a', cwd: '/work/a', parentChatId: 'chat-a', nodeId: 'node-a', bindingHasSink: false,
  });
  assert.deepEqual(events, [{ type: 'probed', payload: 'chat-a' }]);
});

test('a slot without a sink drops its tools\' reports: the call succeeds and no other session gets them', async (t) => {
  const { provider } = await start(t);
  const { events, sink } = eventSink();
  const withSink = create(provider, 'chat-b', { sink });
  const slot = create(provider, 'chat-a');
  // probe emits before it answers, so a sink that threw would fail the call.
  assert.equal(probed(await call(await connect(t, provider.endpoint(slot.slotId).url), 'probe')).sessionKey, 'chat-a');
  assert.deepEqual(events, []);
  assert.equal(probed(await call(await connect(t, provider.endpoint(withSink.slotId).url), 'probe')).sessionKey, 'chat-b');
  assert.deepEqual(events, [{ type: 'probed', payload: 'chat-b' }]);
});

test('rebind: optional fields take undefined, required ones ignore it; parentChatId moves the host sessionKey', async (t) => {
  const { provider } = await start(t);
  const first: AgentRunToolInvoker = { invoke: async () => ({ invoker: 'first' }) };
  const second: AgentRunToolInvoker = { invoke: async () => ({ invoker: 'second' }) };
  const submit = () => { throw new Error('not called'); };
  const slot = create(provider, '__pending__', { owner: chat('warm'), agentRuns: first }, {});
  const client = await connect(t, provider.endpoint(slot.slotId).url);
  assert.equal(probed(await call(client, 'probe')).sessionKey, '__pending__');

  provider.rebind(slot.slotId, {
    owner: run('attempt-1'), parentChatId: 'native-1', nodeId: 'node-1', workspaceId: 'ws-1', ownerUserId: 'user-1',
    agentRuns: second, agentRunToolNames: ['list_agents'], onSubmitAgentResult: submit,
  });
  assert.equal(provider.get(slot.slotId), slot, 'the same object, not a replacement');
  assert.deepEqual(slot.owner, run('attempt-1'));
  assert.equal(slot.parentChatId, 'native-1');
  assert.equal(slot.nodeId, 'node-1');
  assert.equal(slot.workspaceId, 'ws-1');
  assert.equal(slot.ownerUserId, 'user-1');
  assert.equal(slot.agentRuns, second);
  assert.deepEqual(slot.agentRunToolNames, ['list_agents']);
  assert.equal(slot.onSubmitAgentResult, submit);
  assert.equal(slot.cwd, '/work/__pending__');
  assert.equal(mcpSlotProviderInternals(provider).hostSlot(slot.slotId)!.sessionKey, 'native-1');
  assert.deepEqual(probed(await call(client, 'probe')), {
    slotId: slot.slotId, sessionKey: 'native-1', cwd: '/work/__pending__', parentChatId: 'native-1', nodeId: 'node-1',
    bindingHasSink: false,
  });

  provider.rebind(slot.slotId, {});
  provider.rebind(slot.slotId, { parentChatId: undefined, nodeId: undefined, workspaceId: undefined, ownerUserId: undefined });
  assert.equal(slot.parentChatId, 'native-1');
  assert.equal(slot.nodeId, 'node-1');
  assert.equal(slot.workspaceId, 'ws-1');
  assert.equal(slot.ownerUserId, 'user-1');
  assert.equal(probed(await call(client, 'probe')).sessionKey, 'native-1');
  provider.rebind(slot.slotId, { owner: undefined, nodeId: null, workspaceId: null, ownerUserId: null, agentRuns: undefined });
  assert.ok('owner' in slot);
  assert.equal(slot.owner, undefined);
  assert.equal(slot.nodeId, null);
  assert.equal(slot.workspaceId, null);
  assert.equal(slot.ownerUserId, null);
  assert.equal(slot.agentRuns, undefined);

  // Unknown and disposed slots: nothing to patch, as get() answers undefined.
  assert.doesNotThrow(() => provider.rebind('f'.repeat(32), { parentChatId: 'other' }));
  await provider.dispose(slot.slotId);
  assert.equal(provider.get(slot.slotId), undefined);
  assert.doesNotThrow(() => provider.rebind(slot.slotId, { parentChatId: 'after-dispose' }));
  assert.equal(slot.parentChatId, 'native-1');
});

test('exposedToolNames is served at create and after a rebind; undefined serves every tool again', async (t) => {
  const { provider } = await start(t);
  const slot = create(provider, 'chat-a', { exposedToolNames: new Set(['probe']) });
  const client = await connect(t, provider.endpoint(slot.slotId).url);
  assert.deepEqual(await toolNames(client), ['probe']);
  const refused = await call(client, 'other');
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Unknown tool: other/);

  provider.rebind(slot.slotId, { exposedToolNames: new Set(['other']) });
  assert.deepEqual(await toolNames(client), ['other']);
  assert.match(textOf(await call(client, 'probe')), /Unknown tool: probe/);
  provider.rebind(slot.slotId, { parentChatId: 'native-1' });
  assert.deepEqual(await toolNames(client), ['other'], 'a patch without exposedToolNames leaves it alone');
  provider.rebind(slot.slotId, { exposedToolNames: undefined });
  assert.deepEqual(await toolNames(client), ['other', 'probe']);
});

test('restricted and isServing are left to the host\'s tools: the provider serves such a slot', async (t) => {
  const { provider } = await start(t);
  const slot = create(provider, 'chat-a', { restricted: true, isServing: () => false });
  assert.equal(slot.restricted, true);
  assert.equal(slot.isServing?.(), false);
  assert.equal(probed(await call(await connect(t, provider.endpoint(slot.slotId).url), 'probe')).slotId, slot.slotId);
});

test('dispose: the URL answers 404 at once, in-flight calls are aborted, and it is a no-op after', async (t) => {
  const { mcpHost, provider } = await start(t);
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  mcpHost.registerTool({
    ...probe,
    name: 'wait',
    handler: (_args, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }] }));
      started();
    }),
  });
  const slot = create(provider, 'chat-a');
  const client = await connect(t, provider.endpoint(slot.slotId).url);
  const pending = call(client, 'wait');
  await running;
  await provider.dispose(slot.slotId);
  assert.equal(textOf(await pending), 'aborted');
  assert.equal(await post(provider.endpoint(slot.slotId).url), 404);
  assert.equal(provider.get(slot.slotId), undefined);
  assert.equal(mcpSlotProviderInternals(provider).hostSlot(slot.slotId), undefined);
  await provider.dispose(slot.slotId);
  await provider.dispose('f'.repeat(32));
});

// ---------------------------------------------------------------------------
// Session groups

test('a session group serves a copy of the catalog slot that has no URL of its own', async (t) => {
  const { provider } = await start(t);
  const { events, sink } = eventSink();
  const catalog = create(provider, 'chat-a', { exposedToolNames: new Set(['probe']), sink });
  const groupId = provider.createSessionGroup(catalog);
  const internals = mcpSlotProviderInternals(provider);
  const copy = internals.sessionGroupCatalog(groupId)!;
  assert.notEqual(copy.binding, catalog);
  assert.deepEqual(copy.binding, catalog);
  assert.notEqual(copy.slotId, catalog.slotId);
  assert.throws(() => copy.endpoint(), /routable: false/);
  assert.equal(await post(provider.endpoint(copy.slotId).url), 404);

  const client = await connect(t, provider.sessionEndpoint(groupId).url);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['probe'], 'the catalog\'s exposedToolNames applies to the group');
  assert.deepEqual(tools[0].inputSchema.required, ['session_id']);
  assert.equal((tools[0].inputSchema.properties as Record<string, { description?: string }>).session_id.description,
    DEFAULT_ANCHOR_DESCRIPTION);
  assert.deepEqual(events, []);

  provider.disposeSessionGroup(groupId);
  assert.equal(internals.sessionGroupCatalog(groupId), undefined);
  assert.equal(await post(provider.sessionEndpoint(groupId).url), 404);
  assert.throws(() => copy.rebind({ sessionKey: 'x' }), /disposed/, 'the catalog copy is disposed with its group');
  assert.doesNotThrow(() => provider.disposeSessionGroup(groupId));
});

test('sessionAnchorDescription describes the session_id argument to the agent', async (t) => {
  const { provider } = await start(t, {}, { sessionAnchorDescription: 'Current session id from the latest session context.' });
  const groupId = provider.createSessionGroup(create(provider, 'chat-a'));
  const [tool] = (await (await connect(t, provider.sessionEndpoint(groupId).url)).listTools()).tools
    .filter((entry) => entry.name === 'probe');
  assert.equal((tool.inputSchema.properties as Record<string, { description?: string }>).session_id.description,
    'Current session id from the latest session context.');
});

test('bindSession refuses unknown groups and slots, another session\'s slot, a slot without nodeId and an Agent Run slot', async (t) => {
  const { provider } = await start(t);
  const groupId = provider.createSessionGroup(create(provider, 'catalog'));
  const good = create(provider, 'native-1', { owner: chat('node-1') });
  const noNode = create(provider, 'native-2', {}, { nodeId: null });
  const runSlot = create(provider, 'native-3', { owner: run('attempt-1') });
  const disposed = create(provider, 'native-4');
  await provider.dispose(disposed.slotId);
  const refusals: Array<[string, string, string]> = [
    ['f'.repeat(32), 'native-1', good.slotId],
    [groupId, 'native-1', 'f'.repeat(32)],
    [groupId, 'native-4', disposed.slotId],
    [groupId, 'native-other', good.slotId],
    [groupId, 'native-2', noNode.slotId],
    [groupId, 'native-3', runSlot.slotId],
  ];
  for (const [group, session, slot] of refusals) {
    assert.throws(() => provider.bindSession(group, session, slot), /^Error: Invalid MCP chat session binding$/, `${session} ${slot}`);
  }
  assert.doesNotThrow(() => provider.bindSession(groupId, 'native-1', good.slotId));
});

test('turn window: calls route only between beginSessionTurn and its end; a rebinding closes it', async (t) => {
  const { provider } = await start(t);
  const groupId = provider.createSessionGroup(create(provider, 'catalog'));
  const one = create(provider, 'native-1');
  const internals = mcpSlotProviderInternals(provider);
  assert.throws(() => provider.beginSessionTurn(groupId, 'native-1'), /^Error: MCP session is not bound$/);
  assert.throws(() => provider.beginSessionTurn('f'.repeat(32), 'native-1'), /^Error: MCP session is not bound$/);
  provider.bindSession(groupId, 'native-1', one.slotId);
  const client = await connect(t, provider.sessionEndpoint(groupId).url);
  assert.match(textOf(await call(client, 'probe', { session_id: 'native-1' })), /no active turn/);
  assert.equal(internals.resolveSessionSlot(groupId, 'native-1'), undefined);

  const end = provider.beginSessionTurn(groupId, 'native-1');
  assert.equal(internals.resolveSessionSlot(groupId, 'native-1'), one);
  assert.equal(probed(await call(client, 'probe', { session_id: 'native-1' })).slotId, one.slotId);
  end();
  assert.match(textOf(await call(client, 'probe', { session_id: 'native-1' })), /no active turn/);

  provider.beginSessionTurn(groupId, 'native-1');
  provider.endSessionTurn(groupId, 'native-1');
  assert.equal(internals.resolveSessionSlot(groupId, 'native-1'), undefined);
  assert.doesNotThrow(() => provider.endSessionTurn('f'.repeat(32), 'native-1'));

  provider.beginSessionTurn(groupId, 'native-1');
  provider.bindSession(groupId, 'native-1', one.slotId);
  assert.equal(internals.resolveSessionSlot(groupId, 'native-1'), undefined, 'a rebinding starts with the window closed');
  assert.match(textOf(await call(client, 'probe', { session_id: 'native-1' })), /no active turn/);

  provider.beginSessionTurn(groupId, 'native-1');
  await provider.dispose(one.slotId);
  assert.equal(internals.resolveSessionSlot(groupId, 'native-1'), undefined);
  assert.match(textOf(await call(client, 'probe', { session_id: 'native-1' })), /not bound to this MCP endpoint/);
});

test('through a group, the bound slot\'s exposedToolNames decides its calls, after a rebind too', async (t) => {
  const { provider } = await start(t);
  const groupId = provider.createSessionGroup(create(provider, 'catalog'));
  const one = create(provider, 'native-1', { exposedToolNames: new Set(['probe']) });
  provider.bindSession(groupId, 'native-1', one.slotId);
  provider.beginSessionTurn(groupId, 'native-1');
  const client = await connect(t, provider.sessionEndpoint(groupId).url);
  assert.deepEqual(await toolNames(client), ['other', 'probe']);
  assert.match(textOf(await call(client, 'other', { session_id: 'native-1' })), /Unknown tool: other/);
  assert.equal(probed(await call(client, 'probe', { session_id: 'native-1' })).slotId, one.slotId);
  provider.rebind(one.slotId, { exposedToolNames: new Set(['other']) });
  assert.match(textOf(await call(client, 'probe', { session_id: 'native-1' })), /Unknown tool: probe/);
  assert.equal(probed(await call(client, 'other', { session_id: 'native-1' })).slotId, one.slotId);
});

test('mcpSlotProviderInternals knows only providers createMcpSlotProvider built', () => {
  const mcpHost: McpHost<McpSlot> = createMcpHost<McpSlot>();
  const provider = createMcpSlotProvider(mcpHost);
  assert.doesNotThrow(() => mcpSlotProviderInternals(provider));
  assert.throws(() => mcpSlotProviderInternals({ ...provider }), /Not an MCP slot provider built by createMcpSlotProvider/);
  void mcpHost.close();
});


test('page attribution belongs to a turn even when overlapping turns reuse the same getter', async (t) => {
  const { provider } = await start(t);
  const groupId = provider.createSessionGroup(create(provider, 'catalog'));
  const baseline = () => null;
  const slot = create(provider, 'native-pages', { getActivePageTurnAttribution: baseline });
  provider.bindSession(groupId, 'native-pages', slot.slotId);
  const getter = () => ({ turnId: 'turn-new', assistantId: 'assistant-new' });
  const endOld = provider.beginSessionTurn(groupId, 'native-pages', getter);
  const endNew = provider.beginSessionTurn(groupId, 'native-pages', getter);
  endOld();
  assert.equal(slot.getActivePageTurnAttribution, getter);
  assert.equal(mcpSlotProviderInternals(provider).resolveSessionSlot(groupId, 'native-pages'), slot);
  endNew();
  assert.equal(slot.getActivePageTurnAttribution, baseline);
  const lateEnd = provider.beginSessionTurn(groupId, 'native-pages', getter);
  provider.endSessionTurn(groupId, 'native-pages');
  assert.equal(slot.getActivePageTurnAttribution, baseline);
  lateEnd();
  assert.equal(slot.getActivePageTurnAttribution, baseline);
});
