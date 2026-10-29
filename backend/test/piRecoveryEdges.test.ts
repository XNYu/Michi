import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PiSession, streamSimpleWithFallback } from '../src/agents/pi/PiSession';
import { PiSdkSession } from '../src/agents/pi/PiSdkSession';
import { McpClientManager } from '../src/services/mcpClientManager';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner } from './helpers/owners';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function drain(iterator: AsyncIterable<NormalizedEvent>) {
  const events: NormalizedEvent[] = [];
  for await (const event of iterator) events.push(event);
  return events;
}
const nativeImport = new Function('name', 'return import(name)') as (name: string) => Promise<any>;
const model = { id: 'pi-model', contextWindow: 1000 };
const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const sessionDeps = {
  bridge, preamble: '', cwd: '/tmp', workspaceId: null, ownerUserId: null, enableFollowUps: false,
  requestedProvider: 'deepseek', requestedModel: 'pi-model',
  owner: chatOwner('pi-node'), profileHash: 'profile',
};

async function streamModule() {
  const ai = await nativeImport('@earendil-works/pi-ai/compat');
  return { createAssistantMessageEventStream: ai.createAssistantMessageEventStream };
}

test('Pi already-aborted producer settles result and iterator without starting a provider', async () => {
  const ai = await streamModule();
  const abort = new AbortController();
  abort.abort();
  const stream = streamSimpleWithFallback({ ...ai, streamSimple() { assert.fail('provider must not start'); } },
    'test', [model], {}, { signal: abort.signal });
  assert.equal((await stream.result()).stopReason, 'aborted');
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'aborted');
});

for (const failure of ['throw', 'event'] as const) {
  test(`Pi ${failure} cancellation never retries a fallback model`, async () => {
    const ai = await streamModule();
    let calls = 0;
    const stream = streamSimpleWithFallback({
      ...ai,
      streamSimple() {
        calls++;
        if (failure === 'throw') throw new DOMException('cancelled', 'AbortError');
        const inner = ai.createAssistantMessageEventStream();
        inner.push({ type: 'error', reason: 'aborted', error: { stopReason: 'aborted' } });
        return inner;
      },
    }, 'test', [model, { id: 'fallback' }], {}, {});
    assert.equal((await stream.result()).stopReason, 'aborted');
    assert.equal(calls, 1);
  });
}

test('Pi abort between model attempts settles the stream instead of rejecting an unobserved producer', async () => {
  const ai = await streamModule();
  const abort = new AbortController();
  let calls = 0;
  const stream = streamSimpleWithFallback({
    ...ai,
    streamSimple: () => {
      calls++;
      return (async function* () {
        try { yield { type: 'error', reason: 'error', error: { stopReason: 'error' } }; }
        finally { abort.abort(); }
      })();
    },
  }, 'test', [model, { id: 'fallback' }], {}, { signal: abort.signal });
  assert.equal((await stream.result()).stopReason, 'aborted');
  assert.equal(calls, 1);
});

test('Pi non-abort provider errors still fall back and streams missing a terminal event settle as errors', async () => {
  const ai = await streamModule();
  let calls = 0;
  const stream = streamSimpleWithFallback({ ...ai, streamSimple() {
    const inner = ai.createAssistantMessageEventStream();
    calls++;
    inner.push(calls === 1
      ? { type: 'error', reason: 'error', error: { stopReason: 'error' } }
      : { type: 'done', reason: 'stop', message: { stopReason: 'stop' } });
    return inner;
  } }, 'test', [model, { id: 'fallback' }], {}, {});
  assert.equal((await stream.result()).stopReason, 'stop');
  assert.equal(calls, 2);
  const incomplete = streamSimpleWithFallback({ ...ai, streamSimple: async function* () { yield { type: 'start' }; } },
    'test', [model], {}, {});
  assert.match((await incomplete.result()).errorMessage, /without a terminal event/);
});

function sessionFixture(t: TestContext, onPrompt?: (agent: any, text: string) => Promise<void>) {
  configureRuntimeDeps({
    dataDir: process.env.HOME,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null },
    providerKeys: { getProviderApiKey: () => 'fake-key' },
    agentConfig: { getAgentConfig: () => ({ provider: 'deepseek' } as any), resolveModel: () => 'pi-model', resolveReasoning: () => undefined },
  });
  t.after(__resetRuntimeDeps);
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  t.mock.method(require('../src/agents/pi/piTools'), 'buildPiTools', () => []);
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ Type: {}, clampThinkingLevel: () => 'off' }));
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
  const agents: any[] = [];
  const prompts: string[] = [];
  class Agent {
    state: any;
    subscriber: ((event: any) => void) | undefined;
    aborts = 0;
    constructor(public options: any) { this.state = options.initialState; agents.push(this); }
    subscribe(fn: (event: any) => void) { this.subscriber = fn; return () => { this.subscriber = undefined; }; }
    emit(event: any) { this.subscriber?.(event); }
    abort() { this.aborts++; }
    async prompt(text: string) {
      prompts.push(text);
      this.state.messages.push({ role: 'user', content: text });
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
      await onPrompt?.(this, text);
      this.emit({ type: 'agent_end' });
    }
  }
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAgentCore', async () => ({ Agent }));
  const session = new PiSession('pi-node', sessionDeps);
  t.after(() => session.destroy());
  return { session, agents, prompts };
}

test('Pi timed-out cleanup reports unavailable, rejects overlap, and resumes the same Agent after late settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const { session, agents, prompts } = sessionFixture(t, async (_agent, text) => { if (text === 'A') await gate.promise; });
  const events = drain(session.send('A'));
  await tick();
  const agent = agents[0];
  const nativeHistory = agent.state.messages;
  const toolHistory = { role: 'toolResult', toolCallId: 'keep-native-tool-history' };
  nativeHistory.push(toolHistory);
  session.cancel();
  await tick();
  t.mock.timers.tick(5_000);
  const ended = await events;
  assert.ok(ended.some((ev) => ev.kind === 'retry_end' && ev.detail?.includes('restart the backend')));
  assert.ok(ended.some((ev) => ev.kind === 'runtime_error' && ev.recoveryRequired === true));
  assert.equal(session.describeNativeState().status, 'unavailable');
  assert.equal(session.describeNativeState().recoveryRequired, true);
  const history = [...session.getHistory()];
  await assert.rejects(drain(session.send('blocked')), { code: 'PI_SESSION_UNAVAILABLE' });
  assert.deepEqual(prompts, ['A']);
  assert.deepEqual(session.getHistory(), history);
  gate.resolve();
  await tick();
  assert.equal(session.describeNativeState().status, 'idle');
  await drain(session.send('B'));
  assert.equal(agents.length, 1);
  assert.equal(agent.state.messages, nativeHistory);
  assert.ok(nativeHistory.includes(toolHistory));
  assert.deepEqual(session.owner, sessionDeps.owner);
  assert.equal(session.runtimeProfileHash, 'profile');
  assert.deepEqual(prompts, ['A', 'B']);
});

test('Pi cooperative cancellation preserves live history without an unavailable transition', async (t) => {
  const gate = deferred();
  const { session, agents } = sessionFixture(t, async (_agent, text) => { if (text === 'A') await gate.promise; });
  const first = drain(session.send('A'));
  await tick();
  session.cancel();
  gate.resolve();
  assert.deepEqual((await first).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  await drain(session.send('B'));
  assert.equal(agents.length, 1);
  assert.deepEqual(session.getHistory().map((message) => message.content), ['A', 'partial', 'B', 'partial']);
  assert.equal(session.describeNativeState().recoveryRequired, false);
});

test('Pi cancellation releases a pending permission broker without allowing a late ask to create a banner', async (t) => {
  const { session, agents } = sessionFixture(t);
  const decision = deferred<'ask'>();
  (session as any).permissionBroker = { requestPermission: () => decision.promise };
  await drain(session.send('init'));
  const banners: NormalizedEvent[] = [];
  (session as any).activePush = (event: NormalizedEvent) => banners.push(event);
  const controller = new AbortController();
  const waiting = agents[0].options.beforeToolCall({ toolCall: { name: 'bash' }, args: {} }, controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await rejected;
  decision.resolve('ask');
  await tick();
  assert.deepEqual(banners, []);
  assert.equal((session as any).pendingPermissions.size, 0);
});

test('legacy Pi SDK class uses the real session contract and status', () => {
  const session = new PiSdkSession('pi-node', sessionDeps);
  (session as any).markUnavailable('Injected cleanup failure.');
  assert.equal(session.currentModelId, 'pi-model');
  assert.equal(session.describeNativeState().kind, 'pi-agent-core');
  assert.equal(session.describeNativeState().status, 'unavailable');
  session.destroy();
});

function sdkFixture(t: TestContext) {
  const controls = {
    connect: async () => {},
    discover: async (): Promise<{ tools: any[] }> => ({ tools: [] }),
    close: async () => {},
  };
  const clients: any[] = [];
  const transports: any[] = [];
  function Client() {
    const client = {
      connectSignal: undefined as AbortSignal | undefined,
      discoverySignal: undefined as AbortSignal | undefined,
      closes: 0,
      async connect(_transport: unknown, options: any) { this.connectSignal = options.signal; await controls.connect(); },
      async listTools(_params: unknown, options: any) { this.discoverySignal = options.signal; return controls.discover(); },
      async close() { this.closes++; await controls.close(); },
    };
    clients.push(client);
    return client;
  }
  function Transport() {
    const transport = { closes: 0, async close() { this.closes++; await controls.close(); } };
    transports.push(transport);
    return transport;
  }
  t.mock.method(require('@modelcontextprotocol/sdk/client/index.js'), 'Client', Client);
  t.mock.method(require('@modelcontextprotocol/sdk/client/stdio.js'), 'StdioClientTransport', Transport);
  const logger = require('../src/services/logger').log;
  for (const key of ['info', 'warn', 'error']) t.mock.method(logger, key, () => {});
  return { controls, clients, transports };
}

for (const stage of ['connect', 'discover'] as const) {
  test(`MCP cancellation during ${stage} closes the tracked transport and never installs a late connection`, async (t) => {
    const { controls, clients, transports } = sdkFixture(t);
    const gate = deferred<any>();
    controls[stage] = () => gate.promise;
    const manager = new McpClientManager();
    const abort = new AbortController();
    const connecting = manager.connect({ serverName: 'test', command: 'never-spawned' }, abort.signal);
    const rejected = assert.rejects(connecting, { name: 'AbortError' });
    await tick();
    assert.equal(transports.length, 1);
    abort.abort();
    await rejected;
    assert.equal(clients[0].connectSignal.aborted, true);
    if (stage === 'discover') assert.equal(clients[0].discoverySignal.aborted, true);
    assert.equal(transports[0].closes, 1);
    gate.resolve({ tools: [] });
    await tick();
    assert.deepEqual(manager.connectedServers(), []);
    await manager.dispose();
  });
}

test('MCP shares one initializing connection and dispose aborts it during discovery', async (t) => {
  const { controls, clients, transports } = sdkFixture(t);
  const gate = deferred<any>();
  controls.discover = () => gate.promise;
  const manager = new McpClientManager();
  const config = { serverName: 'test', command: 'never-spawned' };
  const a = assert.rejects(manager.connect(config), { name: 'AbortError' });
  const b = assert.rejects(manager.connect(config), { name: 'AbortError' });
  await tick();
  assert.equal(transports.length, 1);
  await manager.dispose();
  await Promise.all([a, b]);
  assert.equal(clients[0].discoverySignal.aborted, true);
  assert.equal(transports[0].closes, 1);
  gate.resolve({ tools: [] });
  await tick();
  assert.deepEqual(manager.connectedServers(), []);
});

test('MCP handshake has a deadline even when the SDK ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controls, clients, transports } = sdkFixture(t);
  controls.connect = () => new Promise(() => {});
  const manager = new McpClientManager();
  const failed = assert.rejects(manager.connect({ serverName: 'test', command: 'never-spawned' }), /setup timed out/);
  await tick();
  t.mock.timers.tick(30_000);
  await failed;
  assert.equal(clients[0].connectSignal.aborted, true);
  assert.equal(transports[0].closes, 1);
  await manager.dispose();
});

test('MCP teardown is bounded and an unconfirmed close prevents reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controls, transports } = sdkFixture(t);
  const gate = deferred();
  controls.close = () => gate.promise;
  const manager = new McpClientManager();
  await manager.connect({ serverName: 'test', command: 'never-spawned' });
  const failed = assert.rejects(manager.disconnect('test'), { code: 'MCP_CLEANUP_TIMEOUT' });
  await tick();
  t.mock.timers.tick(5_000);
  await failed;
  await assert.rejects(manager.connect({ serverName: 'test', command: 'never-spawned' }), { code: 'MCP_CLEANUP_TIMEOUT' });
  assert.equal(transports.length, 1);
  gate.resolve();
  await manager.dispose();
});

test('Pi can retry cancelled MCP setup only after its old transport is closed', async (t) => {
  const { session, agents, prompts } = sessionFixture(t);
  const { controls, transports } = sdkFixture(t);
  const handshake = deferred();
  controls.connect = () => handshake.promise;
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => [{ serverName: 'test', command: 'never-spawned' }]);
  const first = drain(session.send('cancelled setup'));
  await tick();
  session.cancel();
  assert.deepEqual((await first).at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
  assert.equal(transports[0].closes, 1);
  assert.equal(agents.length, 0);
  assert.equal(session.describeNativeState().recoveryRequired, false);
  controls.connect = async () => {};
  await drain(session.send('retry'));
  handshake.resolve();
  await tick();
  assert.equal(transports.length, 2);
  assert.equal(agents.length, 1);
  assert.deepEqual(prompts, ['retry']);
  assert.equal(session.getHistory()[0].content, 'cancelled setup');
  assert.deepEqual(session.owner, sessionDeps.owner);
});

for (const action of ['cancel', 'destroy'] as const) {
  test(`Pi ${action} owns initializing MCP resources until bounded cleanup completes`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { session, agents } = sessionFixture(t);
    const { controls, transports } = sdkFixture(t);
    const handshake = deferred();
    const close = deferred();
    controls.connect = () => handshake.promise;
    controls.close = () => close.promise;
    t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => [{ serverName: 'test', command: 'never-spawned' }]);
    const running = drain(session.send('A'));
    await tick();
    assert.ok((session as any).mcpManager);
    session[action]();
    await tick();
    if (action === 'cancel') await assert.rejects(drain(session.send('too early')), /still stopping/);
    assert.equal(transports.length, 1);
    t.mock.timers.tick(5_000);
    const events = await running;
    assert.ok(events.some((event) => event.kind === 'runtime_error' && event.recoveryRequired === true));
    assert.equal(session.describeNativeState().recoveryRequired, true);
    if (action === 'cancel') await assert.rejects(drain(session.send('still blocked')), { code: 'PI_SESSION_UNAVAILABLE' });
    assert.equal(transports.length, 1);
    assert.equal(agents.length, 0);
    handshake.resolve();
    close.resolve();
    await tick();
    assert.equal(agents.length, 0);
  });
}

test('Pi retries failed MCP server catalogs on later turns and emits setup warnings', async (t) => {
  const { session, agents } = sessionFixture(t);
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => [
    { serverName: 'ready', command: 'unused' }, { serverName: 'retry', command: 'unused' },
  ]);
  const connected = new Set<string>();
  const calls: string[] = [];
  let retryCalls = 0;
  const manager = {
    connectedServers: () => [...connected],
    async connect(config: { serverName: string }) {
      calls.push(config.serverName);
      if (config.serverName === 'retry' && ++retryCalls === 1) throw new Error('catalog unavailable');
      connected.add(config.serverName);
    },
    async dispose() { connected.clear(); },
  };
  const owners: unknown[] = [];
  t.mock.method(require('../src/services/mcpClientManager'), 'McpClientManager', function(options: unknown) {
    owners.push(options); return manager;
  });
  t.mock.method(require('../src/agents/pi/mcpToolBridge'), 'buildMcpToolsForPi', () =>
    [...connected].map((name) => ({ name: `mcp__${name}__tool` })));
  const first = await drain(session.send('first'));
  assert.ok(first.some((event) => event.kind === 'warning' && event.source === 'mcp'
    && event.category === 'setup' && event.serverName === 'retry'));
  assert.deepEqual(agents[0].state.tools.map((tool: any) => tool.name), ['mcp__ready__tool']);
  const second = await drain(session.send('second'));
  assert.equal(second.some((event) => event.kind === 'warning'), false);
  assert.deepEqual(calls, ['ready', 'retry', 'retry'], 'successful servers are retained; only failed server retries');
  assert.deepEqual(owners, [{ ownerUserId: null }]);
  assert.deepEqual(agents[0].state.tools.map((tool: any) => tool.name), ['mcp__ready__tool', 'mcp__retry__tool']);
});

test('Pi invalid MCP config warns without failing the turn and is retried', async (t) => {
  const { session } = sessionFixture(t);
  let reads = 0;
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => {
    if (++reads === 1) throw new Error('invalid JSON config');
    return [];
  });
  const first = await drain(session.send('first'));
  assert.ok(first.some((event) => event.kind === 'warning' && event.source === 'mcp' && event.code === 'MCP_CONFIG_INVALID'));
  const second = await drain(session.send('second'));
  assert.equal(second.some((event) => event.kind === 'warning'), false);
  assert.equal(reads, 2);
});

test('cloud Pi never reads or spawns process-global desktop MCP configuration', async (t) => {
  const { session } = sessionFixture(t);
  const previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  t.after(() => { if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud; });
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => assert.fail('cloud must not read desktop configs'));
  t.mock.method(require('../src/services/mcpClientManager'), 'McpClientManager', () => assert.fail('cloud must not start a global child process'));
  const events = await drain(session.send('cloud task'));
  assert.ok(events.some((event) => event.kind === 'warning' && event.source === 'mcp' && event.category === 'setup'
    && event.code === 'MCP_CLOUD_CONFIG_UNAVAILABLE'));
  assert.ok(events.some((event) => event.kind === 'turn_end'));
});
