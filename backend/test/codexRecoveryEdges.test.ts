import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRuntime } from '../src/agents/codex/CodexRuntime';
import { CodexSession } from '../src/agents/codex/CodexSession';
import type { CodexAppServerClient, NotificationHandler, ServerRequestHandler } from '../src/agents/codex/CodexAppServerClient';
import { generateCodexTitle } from '../src/agents/codex/codexTitleGenerator';
import type { NewAgentSessionOptions, RuntimePermissionDecision } from '../src/agents/types';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { NormalizedEvent } from '../src/services/chatEvents';
import * as db from '../src/services/dbRepository';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function drain(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const result: NormalizedEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

type Request = { method: string; params: Record<string, unknown>; timeoutMs?: number };
class Client {
  readonly calls: Request[] = [];
  readonly handlers = new Map<string, Set<NotificationHandler>>();
  readonly exits = new Set<() => void>();
  serverRequest: ServerRequestHandler | null = null;
  respond: ((request: Request) => Promise<unknown> | undefined) | undefined;
  running = true;
  shutdownError: Error | null = null;
  private sequence = 0;

  async request(method: string, raw: unknown, timeoutMs?: number): Promise<unknown> {
    const request = { method, params: raw as Record<string, unknown>, timeoutMs };
    this.calls.push(request);
    const custom = this.respond?.(request);
    if (custom) return custom;
    if (method === 'thread/start') return { thread: { id: `thread-${++this.sequence}` } };
    if (method === 'thread/resume') return { thread: { id: request.params.threadId } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.sequence}` } };
    if (method === 'model/list') return { data: [] };
    return {};
  }
  onNotification(id: string, handler: NotificationHandler): () => void {
    const handlers = this.handlers.get(id) ?? new Set<NotificationHandler>();
    this.handlers.set(id, handlers);
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }
  onGlobalNotification(): () => void { return () => {}; }
  onServerRequest(handler: ServerRequestHandler): void { this.serverRequest = handler; }
  onExit(handler: () => void): () => void { this.exits.add(handler); return () => { this.exits.delete(handler); }; }
  async ensureStarted(): Promise<void> { this.running = true; }
  isRunning(): boolean { return this.running; }
  hasPendingRequests(): boolean { return false; }
  async shutdown(): Promise<void> {
    this.calls.push({ method: 'shutdown', params: {} });
    if (this.shutdownError) throw this.shutdownError;
    this.running = false;
  }
  emit(threadId: string, method: string, params: Record<string, unknown>): void {
    for (const handler of this.handlers.get(threadId) ?? []) handler(method, { threadId, ...params });
  }
  control(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => { this.serverRequest!(method, params, resolve); });
  }
  get transport(): CodexAppServerClient { return this as unknown as CodexAppServerClient; }
}

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
function registry(): McpSlotRegistry {
  let sequence = 0;
  return {
    create: (_id: string, _cwd: string, _owner: unknown, callbacks: object) => ({ slotId: `slot-${++sequence}`, ...callbacks }),
    dispose: async () => {},
    get: () => undefined,
  } as unknown as McpSlotRegistry;
}
function runtime(t: TestContext, client = new Client()) {
  const value = new CodexRuntime(bridge, registry(), 1, { client: client.transport, followUpsHookPocEnabled: false });
  t.after(async () => { client.shutdownError = null; await value.shutdown(); });
  return { runtime: value, client };
}
function options(id: string): NewAgentSessionOptions & { sessionId: string } {
  return { sessionId: id, cwd: '/tmp', model: 'test-model', profileHash: 'profile',
    owner: { kind: 'agent_run', runId: `run-${id}`, attemptId: id } };
}
async function create(value: CodexRuntime, id: string): Promise<CodexSession> {
  return await value.newSession(options(id)) as CodexSession;
}
function currentTurn(session: CodexSession): string {
  const id = session.describeNativeState().activeNativeTurnId;
  assert.equal(typeof id, 'string');
  return id as string;
}
function complete(client: Client, session: CodexSession, status = 'completed'): void {
  client.emit(session.threadId, 'turn/completed', { turn: { id: currentTurn(session), status } });
}

test('queued recovery waiters serialize and each resumes its original thread', async (t) => {
  const { runtime: value, client } = runtime(t);
  const sessions = await Promise.all(['a', 'b', 'c'].map((id) => create(value, id)));
  const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
  client.respond = ({ method, params }) => {
    if (method !== 'thread/resume') return;
    const gate = deferred<unknown>();
    gates.set(String(params.threadId), gate);
    return gate.promise;
  };
  sessions.forEach((session) => session.markCrashed('injected transport loss'));
  const turns = sessions.map((session) => drain(session.send('resume')));
  await tick();
  assert.equal(gates.size, 1);
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    assert.equal(gates.size, index + 1);
    gates.get(session.threadId)!.resolve({ thread: { id: session.threadId } });
    await tick();
    complete(client, session);
  }
  for (const events of await Promise.all(turns)) {
    assert.deepEqual(events.filter((event) => event.kind.startsWith('retry_')).map((event) => event.kind), ['retry_start', 'retry_end']);
  }
  assert.equal(client.calls.filter((call) => call.method === 'shutdown').length, 0);
});

test('recovery RPC deadline includes time already spent queued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { runtime: value, client } = runtime(t);
  const a = await create(value, 'budget-a');
  const b = await create(value, 'budget-b');
  const gate = deferred<unknown>();
  client.respond = ({ method, params }) => method === 'thread/resume' && params.threadId === a.threadId ? gate.promise : undefined;
  a.markCrashed('injected'); b.markCrashed('injected');
  const first = drain(a.send('A'));
  await tick();
  t.mock.timers.tick(10_000);
  const second = drain(b.send('B'));
  await tick();
  t.mock.timers.tick(5_000);
  gate.resolve({ thread: { id: a.threadId } });
  await tick();
  const request = client.calls.find((call) => call.method === 'thread/resume' && call.params.threadId === b.threadId);
  assert.equal(request?.timeoutMs, 15_000);
  complete(client, a); complete(client, b);
  await Promise.all([first, second]);
});

test('expired recovery waiters neither start later nor release unfinished native recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { runtime: value, client } = runtime(t);
  const a = await create(value, 'expired-a');
  const b = await create(value, 'expired-b');
  const gate = deferred<unknown>();
  client.respond = ({ method }) => method === 'thread/resume' ? gate.promise : undefined;
  a.markCrashed('injected'); b.markCrashed('injected');
  const first = assert.rejects(drain(a.send('A')), /exceeded 20 seconds/);
  const second = assert.rejects(drain(b.send('B')), /exceeded 20 seconds/);
  await tick();
  t.mock.timers.tick(20_000);
  await Promise.all([first, second]);
  assert.equal(client.calls.filter((call) => call.method === 'thread/resume').length, 1);
  gate.resolve({ thread: { id: a.threadId } });
  await tick();
  assert.equal(a.needsRecovery(), true);
  assert.equal(b.needsRecovery(), true);
  assert.equal(client.calls.filter((call) => call.method === 'turn/start').length, 0);
});

test('one confirmed restart clears peer restart requirements without interrupting new work', async (t) => {
  const { runtime: value, client } = runtime(t);
  const a = await create(value, 'restart-a');
  const b = await create(value, 'restart-b');
  for (const session of [a, b]) { session.requiresRestart = true; session.markCrashed('uncertain native completion'); }
  const first = drain(a.send('A'));
  await tick();
  assert.equal(a.isBusy(), true);
  assert.equal(b.requiresRestart, false);
  assert.equal(b.needsRecovery(), true);
  const second = drain(b.send('B'));
  await tick();
  assert.equal(client.calls.filter((call) => call.method === 'shutdown').length, 1);
  assert.equal(client.calls.filter((call) => call.method === 'thread/resume').length, 2);
  complete(client, a); complete(client, b);
  await Promise.all([first, second]);
});

test('transport loss followed by a warm daemon does not trigger another restart', async (t) => {
  const { runtime: value, client } = runtime(t);
  const session = await create(value, 'warm-restart');
  session.requiresRestart = true;
  client.running = false;
  for (const exit of client.exits) exit();
  await client.ensureStarted();
  const turn = drain(session.send('resume'));
  await tick();
  assert.equal(client.calls.filter((call) => call.method === 'shutdown').length, 0);
  assert.equal(session.requiresRestart, false);
  complete(client, session);
  await turn;
});

test('unconfirmed shutdown preserves restart requirements and does not resume', async (t) => {
  const { runtime: value, client } = runtime(t);
  const session = await create(value, 'unsafe-restart');
  session.requiresRestart = true;
  session.markCrashed('injected');
  client.shutdownError = new Error('exit unconfirmed');
  await assert.rejects(drain(session.send('resume')), /exit unconfirmed/);
  assert.equal(session.requiresRestart, true);
  assert.equal(client.calls.filter((call) => call.method === 'thread/resume').length, 0);
});

for (const status of ['interrupted', 'failed']) {
  test(`cancelled ${status} completion settles before a missing start response without restarting`, async (t) => {
    const client = new Client();
    const gate = deferred<unknown>();
    client.respond = ({ method, params }) => method === 'turn/start' && (params.input as Array<{ text: string }>)[0].text === 'A'
      ? gate.promise : undefined;
    const session = new CodexSession({ nodeId: 'node', threadId: 'original', cwd: '/tmp', workspaceId: null,
      client: client.transport, bridge, mcpRegistry: registry(), mcpPort: 1, cancelTimeoutMs: 10 });
    session.wireNotifications();
    t.after(() => session.dispose());
    const first = drain(session.send('A'));
    await tick();
    client.emit('original', 'turn/started', { turn: { id: 'old-turn' } });
    await session.cancel();
    client.emit('original', 'turn/completed', { turn: { id: 'old-turn', status, error: { message: 'injected' } } });
    assert.equal((await first).at(-1)?.kind, 'turn_end');
    assert.equal(session.needsRecovery(), false);
    assert.equal(session.requiresRestart, false);
    const second = drain(session.send('B'));
    await tick();
    const nextId = currentTurn(session);
    gate.resolve({ turn: { id: 'old-turn' } });
    await tick();
    assert.equal(currentTurn(session), nextId);
    client.emit('original', 'item/agentMessage/delta', { turnId: 'old-turn', delta: 'STALE' });
    client.emit('original', 'item/agentMessage/delta', { turnId: nextId, delta: 'clean' });
    complete(client, session);
    assert.deepEqual((await second).filter((event) => event.kind === 'chunk'), [{ kind: 'chunk', text: 'clean' }]);
  });
}

test('title timeout latches interruption for a late native ID without touching the next turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new Client();
  const gate = deferred<unknown>();
  client.respond = ({ method }) => method === 'turn/start' ? gate.promise : undefined;
  const remembered: string[] = [];
  const title = assert.rejects(generateCodexTitle({ client: client.transport, cwd: '/tmp', model: 'title-model', userText: 'title',
    timeoutMs: 10, signal: new AbortController().signal, onTurnStarted: (_thread, id) => remembered.push(id) }), /timed out/);
  await tick();
  t.mock.timers.tick(10);
  await title;
  gate.resolve({ turn: { id: 'late-title' } });
  await tick();
  assert.deepEqual(remembered, []);
  assert.deepEqual(client.calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params),
    [{ threadId: 'thread-1', turnId: 'late-title' }]);
});

for (const decision of ['allow_once', 'allow_always', 'ask'] as const) {
  test(`late broker ${decision} cannot approve or enqueue controls after cancellation`, async (t) => {
    const { runtime: value, client } = runtime(t);
    const gate = deferred<RuntimePermissionDecision>();
    const session = await value.newSession({ ...options(`broker-${decision}`),
      permissionBroker: { requestPermission: () => gate.promise } }) as CodexSession;
    const first = drain(session.send('A'));
    await tick();
    const oldId = currentTurn(session);
    const response = client.control('item/commandExecution/requestApproval', { threadId: session.threadId, turnId: oldId, command: 'test' });
    await tick();
    await session.cancel();
    assert.deepEqual(await response, { decision: 'decline' });
    complete(client, session, 'interrupted');
    await first;
    assert.equal(session.acceptsControl({}), false);
    const second = drain(session.send('B'));
    await tick();
    gate.resolve(decision);
    await tick();
    assert.deepEqual(await client.control('item/commandExecution/requestApproval', { threadId: session.threadId, turnId: oldId }), { decision: 'decline' });
    assert.equal(session.pendingPermissions.size, 0);
    complete(client, session);
    assert.equal((await second).some((event) => event.kind === 'permission_request'), false);
  });
}

test('late permission and user-input continuations cannot persist grants or leak resolved events', async (t) => {
  const client = new Client();
  const session = new CodexSession({ nodeId: 'controls', threadId: 'controls-native', cwd: '/tmp', workspaceId: 'workspace',
    client: client.transport, bridge, mcpRegistry: registry(), mcpPort: 1 });
  session.wireNotifications();
  t.after(() => session.dispose());
  let grants = 0;
  t.mock.method(db, 'grantPermission', () => { grants++; });
  session.onAlwaysAllow = () => { grants++; };
  const first = drain(session.send('A'));
  await tick();
  const params = { threadId: session.threadId, turnId: currentTurn(session) };
  let permissionResponse: unknown, inputResponse: unknown;
  const permission = session.askPermission('item/fileChange/requestApproval', params, (response) => { permissionResponse = response; });
  const input = session.askUserInput({ ...params, questions: [{ question: 'Continue?', options: [] }] }, (response) => { inputResponse = response; });
  const requestId = [...session.pendingPermissions.keys()][0];
  session.respondToPermission(requestId, 'allow_always');
  // Native completion wins before the async allow/input continuations run.
  complete(client, session);
  await Promise.all([permission, input, first]);
  assert.equal(grants, 0);
  assert.deepEqual(permissionResponse, { decision: 'decline' });
  assert.deepEqual(inputResponse, { answers: null });
  const second = drain(session.send('B'));
  await tick();
  complete(client, session);
  assert.equal((await second).some((event) => event.kind === 'user_input_resolved'), false);
});

test('active-turn MCP user input and approvals still resolve normally', async (t) => {
  const client = new Client();
  const mcp = registry();
  let askUser!: (questions: Array<{ question: string; options: Array<{ label: string }>; multiSelect: boolean }>) => Promise<unknown>;
  const originalCreate = mcp.create.bind(mcp);
  t.mock.method(mcp, 'create', (...args: Parameters<McpSlotRegistry['create']>) => {
    askUser = args[3].onAskUser!;
    return originalCreate(...args);
  });
  const session = new CodexSession({ nodeId: 'active-controls', threadId: 'active-native', cwd: '/tmp', workspaceId: null,
    client: client.transport, bridge, mcpRegistry: mcp, mcpPort: 1 });
  session.createMcpSlot();
  session.wireNotifications();
  t.after(() => session.dispose());
  const events: NormalizedEvent[] = [];
  const turn = (async () => { for await (const event of session.send('A')) events.push(event); })();
  await tick();
  const answer = askUser([{ question: 'Pick one', options: [{ label: 'A' }], multiSelect: false }]);
  await tick();
  const input = events.find((event) => event.kind === 'user_input_request');
  assert.ok(input?.kind === 'user_input_request');
  session.respondToUserInput(input.requestId, [{ question: 'Pick one', answer: 'A' }]);
  assert.deepEqual(await answer, { 'Pick one': 'A' });
  let response: unknown;
  const permission = session.askPermission('item/commandExecution/requestApproval', {
    threadId: session.threadId, turnId: currentTurn(session), command: 'test',
  }, (value) => { response = value; });
  session.respondToPermission([...session.pendingPermissions.keys()][0], 'allow_once');
  await permission;
  assert.deepEqual(response, { decision: 'accept' });
  complete(client, session);
  await turn;
  assert.equal(events.filter((event) => event.kind === 'user_input_resolved').length, 1);
  assert.equal(session.pendingPermissions.size, 0);
});

test('existing and pending sessions enforce canonical owner and profile on new/load reuse', async (t) => {
  const { runtime: value, client } = runtime(t);
  const gate = deferred<unknown>();
  client.respond = ({ method }) => method === 'thread/start' ? gate.promise : undefined;
  const opts = options('guarded');
  const first = value.newSession({ ...opts, sessionId: 'public-alias-a' });
  const wrongOwner = assert.rejects(value.newSession({ ...opts, sessionId: 'public-alias-b',
    owner: { kind: 'agent_run', runId: 'other-run', attemptId: 'guarded' } }), /Owner mismatch/);
  const wrongProfile = assert.rejects(value.loadSession({ ...opts, profileHash: 'other-profile', nativeResumeToken: 'original' }), /profile hash mismatch/);
  await tick();
  gate.resolve({ thread: { id: 'original' } });
  const session = await first;
  await Promise.all([wrongOwner, wrongProfile]);
  assert.equal(client.calls.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(await value.newSession(opts), session);
  await assert.rejects(value.loadSession({ ...opts, owner: { kind: 'chat_node', nodeId: 'guarded' } }), /Owner mismatch/);
  await assert.rejects(value.newSession({ ...opts, profileHash: null }), /profile hash mismatch/);
});

test('Codex chat restore uses legacy ACP-only identity and rejects a different runtime binding', async (t) => {
  const { runtime: value, client } = runtime(t);
  t.mock.method(db, 'getNode', (id: string) => ({ id, workspace_id: 'workspace', runtime_id: id === 'wrong-runtime' ? 'claude' : 'codex',
    external_session_id: null, acp_session_id: 'legacy-native' }));
  const session = await value.loadSession({ sessionId: 'legacy-node', cwd: '/tmp', model: 'test-model' });
  assert.equal(session.nativeSessionId, 'legacy-native');
  assert.deepEqual(client.calls.filter((call) => call.method === 'thread/resume').map((call) => call.params.threadId), ['legacy-native']);
  await assert.rejects(value.loadSession({ sessionId: 'wrong-runtime', cwd: '/tmp', model: 'test-model' }), /belongs to runtime claude/);
  assert.equal(client.calls.filter((call) => call.method === 'thread/resume').length, 1);
});
