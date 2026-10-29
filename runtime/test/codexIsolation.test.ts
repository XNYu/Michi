import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { McpSlot, McpSlotCallbacks, McpSlotProvider } from '../src/contract/mcp';
import type { NormalizedEvent } from '../src/contract/events';
import type { RuntimeToolProfile } from '../src/contract/types';
import { createDefaultHost } from '../src/core/defaultHost';
import { CodexRpcError, CodexRpcTimeoutError, type CodexAppServerClient, type ServerRequestHandler } from '../src/adapters/codex/CodexAppServerClient';
import { CodexRuntime } from '../src/adapters/codex/CodexRuntime';
import { CODEX_RESTRICTED_SUBAGENT_ERROR, type CodexSession } from '../src/adapters/codex/CodexSession';
import { CODEX_HOST_MCP_SERVER, codexDisableMcpServers, codexOpenUserMcpServers } from '../src/adapters/codex/codexProtocol';
import { CODEX_RESTRICTED_MULTI_AGENT_V2 } from '../src/adapters/codex/codexRestrictedProfile';
import { codexSpawnSignal } from '../src/adapters/codex/codexCollab';

// Shapes are codex 0.165.0's, as probed in .probe/codex (item5 offline MCP
// isolation; item6 limit-v2 and interrupt): config/read, mcpServerStatus/list,
// subAgentActivity and the child's turn/started with the parent's rootTurnId.

type Handler = (method: string, params: Record<string, unknown>) => void;
interface Request { method: string; params: Record<string, any> }

interface FakeOptions {
  /** MCP servers config/read reports for the cwd. */
  userServers?: string[];
  /** runtimeStatus mcpServerStatus/list reports for each user server. */
  userStatus?: string;
  configReadError?: Error;
  /** thread/start, thread/resume and thread/fork reject a config this returns true for (once). */
  rejectConfig?: (config: Record<string, any>) => Error | null;
  interruptFails?: boolean;
}

function fakeAppServer(options: FakeOptions = {}) {
  const requests: Request[] = [];
  const perThread = new Map<string, Set<Handler>>();
  const global = new Set<Handler>();
  let threads = 0;
  const turnIds = new Map<string, string>();
  const users = options.userServers ?? [];
  const emit = (threadId: string, method: string, params: Record<string, unknown>) => {
    const full = { threadId, ...params };
    for (const handler of global) handler(method, full);
    for (const handler of perThread.get(threadId) ?? []) handler(method, full);
  };
  const open = (method: string, params: Record<string, any>, id: string) => {
    const error = options.rejectConfig?.(params.config ?? {});
    if (error) throw error;
    return method === 'thread/resume' ? { thread: { id: params.threadId } } : { thread: { id } };
  };
  const client = {
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, any>) => {
      requests.push({ method, params });
      switch (method) {
        case 'config/read':
          if (options.configReadError) throw options.configReadError;
          return { config: { mcp_servers: Object.fromEntries(users.map((name) => [name, { command: name }])) }, origins: {} };
        case 'mcpServerStatus/list':
          return { data: [
            { name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected', tools: {} },
            ...users.map((name) => ({ name, runtimeStatus: options.userStatus ?? 'disabled', tools: {} })),
          ] };
        case 'thread/start':
          return open(method, params, params.ephemeral ? `title-${++threads}` : `thread-${++threads}`);
        case 'thread/fork':
          return open(method, params, `fork-${++threads}`);
        case 'thread/resume':
          return open(method, params, params.threadId);
        case 'turn/start': {
          const id = `turn-${params.threadId}`;
          turnIds.set(params.threadId, id);
          if (String(params.threadId).startsWith('title-')) {
            queueMicrotask(() => emit(params.threadId, 'turn/completed', { turn: { id, status: 'completed' } }));
          }
          return { turn: { id } };
        }
        case 'turn/interrupt':
          if (options.interruptFails) throw new CodexRpcError('turn/interrupt', -32600, 'no active turn');
          return {};
        case 'model/list':
          return { data: [] };
        default:
          return {};
      }
    },
    onNotification: (threadId: string, handler: Handler) => {
      let set = perThread.get(threadId);
      if (!set) perThread.set(threadId, (set = new Set()));
      set.add(handler);
      return () => { set.delete(handler); };
    },
    onGlobalNotification: (handler: Handler) => { global.add(handler); return () => { global.delete(handler); }; },
    onServerRequest: (_handler: ServerRequestHandler) => {},
    onExit: () => () => {},
    shutdown: async () => {},
    isRunning: () => true,
  };
  return {
    client: client as unknown as CodexAppServerClient,
    requests,
    emit,
    turnId: (threadId: string) => turnIds.get(threadId)!,
    find: (method: string, pred: (params: Record<string, any>) => boolean = () => true) => requests.find((r) => r.method === method && pred(r.params)),
    all: (method: string) => requests.filter((r) => r.method === method),
  };
}

function slotProvider(): McpSlotProvider {
  let slots = 0;
  return {
    create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: McpSlotCallbacks) =>
      ({ slotId: `slot-${++slots}`, parentChatId, cwd, ownerUserId, nodeId: null, workspaceId: null, ...cbs }) as McpSlot,
    dispose: async () => {},
    endpoint: (slotId: string) => ({ type: 'http', url: `http://127.0.0.1:1/api/mcp/${slotId}`, headers: [] }),
    hookEndpoint: (slotId: string) => `http://127.0.0.1:1/mcp-hooks/${slotId}/stop`,
  } as unknown as McpSlotProvider;
}

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
const restricted: RuntimeToolProfile = { allowedToolNames: ['read_node'], restricted: true };

function setup(t: TestContext, options: FakeOptions & { nodes?: Array<Record<string, unknown>>; title?: boolean } = {}) {
  const server = fakeAppServer(options);
  const warnings: Array<{ msg: string; data: unknown }> = [];
  const sink = { debug() {}, info() {}, error() {}, warn: (msg: string, data?: unknown) => { warnings.push({ msg, data }); } };
  const host = createDefaultHost({
    logLevel: 'warn', logSink: sink, nodes: (options.nodes ?? []) as never,
    ...(options.title ? { ports: { title: { enabled: () => true, prompt: () => '' } } } : {}),
  });
  const runtime = new CodexRuntime({ host, bridge, mcpSlots: slotProvider() }, { client: server.client, followUpsHookPocEnabled: false });
  t.after(() => runtime.shutdown());
  return { server, runtime, warnings };
}

/** Starts a turn of `session`; resolves with its events once `finish` has ended it. */
function startTurn(server: ReturnType<typeof fakeAppServer>, session: CodexSession) {
  const events: NormalizedEvent[] = [];
  const done = (async () => { for await (const event of session.send('hello')) events.push(event); })();
  const started = (async () => {
    for (let i = 0; i < 200 && !server.find('turn/start', (p) => p.threadId === session.threadId); i += 1) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setImmediate(r));
  })();
  return { events, done, started };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Codex MCP isolation in ordinary threads', () => {
  it('disables the user\'s servers by name on every open, keeps Michi\'s, and checks the result', async (t) => {
    const { server, runtime, warnings } = setup(t, {
      userServers: ['builder-mcp', 'asana', CODEX_HOST_MCP_SERVER],
      nodes: [{ id: 'chat-old', workspace_id: '', kind: 'chat', status: 'idle', runtime_id: 'codex', external_session_id: 'thread-old' }],
    });
    const chat = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    await runtime.forkSession({ sessionId: 'chat-b', cwd: os.tmpdir(), model: 'm', parentChatId: 'chat-a', sourceNativeSessionId: chat.threadId });
    await runtime.loadSession({ sessionId: 'chat-old', cwd: os.tmpdir(), model: 'm' });
    for (const method of ['thread/start', 'thread/fork', 'thread/resume']) {
      const servers = server.find(method)!.params.config.mcp_servers;
      assert.deepEqual(servers['builder-mcp'], { enabled: false }, method);
      assert.deepEqual(servers.asana, { enabled: false }, method);
      assert.ok(servers[CODEX_HOST_MCP_SERVER].url, `${method} keeps Michi's own server`);
    }
    assert.deepEqual(server.all('config/read').map((r) => r.params), [{ cwd: os.tmpdir() }, { cwd: os.tmpdir() }, { cwd: os.tmpdir() }]);
    assert.equal(server.all('mcpServerStatus/list').length, 3);
    assert.deepEqual(chat.userMcpServers.filter((name) => name !== CODEX_HOST_MCP_SERVER), ['builder-mcp', 'asana']);
    assert.deepEqual(warnings, []);
  });

  it('only warns when a user server is still open, and the chat opens', async (t) => {
    const { server, runtime, warnings } = setup(t, { userServers: ['plugin-mcp'], userStatus: 'connected' });
    const chat = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    assert.equal(chat.threadId, 'thread-1');
    assert.ok(server.find('mcpServerStatus/list', (p) => p.threadId === 'thread-1'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].msg, /still runs MCP servers outside Michi/);
    assert.deepEqual((warnings[0].data as { servers: string[] }).servers, ['plugin-mcp']);
  });

  it('opens the chat when config/read fails, warning that the servers stay enabled', async (t) => {
    const { server, runtime, warnings } = setup(t, { configReadError: new CodexRpcError('config/read', -32603, 'boom') });
    await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' });
    assert.deepEqual(Object.keys(server.find('thread/start')!.params.config.mcp_servers), [CODEX_HOST_MCP_SERVER]);
    assert.match(warnings[0].msg, /config\/read failed/);
  });

  it('reopens without the disable list when Codex refuses that configuration, but never after a timeout', async (t) => {
    let refusals = 0;
    const refusing = setup(t, {
      userServers: ['odd'],
      rejectConfig: (config) => config.mcp_servers?.odd && refusals++ === 0
        ? new CodexRpcError('thread/start', -32600, 'failed to load configuration: mcp_servers.odd: invalid transport') : null,
    });
    const chat = await refusing.runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    const starts = refusing.server.all('thread/start');
    assert.equal(starts.length, 2);
    assert.equal(starts[1].params.config.mcp_servers.odd, undefined);
    assert.deepEqual(chat.userMcpServers, []);
    assert.ok(refusing.warnings.some((w) => /refused the thread config/.test(w.msg)));

    const timing = setup(t, { userServers: ['odd'], rejectConfig: () => new CodexRpcTimeoutError('codex thread/start got no response within 1ms') });
    await assert.rejects(timing.runtime.newSession({ sessionId: 'chat-b', cwd: os.tmpdir(), model: 'm' }), CodexRpcTimeoutError);
    assert.equal(timing.server.all('thread/start').length, 1, 'an ambiguous timeout is not retried');
  });

  it('disables the same servers in the title thread', async (t) => {
    const { server, runtime } = setup(t, { userServers: ['builder-mcp'], title: true });
    const chat = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    const turn = startTurn(server, chat);
    await turn.started;
    for (let i = 0; i < 100 && !server.find('thread/start', (p) => p.ephemeral); i += 1) await tick();
    const title = server.find('thread/start', (p) => p.ephemeral);
    assert.ok(title, 'title thread started');
    assert.deepEqual(title.params.config, { features: { goals: false }, mcp_servers: { 'builder-mcp': { enabled: false } } });
    server.emit(chat.threadId, 'turn/completed', { turn: { id: server.turnId(chat.threadId), status: 'completed' } });
    await turn.done;
  });

  it('builds the config pieces', () => {
    const base = { mcp_servers: { [CODEX_HOST_MCP_SERVER]: { url: 'u' } }, features: { goals: false } };
    assert.equal(codexDisableMcpServers(base, [CODEX_HOST_MCP_SERVER]), base, 'nothing to disable keeps the object');
    assert.deepEqual(codexDisableMcpServers(base, ['a']).mcp_servers, { a: { enabled: false }, [CODEX_HOST_MCP_SERVER]: { url: 'u' } });
    assert.deepEqual(codexOpenUserMcpServers([
      { name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'starting' }, { name: 'a', runtimeStatus: 'disabled' }, { name: 'b', runtimeStatus: 'connected' },
    ]), ['b']);
  });
});

describe('Codex restricted sessions refuse sub-agents', () => {
  it('starts the thread with the one-thread limit, so Codex refuses the spawn', async (t) => {
    const { server, runtime } = setup(t);
    await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted });
    assert.deepEqual(server.find('thread/start')!.params.config.features.multi_agent_v2, CODEX_RESTRICTED_MULTI_AGENT_V2);
    assert.deepEqual(CODEX_RESTRICTED_MULTI_AGENT_V2, { enabled: false, max_concurrent_threads_per_session: 1 });
  });

  it('falls back to the plain switch when app-server rejects the multi_agent_v2 table', async (t) => {
    const { server, runtime, warnings } = setup(t, {
      rejectConfig: (config) => typeof config.features?.multi_agent_v2 === 'object'
        ? new CodexRpcError('thread/start', -32600, 'failed to load configuration: invalid type: map, expected a boolean for key `features.multi_agent_v2`') : null,
    });
    await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted });
    const starts = server.all('thread/start');
    assert.equal(starts.length, 2);
    assert.equal(starts[1].params.config.features.multi_agent_v2, false);
    assert.ok(warnings.some((w) => /sub-agent limit/.test(w.msg)));
  });

  it('stops the turn and the child as soon as a sub-agent starts anyway', async (t) => {
    const { server, runtime } = setup(t);
    const session = await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted }) as CodexSession;
    const turn = startTurn(server, session);
    await turn.started;
    const parentTurn = server.turnId(session.threadId);
    server.emit(session.threadId, 'turn/started', { turn: { id: parentTurn, rootTurnId: parentTurn, status: 'inProgress' } });
    server.emit(session.threadId, 'item/started', { turnId: parentTurn, item: { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/child' } });
    await tick();
    assert.ok(server.find('turn/interrupt', (p) => p.threadId === session.threadId && p.turnId === parentTurn), 'parent turn interrupted');
    // The child's turn descends from the parent's; interrupting the parent does not stop it.
    server.emit('child-1', 'turn/started', { turn: { id: 'child-turn', rootTurnId: parentTurn, status: 'inProgress' } });
    server.emit('child-1', 'item/agentMessage/delta', { turnId: 'child-turn', itemId: 'm', delta: '1\n2\n' });
    await tick();
    assert.equal(server.all('turn/interrupt').filter((r) => r.params.threadId === 'child-1' && r.params.turnId === 'child-turn').length, 1,
      'child turn interrupted once');
    server.emit(session.threadId, 'turn/completed', { turn: { id: parentTurn, status: 'interrupted' } });
    await turn.done;
    const error = turn.events.find((e) => e.kind === 'runtime_error') as Extract<NormalizedEvent, { kind: 'runtime_error' }>;
    assert.equal(error.error, CODEX_RESTRICTED_SUBAGENT_ERROR);
    assert.equal(error.code, 'codex_subagent_blocked');
    assert.equal(turn.events.filter((e) => e.kind === 'runtime_error').length, 1);
    assert.deepEqual(turn.events.at(-1), { kind: 'turn_end', stopReason: 'error' });
    assert.equal(session.hasBackgroundWork(), false, 'a stopped child is not background work');
    // A later turn of that child is stopped as well.
    server.emit('child-1', 'turn/started', { turn: { id: 'child-turn-2', rootTurnId: parentTurn, status: 'inProgress' } });
    await tick();
    assert.ok(server.find('turn/interrupt', (p) => p.threadId === 'child-1' && p.turnId === 'child-turn-2'));
  });

  it('stops a turn whose child shows up only by its turn (no spawn item)', async (t) => {
    const { server, runtime } = setup(t);
    const session = await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted }) as CodexSession;
    const turn = startTurn(server, session);
    await turn.started;
    const parentTurn = server.turnId(session.threadId);
    server.emit(session.threadId, 'turn/started', { turn: { id: parentTurn, rootTurnId: parentTurn, status: 'inProgress' } });
    server.emit('child-2', 'turn/started', { turn: { id: 'child-turn', rootTurnId: parentTurn, status: 'inProgress' } });
    await tick();
    assert.ok(server.find('turn/interrupt', (p) => p.threadId === 'child-2'));
    assert.ok(server.find('turn/interrupt', (p) => p.threadId === session.threadId));
    server.emit(session.threadId, 'turn/completed', { turn: { id: parentTurn, status: 'interrupted' } });
    await turn.done;
    assert.ok(turn.events.some((e) => e.kind === 'runtime_error' && e.code === 'codex_subagent_blocked'));
  });

  it('recovers by restart when Codex will not stop the parent turn', async (t) => {
    const { server, runtime } = setup(t, { interruptFails: true });
    const session = await runtime.newSession({ sessionId: 'chat-r', cwd: os.tmpdir(), model: 'm', toolProfile: restricted }) as CodexSession;
    const turn = startTurn(server, session);
    await turn.started;
    const parentTurn = server.turnId(session.threadId);
    server.emit(session.threadId, 'item/started', { turnId: parentTurn, item: { type: 'subAgentActivity', id: 'c', kind: 'started', agentThreadId: 'child-3' } });
    await turn.done;
    assert.equal(session.requiresRestart, true);
    assert.equal(session.needsRecovery(), true);
    assert.ok(turn.events.some((e) => e.kind === 'runtime_error' && e.code === 'codex_subagent_blocked'));
  });

  it('leaves an ordinary chat\'s sub-agents alone', async (t) => {
    const { server, runtime } = setup(t);
    const session = await runtime.newSession({ sessionId: 'chat-a', cwd: os.tmpdir(), model: 'm' }) as CodexSession;
    const turn = startTurn(server, session);
    await turn.started;
    const parentTurn = server.turnId(session.threadId);
    server.emit(session.threadId, 'item/started', { turnId: parentTurn, item: { type: 'subAgentActivity', id: 'c', kind: 'started', agentThreadId: 'child-4' } });
    server.emit('child-4', 'turn/started', { turn: { id: 'child-turn', rootTurnId: parentTurn, status: 'inProgress' } });
    await tick();
    assert.equal(server.all('turn/interrupt').length, 0);
    server.emit(session.threadId, 'turn/completed', { turn: { id: parentTurn, status: 'completed' } });
    await turn.done;
    assert.ok(!turn.events.some((e) => e.kind === 'runtime_error'));
    assert.equal(server.find('thread/start')!.params.config.features.multi_agent_v2, undefined);
  });

  it('recognizes both spawn signals', () => {
    assert.deepEqual(codexSpawnSignal({ type: 'subAgentActivity', kind: 'started', agentThreadId: 'c' }), { childThreadId: 'c' });
    assert.equal(codexSpawnSignal({ type: 'subAgentActivity', kind: 'completed', agentThreadId: 'c' }), null);
    assert.deepEqual(codexSpawnSignal({ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: [] }), { childThreadId: null });
    assert.equal(codexSpawnSignal({ type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['c'] }), null);
    assert.equal(codexSpawnSignal({ type: 'agentMessage' }), null);
  });
});
