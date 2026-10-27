import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createMcpHost,
  type HostToolDef,
  type McpHost,
  type McpSlotHandle,
  type SessionToolSink,
} from '../src/mcp-host';
import { isLoopbackAddress } from '../src/mcp-host/http';

type Binding = { workspace: string };
type Event = { type: string; payload?: unknown };
type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

function makeSink(over: Partial<SessionToolSink> = {}): SessionToolSink & { events: Event[] } {
  const events: Event[] = [];
  return { events, emit: (event) => { events.push(event); }, ...over };
}

/** Reports what the handler saw, so tests can assert on routing. */
const echoTool: HostToolDef<Binding> = {
  name: 'echo',
  description: 'Echo the arguments and the slot the call arrived on.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async handler(args, ctx) {
    ctx.sink.emit({ type: 'echoed', payload: args });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          args,
          slotId: ctx.slot.slotId,
          sessionKey: ctx.slot.sessionKey,
          cwd: ctx.slot.cwd,
          binding: ctx.slot.binding,
          toolCallId: ctx.toolCallId ?? null,
          aborted: ctx.signal.aborted,
        }),
      }],
    };
  },
};

async function startHost(t: TestContext, options?: Parameters<typeof createMcpHost>[0]) {
  const host = createMcpHost<Binding>(options);
  const listener = await host.listen();
  t.after(() => host.close());
  return { host, listener };
}

function slotOn(host: McpHost<Binding>, sessionKey: string, workspace: string,
  extra: Partial<Parameters<McpHost<Binding>['createSlot']>[0]> = {}): McpSlotHandle<Binding> {
  return host.createSlot({ sessionKey, cwd: `/work/${sessionKey}`, binding: { workspace }, sink: makeSink(), ...extra });
}

async function connect(t: TestContext, url: string): Promise<Client> {
  const client = new Client({ name: 'mcp-host-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(() => client.close());
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

async function call(client: Client, name: string, args: Record<string, unknown> = {},
  meta?: Record<string, unknown>): Promise<CallResult> {
  return await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) as CallResult;
}

function textOf(result: CallResult): string {
  return result.content.map((part) => part.text ?? '').join('');
}

function echoed(result: CallResult): Record<string, any> {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}):
Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'POST', headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Sends headers (and optionally a streamed body) and resolves with the first response status. */
function oversizedRequest(url: string, mode: 'declared' | 'chunked'): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (mode === 'declared') headers['content-length'] = String(5 * 1024 * 1024);
    else headers['transfer-encoding'] = 'chunked';
    const req = http.request(url, { method: 'POST', headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    // The server stops reading once it has answered; later write errors are expected.
    req.on('error', (error) => { if (!req.destroyed) reject(error); });
    if (mode === 'declared') {
      req.flushHeaders();
    } else {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      for (let i = 0; i < 65; i += 1) req.write(chunk); // 4 MiB + 64 KiB, never ended
    }
  });
}

// ---------------------------------------------------------------------------
// Slot ids and endpoints

test('slots get 128-bit hex ids and loopback http endpoints with empty headers', async (t) => {
  const { host, listener } = await startHost(t);
  assert.match(listener.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const a = slotOn(host, 'a', 'w1');
  const b = slotOn(host, 'b', 'w1');
  assert.match(a.slotId, /^[0-9a-f]{32}$/);
  assert.notEqual(a.slotId, b.slotId);
  assert.deepEqual(a.endpoint(), { type: 'http', url: `${listener.baseUrl}/mcp/${a.slotId}`, headers: [] });
  const group = host.createSessionGroup(a);
  assert.match(group.groupId, /^[0-9a-f]{32}$/);
  assert.deepEqual(group.endpoint(), { type: 'http', url: `${listener.baseUrl}/mcp-session/${group.groupId}`, headers: [] });
});

test('initialize reports serverName and serverVersion, and the tools capability', async (t) => {
  const plain = await startHost(t);
  const named = await startHost(t, { serverName: 'michi-tools', serverVersion: '1.0.0' });
  const serverOf = async (host: McpHost<Binding>) => {
    const client = await connect(t, slotOn(host, 'a', 'w1').endpoint().url);
    return { info: client.getServerVersion(), capabilities: client.getServerCapabilities() };
  };
  assert.deepEqual(await serverOf(plain.host), { info: { name: 'host', version: '0.0.0' }, capabilities: { tools: {} } });
  assert.deepEqual(await serverOf(named.host), { info: { name: 'michi-tools', version: '1.0.0' }, capabilities: { tools: {} } });
  assert.throws(() => createMcpHost<Binding>({ serverVersion: ' ' }), /serverVersion/);
});

test('endpoint() needs listen() or publicBaseUrl', () => {
  const host = createMcpHost<Binding>();
  const slot = slotOn(host, 'a', 'w1');
  assert.throws(() => slot.endpoint(), /listen\(\) or pass publicBaseUrl/);
  void host.close();
});

test('slotEndpoint(), sessionGroupEndpoint() and hookUrl() build the served URLs from the id alone', async (t) => {
  const { host, listener } = await startHost(t);
  host.registerTool(echoTool);
  host.registerHook('stop', async (slot) => ({ sessionKey: slot.sessionKey }));
  const slot = slotOn(host, 'a', 'w1');
  const group = host.createSessionGroup(slot);
  const json = { 'content-type': 'application/json' };
  assert.deepEqual(host.slotEndpoint(slot.slotId), slot.endpoint());
  assert.deepEqual(host.sessionGroupEndpoint(group.groupId), group.endpoint());
  assert.equal(host.hookUrl(slot.slotId, 'stop'), `${listener.baseUrl}/mcp-hooks/${slot.slotId}/stop`);
  assert.deepEqual(await toolNames(await connect(t, host.slotEndpoint(slot.slotId).url)), ['echo']);
  const hooked = await rawRequest(host.hookUrl(slot.slotId, 'stop'), { headers: json, body: '{}' });
  assert.equal(hooked.status, 200);
  assert.deepEqual(JSON.parse(hooked.body), { sessionKey: 'a' });
  assert.throws(() => host.hookUrl(slot.slotId, 'bad/name'), /Invalid MCP hook name/);

  // Unknown, disposed and routable: false slots have URLs too; they answer 404.
  const catalogOnly = slotOn(host, 'catalog', 'w1', { routable: false });
  const unknownId = 'e'.repeat(32);
  assert.equal(host.slotEndpoint(unknownId).url, `${listener.baseUrl}/mcp/${unknownId}`);
  await slot.dispose();
  for (const url of [slot.slotId, unknownId, catalogOnly.slotId].map((id) => host.slotEndpoint(id).url)
    .concat(host.sessionGroupEndpoint(group.groupId).url)) {
    const res = await rawRequest(url, { headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(res.status, 404, url);
  }
  assert.equal((await rawRequest(host.hookUrl(slot.slotId, 'stop'), { headers: json, body: '{}' })).status, 404);
});

test('the id URLs follow basePath and a publicBaseUrl function read on every call, and need a base URL', () => {
  const id = 'a'.repeat(32);
  let base: string | undefined = 'http://127.0.0.1:3000/api';
  const mounted = createMcpHost<Binding>({ basePath: '/mcp', publicBaseUrl: () => base });
  assert.deepEqual(mounted.slotEndpoint(id), { type: 'http', url: `http://127.0.0.1:3000/api/mcp/${id}`, headers: [] });
  assert.deepEqual(mounted.sessionGroupEndpoint(id), { type: 'http', url: `http://127.0.0.1:3000/api/mcp-session/${id}`, headers: [] });
  assert.equal(mounted.hookUrl(id, 'stop'), `http://127.0.0.1:3000/api/mcp-hooks/${id}/stop`);
  base = 'http://127.0.0.1:43117/api/';
  assert.equal(mounted.slotEndpoint(id).url, `http://127.0.0.1:43117/api/mcp/${id}`);
  base = undefined;
  assert.throws(() => mounted.slotEndpoint(id), /listen\(\) or pass publicBaseUrl/);
  assert.throws(() => mounted.sessionGroupEndpoint(id), /listen\(\) or pass publicBaseUrl/);
  assert.throws(() => mounted.hookUrl(id, 'stop'), /listen\(\) or pass publicBaseUrl/);

  const standalone = createMcpHost<Binding>({ basePath: '/api/mcp', publicBaseUrl: 'http://127.0.0.1:5000' });
  assert.equal(standalone.slotEndpoint(id).url, `http://127.0.0.1:5000/api/mcp/${id}`);
  assert.equal(standalone.sessionGroupEndpoint(id).url, `http://127.0.0.1:5000/api/mcp-session/${id}`);
  assert.equal(standalone.hookUrl(id, 'stop'), `http://127.0.0.1:5000/api/mcp-hooks/${id}/stop`);
  void mounted.close();
  void standalone.close();
});

// ---------------------------------------------------------------------------
// tools/list visibility

test('tools/list hides tools whose visible() is false and calls to them report an unknown tool', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'w1_only', visible: (slot) => slot.binding.workspace === 'w1' });
  const a = slotOn(host, 'a', 'w1');
  const b = slotOn(host, 'b', 'w2');
  const clientA = await connect(t, a.endpoint().url);
  const clientB = await connect(t, b.endpoint().url);

  assert.deepEqual(await toolNames(clientA), ['echo', 'w1_only']);
  assert.deepEqual(await toolNames(clientB), ['echo']);
  const hidden = await call(clientB, 'w1_only', { text: 'x' });
  assert.equal(hidden.isError, true);
  assert.match(textOf(hidden), /Unknown tool: w1_only/);

  b.rebind({ binding: { workspace: 'w1' } });
  assert.deepEqual(await toolNames(clientB), ['echo', 'w1_only']);
  assert.equal(echoed(await call(clientB, 'w1_only', { text: 'x' })).binding.workspace, 'w1');
});

test('tools/list exposes only allowTools entries, builtins included', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'other' });
  const slot = slotOn(host, 'a', 'w1', {
    allowTools: new Set(['echo', 'submit_result']),
    sink: makeSink({ askUser: async () => ({}) }),
    builtins: {
      askUser: true,
      structuredResult: { name: 'submit_result', inputSchema: { type: 'object' }, submit: () => ({ ok: true }) },
    },
  });
  const client = await connect(t, slot.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo', 'submit_result']);
  for (const name of ['other', 'ask_user']) {
    const result = await call(client, name, { text: 'x' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), new RegExp(`Unknown tool: ${name}`));
  }
});

test('rebind({ allowTools }) changes the exposed tools from the next request on; undefined exposes every tool', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'other' });
  const slot = slotOn(host, 'a', 'w1', { allowTools: new Set(['echo']) });
  const client = await connect(t, slot.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo']);

  const allow = new Set(['other']);
  slot.rebind({ allowTools: allow });
  allow.add('echo'); // copied, as by createSlot: the caller's later changes are not seen
  assert.deepEqual(await toolNames(client), ['other']);
  const hidden = await call(client, 'echo', { text: 'x' });
  assert.equal(hidden.isError, true);
  assert.match(textOf(hidden), /Unknown tool: echo/);
  assert.equal(echoed(await call(client, 'other', { text: 'x' })).sessionKey, 'a');

  slot.rebind({ sessionKey: 'b' });
  assert.deepEqual(await toolNames(client), ['other'], 'an absent allowTools key leaves the allow-list alone');
  slot.rebind({ allowTools: undefined });
  assert.deepEqual(await toolNames(client), ['echo', 'other']);
  assert.equal(echoed(await call(client, 'echo', { text: 'x' })).sessionKey, 'b');
});

test('rebind({ allowTools }) through a session group: the catalog slot lists, the bound slot runs', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'other' });
  const catalog = slotOn(host, 'catalog', 'w1', { routable: false });
  const bound = slotOn(host, 'one', 'w1');
  const group = host.createSessionGroup(catalog);
  group.bind('native-1', bound);
  group.beginTurn('native-1');
  const client = await connect(t, group.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo', 'other']);

  catalog.rebind({ allowTools: new Set(['echo']) });
  assert.deepEqual(await toolNames(client), ['echo']);
  bound.rebind({ allowTools: new Set(['other']) });
  const refused = await call(client, 'echo', { text: 'x', session_id: 'native-1' });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Unknown tool: echo/);
  assert.equal(echoed(await call(client, 'other', { text: 'x', session_id: 'native-1' })).slotId, bound.slotId);
});

test('builtin tools appear only when enabled: ask_user needs builtins.askUser and sink.askUser', async (t) => {
  const { host } = await startHost(t);
  const askUser = async () => ({});
  const structuredResult = { name: 'finish', inputSchema: { type: 'object' as const }, submit: () => ({ ok: true as const }) };
  const cases: Array<[Partial<Parameters<McpHost<Binding>['createSlot']>[0]>, string[]]> = [
    [{ builtins: { askUser: true }, sink: makeSink({ askUser }) }, ['ask_user']],
    [{ builtins: { askUser: true }, sink: makeSink() }, []],
    [{ builtins: {}, sink: makeSink({ askUser }) }, []],
    [{ sink: makeSink({ askUser }) }, []],
    [{ builtins: { structuredResult } }, ['finish']],
    [{ builtins: { askUser: true, structuredResult }, sink: makeSink({ askUser }) }, ['ask_user', 'finish']],
  ];
  for (const [extra, expected] of cases) {
    const slot = slotOn(host, 'case', 'w1', extra);
    const client = await connect(t, slot.endpoint().url);
    assert.deepEqual(await toolNames(client), expected);
  }
});

test('registerTool rejects duplicates and returns an unregister function', async (t) => {
  const { host } = await startHost(t);
  const off = host.registerTool(echoTool);
  assert.throws(() => host.registerTool(echoTool), /already registered/);
  assert.throws(() => host.registerTool({ ...echoTool, name: 'bad name' }), /Invalid MCP tool name/);
  const slot = slotOn(host, 'a', 'w1');
  const client = await connect(t, slot.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo']);
  off();
  assert.deepEqual(await toolNames(client), []);
});

// ---------------------------------------------------------------------------
// Tool sources

test('tool sources serve per-slot definitions in the order returned, re-evaluated on every request', async (t) => {
  const { host } = await startHost(t);
  host.registerToolSource((slot) => {
    const def = (name: string): HostToolDef<Binding> => ({ ...echoTool, name, description: `${name} in ${slot.binding.workspace}` });
    return slot.binding.workspace === 'w1' ? [def('zeta'), def('alpha')] : [def('alpha')];
  });
  const slot = slotOn(host, 'a', 'w1');
  const client = await connect(t, slot.endpoint().url);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => [tool.name, tool.description]), [['zeta', 'zeta in w1'], ['alpha', 'alpha in w1']]);
  assert.deepEqual(listed[0].inputSchema, echoTool.inputSchema);

  slot.rebind({ binding: { workspace: 'w2' } });
  assert.deepEqual((await client.listTools()).tools.map((tool) => [tool.name, tool.description]), [['alpha', 'alpha in w2']]);
  const gone = await call(client, 'zeta', { text: 'x' });
  assert.equal(gone.isError, true);
  assert.match(textOf(gone), /Unknown tool: zeta/);
  assert.deepEqual(echoed(await call(client, 'alpha', { text: 'x' })).binding, { workspace: 'w2' });
});

test('on a shared name builtins win over sources, earlier sources over later ones, and sources over registerTool', async (t) => {
  const { host } = await startHost(t);
  const tagged = (name: string, tag: string): HostToolDef<Binding> => ({
    ...echoTool,
    name,
    description: tag,
    handler: async () => ({ content: [{ type: 'text', text: tag }] }),
  });
  host.registerTool(tagged('shared', 'registered'));
  host.registerTool(tagged('registered_only', 'registered'));
  host.registerToolSource(() => [tagged('shared', 'first'), tagged('ask_user', 'first'), tagged('first_only', 'first')]);
  host.registerToolSource(() => [tagged('shared', 'second'), tagged('first_only', 'second'), tagged('second_only', 'second')]);
  const slot = slotOn(host, 'a', 'w1', { builtins: { askUser: true }, sink: makeSink({ askUser: async () => null }) });
  const client = await connect(t, slot.endpoint().url);

  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => tool.name), ['ask_user', 'shared', 'first_only', 'second_only', 'registered_only']);
  assert.deepEqual(listed.slice(1).map((tool) => tool.description), ['first', 'first', 'second', 'registered']);
  assert.notEqual(listed[0].description, 'first');
  assert.equal(textOf(await call(client, 'shared')), 'first');
  assert.equal(textOf(await call(client, 'first_only')), 'first');
  assert.match(textOf(await call(client, 'ask_user', { questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }] })),
    /did not answer/);
});

test('a shadowed entry is logged with the tool name and both origins; hidden duplicates are not', async (t) => {
  const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const { host } = await startHost(t, { log: (_level, msg, data) => { logs.push({ msg, data }); } });
  host.registerTool({ ...echoTool, name: 'dup' });
  host.registerTool({ ...echoTool, name: 'quiet' });
  host.registerToolSource(() => [
    { ...echoTool, name: 'dup' },
    { ...echoTool, name: 'ask_user' },
    { ...echoTool, name: 'quiet', visible: () => false },
  ]);
  host.registerToolSource(() => [{ ...echoTool, name: 'dup' }]);
  const slot = slotOn(host, 'a', 'w1', { builtins: { askUser: true }, sink: makeSink({ askUser: async () => null }) });
  const client = await connect(t, slot.endpoint().url);
  assert.deepEqual(await toolNames(client), ['ask_user', 'dup', 'quiet']);

  const shadowed = logs.filter((entry) => entry.msg === 'mcp host tool shadowed by an earlier entry with the same name')
    .map((entry) => [entry.data?.tool, entry.data?.shadowed, entry.data?.by]);
  assert.deepEqual(shadowed, [
    ['ask_user', 'tool source 0', 'builtin'],
    ['dup', 'tool source 1', 'tool source 0'],
    ['dup', 'registerTool', 'tool source 0'],
  ]);
});

test('a tool source that unregisters itself while the catalog is built does not drop the next source', async (t) => {
  const { host } = await startHost(t);
  let offFirst = () => {};
  offFirst = host.registerToolSource(() => {
    offFirst();
    return [{ ...echoTool, name: 'first' }];
  });
  host.registerToolSource(() => [{ ...echoTool, name: 'second' }]);
  const client = await connect(t, slotOn(host, 'a', 'w1').endpoint().url);
  assert.deepEqual(await toolNames(client), ['first', 'second']);
  assert.deepEqual(await toolNames(client), ['second']);
});

test('tool sources: invalid entries are skipped, allowTools and visible() apply, sources unregister', async (t) => {
  const logs: string[] = [];
  const { host } = await startHost(t, { log: (_level, msg) => { logs.push(msg); } });
  const source = (): HostToolDef<Binding>[] => [
    { ...echoTool, name: 'bad name' },
    { ...echoTool, name: 'no_schema', inputSchema: { type: 'string' } as never },
    { ...echoTool, name: 'hidden', visible: () => false },
    { ...echoTool, name: 'kept' },
    { ...echoTool, name: 'filtered' },
  ];
  const off = host.registerToolSource(source);
  assert.throws(() => host.registerToolSource(source), /already registered/);
  assert.throws(() => host.registerToolSource('nope' as never), /must be a function/);
  const slot = slotOn(host, 'a', 'w1', { allowTools: new Set(['bad name', 'no_schema', 'hidden', 'kept']) });
  const client = await connect(t, slot.endpoint().url);

  assert.deepEqual(await toolNames(client), ['kept']);
  assert.equal(echoed(await call(client, 'kept', { text: 'x' })).slotId, slot.slotId);
  assert.ok(logs.includes('mcp host skipped an invalid tool from a source'));
  off();
  assert.deepEqual(await toolNames(client), []);
});

test('sourceErrors "fail" (default): a failing source fails tools/list with HTTP 500 and tools/call with a catalog error', async (t) => {
  const logs: string[] = [];
  const { host } = await startHost(t, { log: (_level, msg) => { logs.push(msg); } });
  assert.throws(() => createMcpHost<Binding>({ sourceErrors: 'ignore' as never }), /sourceErrors/);
  let failure: 'throw' | 'not a list' | null = 'throw';
  host.registerToolSource(() => {
    if (failure === 'throw') throw new Error('database is locked');
    if (failure === 'not a list') return 'not a list' as never;
    return [{ ...echoTool, name: 'from_source' }];
  });
  host.registerTool(echoTool);
  const slot = slotOn(host, 'a', 'w1');
  const group = host.createSessionGroup(slot);
  group.bind('native-1', slot);
  group.beginTurn('native-1');
  const client = await connect(t, slot.endpoint().url);
  const groupClient = await connect(t, group.endpoint().url);

  for (const mode of ['throw', 'not a list'] as const) {
    failure = mode;
    await assert.rejects(client.listTools(), /tool catalog unavailable/, mode);
    await assert.rejects(groupClient.listTools(), /tool catalog unavailable/, mode);
    const raw = await rawRequest(slot.endpoint().url, {
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    assert.equal(raw.status, 500, mode);
    assert.deepEqual(JSON.parse(raw.body), { jsonrpc: '2.0', error: { code: -32603, message: 'tool catalog unavailable' }, id: 7 });
    for (const result of [
      await call(client, 'echo', { text: 'x' }),
      await call(groupClient, 'echo', { text: 'x', session_id: 'native-1' }),
    ]) {
      assert.equal(result.isError, true, mode);
      assert.equal(textOf(result), 'tool catalog unavailable', 'a failed catalog is not reported as an unknown tool');
    }
  }
  assert.ok(logs.includes('mcp host tool source threw; the tool catalog is unavailable'));
  assert.ok(logs.includes('mcp host tool source did not return an array; the tool catalog is unavailable'));

  failure = null;
  assert.deepEqual(await toolNames(client), ['echo', 'from_source']);
  assert.equal(echoed(await call(client, 'echo', { text: 'x' })).slotId, slot.slotId);
});

test('sourceErrors "skip": a failing source contributes no tools and the rest of the catalog is served', async (t) => {
  const logs: string[] = [];
  const { host } = await startHost(t, { sourceErrors: 'skip', log: (_level, msg) => { logs.push(msg); } });
  host.registerToolSource(() => { throw new Error('source broke'); });
  host.registerToolSource(() => 'not a list' as never);
  host.registerToolSource(() => [{ ...echoTool, name: 'from_source' }]);
  host.registerTool(echoTool);
  const slot = slotOn(host, 'a', 'w1');
  const client = await connect(t, slot.endpoint().url);

  assert.deepEqual(await toolNames(client), ['echo', 'from_source']);
  assert.equal(echoed(await call(client, 'from_source', { text: 'x' })).slotId, slot.slotId);
  for (const msg of [
    'mcp host tool source threw; it contributes no tools',
    'mcp host tool source did not return an array; it contributes no tools',
  ]) assert.ok(logs.includes(msg), msg);
});

// ---------------------------------------------------------------------------
// Host tool calls

test('tool handlers receive the slot binding, sessionKey, cwd, sink and toolCallId; rebind is seen by later calls', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const sink = makeSink();
  const slot = host.createSlot({ sessionKey: 'session-1', cwd: '/work/one', binding: { workspace: 'w1' }, sink });
  const client = await connect(t, slot.endpoint().url);

  const first = echoed(await call(client, 'echo', { text: 'hi' }, { 'claudecode/toolUseId': 'toolu_1' }));
  assert.deepEqual(first, {
    args: { text: 'hi' },
    slotId: slot.slotId,
    sessionKey: 'session-1',
    cwd: '/work/one',
    binding: { workspace: 'w1' },
    toolCallId: 'toolu_1',
    aborted: false,
  });
  assert.deepEqual(sink.events, [{ type: 'echoed', payload: { text: 'hi' } }]);

  slot.rebind({ sessionKey: 'session-2', binding: { workspace: 'w2' } });
  assert.equal(slot.sessionKey, 'session-2');
  const second = echoed(await call(client, 'echo', { text: 'again' }));
  assert.equal(second.sessionKey, 'session-2');
  assert.deepEqual(second.binding, { workspace: 'w2' });
  assert.equal(second.toolCallId, null);
});

test('a throwing tool handler becomes an isError result', async (t) => {
  const { host } = await startHost(t);
  host.registerTool({ ...echoTool, name: 'boom', handler: async () => { throw new Error('kaboom'); } });
  const client = await connect(t, slotOn(host, 'a', 'w1').endpoint().url);
  const result = await call(client, 'boom');
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'kaboom');
});

test('disposing a slot aborts its in-flight tool calls', async (t) => {
  const { host } = await startHost(t);
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  host.registerTool({
    ...echoTool,
    name: 'wait',
    handler: (_args, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }] }));
      started();
    }),
  });
  const slot = slotOn(host, 'a', 'w1');
  const client = await connect(t, slot.endpoint().url);
  const pending = call(client, 'wait');
  await running;
  await slot.dispose();
  assert.equal(textOf(await pending), 'aborted');
});

// ---------------------------------------------------------------------------
// Builtins

test('ask_user forwards normalized questions to sink.askUser and returns the answers or a skip notice', async (t) => {
  const { host } = await startHost(t);
  const asked: unknown[] = [];
  let reply: Record<string, string> | null = { 'Which color?': 'Red' };
  const slot = slotOn(host, 'a', 'w1', {
    builtins: { askUser: true },
    sink: makeSink({
      askUser: async (questions, signal) => {
        asked.push(questions);
        assert.ok(signal instanceof AbortSignal);
        return reply;
      },
    }),
  });
  const client = await connect(t, slot.endpoint().url);
  const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue', description: 'Cool' }] }];

  const answered = await call(client, 'ask_user', { questions });
  assert.notEqual(answered.isError, true);
  assert.deepEqual(JSON.parse(textOf(answered)), { answers: { 'Which color?': 'Red' } });
  assert.deepEqual(asked, [[{
    question: 'Which color?',
    header: 'Color',
    options: [{ label: 'Red' }, { label: 'Blue', description: 'Cool' }],
    multiSelect: false,
  }]]);

  reply = null;
  const skipped = await call(client, 'ask_user', { questions });
  assert.notEqual(skipped.isError, true);
  assert.match(textOf(skipped), /did not answer/);

  const invalid = await call(client, 'ask_user', { questions: [] });
  assert.equal(invalid.isError, true);
  assert.equal(asked.length, 2);
});

test('the structured result tool reports submit success and failure', async (t) => {
  const { host } = await startHost(t);
  const submitted: unknown[] = [];
  const slot = slotOn(host, 'a', 'w1', {
    builtins: {
      structuredResult: {
        name: 'submit_result',
        inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
        submit(value) {
          submitted.push(value);
          return typeof (value as { summary?: unknown }).summary === 'string'
            ? { ok: true }
            : { ok: false, error: 'summary is required' };
        },
      },
    },
  });
  const client = await connect(t, slot.endpoint().url);
  const [tool] = (await client.listTools()).tools;
  assert.equal(tool.name, 'submit_result');
  assert.deepEqual(tool.inputSchema.required, ['summary']);
  assert.ok(tool.description);

  const ok = await call(client, 'submit_result', { summary: 'done' });
  assert.notEqual(ok.isError, true);
  const failed = await call(client, 'submit_result', {});
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed), 'summary is required');
  assert.deepEqual(submitted, [{ summary: 'done' }, {}]);
});

// ---------------------------------------------------------------------------
// Session groups

test('session group lists the catalog slot tools with a required anchor argument', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'catalog_only', visible: (slot) => slot.binding.workspace === 'catalog' });
  host.registerTool({
    ...echoTool,
    name: 'conflicting',
    inputSchema: { type: 'object', properties: { session_id: { type: 'number' } } },
  });
  const catalog = slotOn(host, 'catalog', 'catalog');
  const group = host.createSessionGroup(catalog);
  const client = await connect(t, group.endpoint().url);

  const tools = (await client.listTools()).tools;
  // A tool that already declares the anchor argument cannot be routed and is left out.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['catalog_only', 'echo']);
  const echo = tools.find((tool) => tool.name === 'echo')!;
  assert.deepEqual(echo.inputSchema.required, ['text', 'session_id']);
  assert.equal((echo.inputSchema.properties as Record<string, { type: string }>).session_id.type, 'string');
  assert.equal((echo.inputSchema.properties as Record<string, { type: string }>).text.type, 'string');

  const custom = host.createSessionGroup(catalog, { anchorArg: 'acp_session' });
  const customClient = await connect(t, custom.endpoint().url);
  const customEcho = (await customClient.listTools()).tools.find((tool) => tool.name === 'echo')!;
  assert.deepEqual(customEcho.inputSchema.required, ['text', 'acp_session']);
});

test('session group routes calls by anchor to the bound slot and strips the anchor argument', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const sinks = { catalog: makeSink(), one: makeSink(), two: makeSink() };
  const catalog = slotOn(host, 'catalog', 'catalog', { sink: sinks.catalog });
  const one = slotOn(host, 'one', 'w1', { sink: sinks.one });
  const two = slotOn(host, 'two', 'w2', { sink: sinks.two });
  const group = host.createSessionGroup(catalog);
  group.bind('native-1', one);
  group.bind('native-2', two);
  const client = await connect(t, group.endpoint().url);

  const endOne = group.beginTurn('native-1');
  const endTwo = group.beginTurn('native-2');
  const first = echoed(await call(client, 'echo', { text: 'hi', session_id: 'native-1' }));
  assert.deepEqual(first.args, { text: 'hi' });
  assert.equal(first.slotId, one.slotId);
  assert.deepEqual(first.binding, { workspace: 'w1' });
  const second = echoed(await call(client, 'echo', { text: 'yo', session_id: 'native-2' }));
  assert.deepEqual(second.args, { text: 'yo' });
  assert.equal(second.slotId, two.slotId);
  // Each call reports to the bound slot's own sink; the catalog's gets nothing.
  assert.deepEqual(sinks.one.events, [{ type: 'echoed', payload: { text: 'hi' } }]);
  assert.deepEqual(sinks.two.events, [{ type: 'echoed', payload: { text: 'yo' } }]);
  assert.deepEqual(sinks.catalog.events, []);
  endOne();
  endTwo();
});

test('session group rejects a missing anchor, an unbound session and calls outside the turn window', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const catalog = slotOn(host, 'catalog', 'catalog');
  const one = slotOn(host, 'one', 'w1');
  const group = host.createSessionGroup(catalog);
  group.bind('native-1', one);
  const client = await connect(t, group.endpoint().url);

  const missing = await call(client, 'echo', { text: 'x' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /Missing required argument "session_id"/);

  const unbound = await call(client, 'echo', { text: 'x', session_id: 'native-unknown' });
  assert.equal(unbound.isError, true);
  assert.match(textOf(unbound), /not bound to this MCP endpoint/);

  const idle = await call(client, 'echo', { text: 'x', session_id: 'native-1' });
  assert.equal(idle.isError, true);
  assert.match(textOf(idle), /no active turn/);

  const endFirst = group.beginTurn('native-1');
  assert.equal(echoed(await call(client, 'echo', { text: 'x', session_id: 'native-1' })).slotId, one.slotId);
  endFirst();
  const ended = await call(client, 'echo', { text: 'x', session_id: 'native-1' });
  assert.match(textOf(ended), /no active turn/);

  // A stale end function must not close a newer turn.
  const endOld = group.beginTurn('native-1');
  const endNew = group.beginTurn('native-1');
  endOld();
  assert.equal(echoed(await call(client, 'echo', { text: 'x', session_id: 'native-1' })).slotId, one.slotId);
  endNew();

  assert.throws(() => group.beginTurn('native-unknown'), /not bound/);
  await one.dispose();
  const disposed = await call(client, 'echo', { text: 'x', session_id: 'native-1' });
  assert.match(textOf(disposed), /not bound to this MCP endpoint/);

  group.dispose();
  assert.equal((await rawRequest(group.endpoint().url, { headers: MCP_HEADERS, body: INITIALIZE })).status, 404);
});

test('session group anchorDescription describes the anchor argument to the agent', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const catalog = slotOn(host, 'catalog', 'catalog');
  const anchorOf = async (group: ReturnType<typeof host.createSessionGroup>) => {
    const client = await connect(t, group.endpoint().url);
    const [tool] = (await client.listTools()).tools;
    return (tool.inputSchema.properties as Record<string, unknown>).session_id;
  };
  assert.deepEqual(await anchorOf(host.createSessionGroup(catalog)), {
    type: 'string',
    minLength: 1,
    description: 'Session id of the calling agent session, as given in its session context.',
  });
  assert.deepEqual(await anchorOf(host.createSessionGroup(catalog, { anchorDescription: 'The current ACP SessionID.' })),
    { type: 'string', minLength: 1, description: 'The current ACP SessionID.' });
  assert.throws(() => host.createSessionGroup(catalog, { anchorDescription: ' ' }), /anchorDescription/);
});

test('session group resolve(), isTurnActive() and endTurn() report and close routing', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const catalog = slotOn(host, 'catalog', 'catalog');
  const one = slotOn(host, 'one', 'w1');
  const group = host.createSessionGroup(catalog);
  const client = await connect(t, group.endpoint().url);
  assert.equal(group.resolve('native-1'), undefined);
  assert.equal(group.isTurnActive('native-1'), false);

  group.bind('native-1', one);
  assert.equal(group.resolve('native-1')?.slotId, one.slotId);
  assert.deepEqual(group.resolve('native-1')?.binding, { workspace: 'w1' });
  assert.equal(group.isTurnActive('native-1'), false);
  const end = group.beginTurn('native-1');
  assert.equal(group.isTurnActive('native-1'), true);
  assert.equal(echoed(await call(client, 'echo', { text: 'x', session_id: 'native-1' })).slotId, one.slotId);

  // endTurn closes the window without the closer beginTurn returned.
  group.endTurn('native-1');
  assert.equal(group.isTurnActive('native-1'), false);
  assert.match(textOf(await call(client, 'echo', { text: 'x', session_id: 'native-1' })), /no active turn/);
  end();
  group.endTurn('native-unknown');

  group.beginTurn('native-1');
  await one.dispose();
  assert.equal(group.resolve('native-1'), undefined);
  assert.equal(group.isTurnActive('native-1'), false);

  const two = slotOn(host, 'two', 'w2');
  group.bind('native-2', two);
  group.beginTurn('native-2');
  group.dispose();
  assert.equal(group.resolve('native-2'), undefined);
  assert.equal(group.isTurnActive('native-2'), false);
  group.endTurn('native-2');
});

test('a slot created with routable: false has no URL of its own but still serves as a group catalog', async (t) => {
  const { host, listener } = await startHost(t);
  host.registerTool(echoTool);
  host.registerHook('stop', async () => ({ decision: 'block' }));
  assert.throws(() => slotOn(host, 'x', 'w1', { routable: 'no' as never }), /routable must be a boolean/);
  const catalog = slotOn(host, 'catalog', 'catalog', { routable: false });
  const bound = slotOn(host, 'one', 'w1');
  assert.throws(() => catalog.endpoint(), /routable: false/);
  for (const path of [`/mcp/${catalog.slotId}`, `/mcp-hooks/${catalog.slotId}/stop`]) {
    const res = await rawRequest(`${listener.baseUrl}${path}`, { headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(res.status, 404, path);
  }

  const group = host.createSessionGroup(catalog);
  group.bind('native-1', bound);
  group.beginTurn('native-1');
  const client = await connect(t, group.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo']);
  assert.equal(echoed(await call(client, 'echo', { text: 'x', session_id: 'native-1' })).slotId, bound.slotId);
});

// ---------------------------------------------------------------------------
// HTTP surface

test('unknown or malformed slot and group ids return 404', async (t) => {
  const { host, listener } = await startHost(t);
  slotOn(host, 'a', 'w1');
  const unknownId = 'f'.repeat(32);
  for (const path of [`/mcp/${unknownId}`, '/mcp/not-a-slot', `/mcp-session/${unknownId}`, `/mcp/${unknownId}/extra`, '/elsewhere']) {
    const res = await rawRequest(`${listener.baseUrl}${path}`, { headers: MCP_HEADERS, body: INITIALIZE });
    assert.equal(res.status, 404, path);
  }
});

test('requests carrying an Origin header return 403', async (t) => {
  const { host } = await startHost(t);
  let ran = false;
  host.registerTool({ ...echoTool, handler: async () => { ran = true; return { content: [] }; } });
  const slot = slotOn(host, 'a', 'w1');
  const res = await rawRequest(slot.endpoint().url, {
    headers: { ...MCP_HEADERS, origin: 'http://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }),
  });
  assert.equal(res.status, 403);
  assert.equal(ran, false);
});

test('GET and DELETE return 405', async (t) => {
  const { host } = await startHost(t);
  const slot = slotOn(host, 'a', 'w1');
  const group = host.createSessionGroup(slot);
  for (const url of [slot.endpoint().url, group.endpoint().url]) {
    for (const method of ['GET', 'DELETE']) {
      const res = await rawRequest(url, { method, headers: { accept: 'text/event-stream' } });
      assert.equal(res.status, 405, `${method} ${url}`);
      assert.equal(res.headers.allow, 'POST');
    }
  }
});

test('a disposed slot returns 404', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const slot = slotOn(host, 'a', 'w1');
  const client = await connect(t, slot.endpoint().url);
  assert.deepEqual(await toolNames(client), ['echo']);
  await slot.dispose();
  const res = await rawRequest(slot.endpoint().url, { headers: MCP_HEADERS, body: INITIALIZE });
  assert.equal(res.status, 404);
  await assert.rejects(client.listTools());
  assert.throws(() => slot.rebind({ sessionKey: 'x' }), /disposed/);
});

test('hook routes return the handler result as JSON; unregistered hooks return 404', async (t) => {
  const { host, listener } = await startHost(t);
  const off = host.registerHook('stop', async (slot, body) => ({ decision: 'block', sessionKey: slot.sessionKey, body }));
  host.registerHook('quiet', async () => undefined);
  const slot = slotOn(host, 'hooked', 'w1');
  const hookUrl = (name: string, slotId = slot.slotId) => `${listener.baseUrl}/mcp-hooks/${slotId}/${name}`;
  const json = { 'content-type': 'application/json' };

  const ok = await rawRequest(hookUrl('stop'), { headers: json, body: JSON.stringify({ hook_event_name: 'Stop' }) });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type']), /application\/json/);
  assert.deepEqual(JSON.parse(ok.body), { decision: 'block', sessionKey: 'hooked', body: { hook_event_name: 'Stop' } });

  const quiet = await rawRequest(hookUrl('quiet'), { headers: json, body: '{}' });
  assert.equal(quiet.status, 200);
  assert.deepEqual(JSON.parse(quiet.body), {});

  assert.equal((await rawRequest(hookUrl('missing'), { headers: json, body: '{}' })).status, 404);
  assert.equal((await rawRequest(hookUrl('stop', 'a'.repeat(32)), { headers: json, body: '{}' })).status, 404);
  assert.equal((await rawRequest(hookUrl('stop'), { method: 'GET' })).status, 405);
  assert.equal((await rawRequest(hookUrl('stop'), { headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await rawRequest(hookUrl('stop'), { headers: json, body: '{not json' })).status, 400);
  assert.throws(() => host.registerHook('stop', async () => ({})), /already registered/);

  off();
  assert.equal((await rawRequest(hookUrl('stop'), { headers: json, body: '{}' })).status, 404);
});

test('request bodies over 4 MB return 413', async (t) => {
  const { host } = await startHost(t);
  host.registerTool(echoTool);
  const slot = slotOn(host, 'a', 'w1');
  assert.equal(await oversizedRequest(slot.endpoint().url, 'declared'), 413);
  assert.equal(await oversizedRequest(slot.endpoint().url, 'chunked'), 413);

  // A large body under the limit is still served.
  const client = await connect(t, slot.endpoint().url);
  const text = 'x'.repeat(3 * 1024 * 1024);
  assert.equal(echoed(await call(client, 'echo', { text })).args.text.length, text.length);
});

test('maxBodyBytes sets the request body limit', async (t) => {
  for (const maxBodyBytes of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => createMcpHost<Binding>({ maxBodyBytes }), /maxBodyBytes/, String(maxBodyBytes));
  }
  const small = await startHost(t, { maxBodyBytes: 1024 });
  small.host.registerTool(echoTool);
  const tooLarge = await rawRequest(slotOn(small.host, 'a', 'w1').endpoint().url, {
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x'.repeat(2048) } } }),
  });
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.body, /exceeds 1024 bytes/);

  const large = await startHost(t, { maxBodyBytes: 8 * 1024 * 1024 });
  large.host.registerTool(echoTool);
  const client = await connect(t, slotOn(large.host, 'b', 'w1').endpoint().url);
  const text = 'x'.repeat(5 * 1024 * 1024);
  assert.equal(echoed(await call(client, 'echo', { text })).args.text.length, text.length);
});

test('handler() mounted on a host server uses publicBaseUrl and refuses non-loopback peers', async (t) => {
  let base = '';
  const host = createMcpHost<Binding>({ basePath: '/api/mcp', publicBaseUrl: () => base });
  host.registerTool(echoTool);
  const handle = host.handler();
  const server = http.createServer((req, res) => {
    const spoofed = req.headers['x-test-remote-address'];
    if (typeof spoofed === 'string') {
      Object.defineProperty(req.socket, 'remoteAddress', { value: spoofed, configurable: true });
    }
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const slot = slotOn(host, 'mounted', 'w1');
  assert.equal(slot.endpoint().url, `${base}/api/mcp/${slot.slotId}`);
  const group = host.createSessionGroup(slot);
  assert.equal(group.endpoint().url, `${base}/api/mcp-session/${group.groupId}`);
  const client = await connect(t, slot.endpoint().url);
  assert.equal(echoed(await call(client, 'echo', { text: 'via host' })).sessionKey, 'mounted');

  for (const remote of ['10.0.0.5', '::ffff:192.168.1.2', '2001:db8::1']) {
    const res = await rawRequest(slot.endpoint().url, {
      headers: { ...MCP_HEADERS, 'x-test-remote-address': remote },
      body: INITIALIZE,
    });
    assert.equal(res.status, 403, remote);
  }
  // A reverse proxy on the same machine arrives from loopback but forwards a remote caller.
  const proxyHeaders: Array<Record<string, string>> = [
    { 'x-forwarded-for': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }, { 'x-real-ip': '203.0.113.7' },
    { via: '1.1 proxy.example' }, { 'x-forwarded-host': 'michi.example' }, { 'x-forwarded-proto': 'https' },
  ];
  for (const forwarded of proxyHeaders) {
    const res = await rawRequest(slot.endpoint().url, { headers: { ...MCP_HEADERS, ...forwarded }, body: INITIALIZE });
    assert.equal(res.status, 403, JSON.stringify(forwarded));
  }
});

test('isLoopbackAddress accepts only 127.0.0.0/8, ::1 and IPv4-mapped 127.x', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.9.9.9']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of [undefined, '', '10.0.0.1', '128.0.0.1', '::ffff:10.0.0.1', '::2', '0.0.0.0', '::', 'localhost', '127.0.0.256']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('host.close() stops the listener and clears every registry', async () => {
  const host = createMcpHost<Binding>();
  host.registerTool(echoTool);
  const listener = await host.listen();
  await assert.rejects(host.listen(), /already listening/);
  const slot = slotOn(host, 'a', 'w1');
  const url = slot.endpoint().url;
  await host.close();
  await assert.rejects(rawRequest(url, { headers: MCP_HEADERS, body: INITIALIZE }));
  assert.throws(() => slotOn(host, 'b', 'w1'), /closed/);
  assert.throws(() => host.registerTool({ ...echoTool, name: 'late' }), /closed/);
  await listener.close(); // idempotent
});

// ---------------------------------------------------------------------------
// Logging

test('logs never contain a full slot or group id', async (t) => {
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const { host, listener } = await startHost(t, { log: (level, msg, data) => { logs.push({ level, msg, data }); } });
  host.registerTool(echoTool);
  host.registerTool({ ...echoTool, name: 'boom', handler: async () => { throw new Error('kaboom'); } });
  host.registerHook('stop', async () => { throw new Error('hook failed'); });
  const catalog = slotOn(host, 'catalog', 'catalog');
  const slot = slotOn(host, 'a', 'w1');
  const group = host.createSessionGroup(catalog);
  group.bind('native-1', slot);
  const end = group.beginTurn('native-1');

  const client = await connect(t, slot.endpoint().url);
  await client.listTools();
  await call(client, 'echo', { text: 'x' });
  await call(client, 'boom');
  const groupClient = await connect(t, group.endpoint().url);
  await groupClient.listTools();
  await call(groupClient, 'echo', { text: 'x', session_id: 'native-1' });
  await call(groupClient, 'boom', { session_id: 'native-1' });
  end();
  await rawRequest(`${listener.baseUrl}/mcp-hooks/${slot.slotId}/stop`, { headers: { 'content-type': 'application/json' }, body: '{}' });
  const unknownId = 'e'.repeat(32);
  await rawRequest(`${listener.baseUrl}/mcp/${unknownId}`, { headers: MCP_HEADERS, body: INITIALIZE });
  await rawRequest(slot.endpoint().url, { headers: { ...MCP_HEADERS, origin: 'http://evil.example' }, body: INITIALIZE });
  group.dispose();
  await slot.dispose();
  await rawRequest(slot.endpoint().url, { headers: MCP_HEADERS, body: INITIALIZE });
  await rawRequest(group.endpoint().url, { headers: MCP_HEADERS, body: INITIALIZE });

  assert.ok(logs.length >= 8, `expected a log trail, got ${logs.length}`);
  const prefix = `${slot.slotId.slice(0, 4)}…`;
  assert.ok(logs.some((entry) => JSON.stringify(entry).includes(prefix)), 'redacted slot ids are logged');
  for (const entry of logs) {
    const line = JSON.stringify(entry);
    for (const id of [slot.slotId, catalog.slotId, group.groupId, unknownId]) {
      assert.equal(line.includes(id), false, `log leaks a full id: ${line}`);
    }
  }
});
