import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexSession } from '../src/agents/codex/CodexSession';
import type { CodexAppServerClient } from '../src/agents/codex/CodexAppServerClient';
import type { McpSlotRegistry } from '../src/services/mcpServer';
import type { AgentToolBridge } from '../src/agents/toolBridge';

// ---- Stubs ------------------------------------------------------------------

function makeStubClient(overrides: Partial<CodexAppServerClient> = {}): CodexAppServerClient {
  const notifHandlers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  const client: any = {
    ensureStarted: async () => {},
    request: async (_method: string, _params: unknown) => ({}),
    onNotification: (threadId: string, handler: (method: string, params: Record<string, unknown>) => void) => {
      let set = notifHandlers.get(threadId);
      if (!set) { set = new Set(); notifHandlers.set(threadId, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    onServerRequest: (_h: unknown) => {},
    onExit: (_cb: () => void) => () => {},
    shutdown: async () => {},
    // Test helper: emit a notification to all handlers for a threadId
    _emit: (threadId: string, method: string, params: Record<string, unknown>) => {
      for (const h of notifHandlers.get(threadId) ?? []) h(method, params);
    },
    ...overrides,
  };
  return client as CodexAppServerClient;
}

function makeStubMcpRegistry(): McpSlotRegistry {
  const registry: any = {
    create: (_parentChatId: string, _cwd: string, _ownerUserId: string | null, cbs: any, _opts?: any) => {
      return { slotId: 'test-slot-id', parentChatId: _parentChatId, cwd: _cwd, workspaceId: null, nodeId: null, ownerUserId: null, ...cbs };
    },
    dispose: async (_slotId: string) => {},
    get: (_slotId: string) => undefined,
  };
  return registry as McpSlotRegistry;
}

function makeStubBridge(): AgentToolBridge {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function makeSession(clientOverrides: Partial<CodexAppServerClient> = {}) {
  const client = makeStubClient(clientOverrides);
  const session = new CodexSession({
    nodeId: 'node-1',
    threadId: 'thread-1',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();
  return { session, client: client as any };
}

// ---- Tests ------------------------------------------------------------------

test('send streams chunks and ends on turn/completed; history is recorded', async () => {
  let requestedMethod = '';
  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      requestedMethod = method;
      return {};
    },
  });
  const session = new CodexSession({
    nodeId: 'node-1',
    threadId: 'thread-1',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: string[] = [];
  const turnPromise = (async () => {
    for await (const ev of session.send('hello')) {
      events.push(ev.kind);
    }
  })();

  // Give the turn/start request a tick to fire
  await new Promise((r) => setImmediate(r));

  // Emit notifications as codex app-server would
  (client as any)._emit('thread-1', 'item/agentMessage/delta', { threadId: 'thread-1', delta: 'Hello ' });
  (client as any)._emit('thread-1', 'item/agentMessage/delta', { threadId: 'thread-1', delta: 'world' });
  (client as any)._emit('thread-1', 'turn/completed', {
    threadId: 'thread-1',
    turn: { status: 'completed' },
  });

  await turnPromise;

  assert.equal(requestedMethod, 'turn/start');
  assert.ok(events.includes('chunk'), 'should have chunk events');
  assert.ok(events.includes('turn_end'), 'should end with turn_end');
  assert.ok(events.includes('usage_summary'), 'should have usage_summary from turn/completed');

  const history = session.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].content, 'hello');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Hello world');
});

test('cancel issues turn/interrupt', async () => {
  const requests: string[] = [];
  let resolveTurnStart!: () => void;
  const turnStartPromise = new Promise<void>((r) => { resolveTurnStart = r; });

  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      requests.push(method);
      if (method === 'turn/start') {
        resolveTurnStart();
        // Never resolves on its own — simulates a long-running turn
        await new Promise(() => {});
      }
      return {};
    },
  });

  const session = new CodexSession({
    nodeId: 'node-2',
    threadId: 'thread-2',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  // Start turn (don't await — it hangs)
  const sendPromise = (async () => {
    for await (const _ev of session.send('do something long')) { /* drain */ }
  })();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  sendPromise.catch(() => {}); // suppress unhandled rejection

  // Wait for turn/start to be issued
  await turnStartPromise;

  await session.cancel();

  assert.ok(requests.includes('turn/interrupt'), 'cancel should issue turn/interrupt');
});

test('markCrashed terminates an in-flight drain with turn_end (terminal safety)', async () => {
  let turnStartResolved = false;

  const client = makeStubClient({
    request: async (method: string, _params: unknown) => {
      if (method === 'turn/start') {
        turnStartResolved = true;
        // Resolve immediately — the session enters the drain loop
        return {};
      }
      return {};
    },
  });

  const session = new CodexSession({
    nodeId: 'node-3',
    threadId: 'thread-3',
    cwd: '/tmp/test',
    workspaceId: null,
    client,
    mcpRegistry: makeStubMcpRegistry(),
    bridge: makeStubBridge(),
    mcpPort: 3001,
  });
  session.createMcpSlot();
  session.wireNotifications();

  const events: string[] = [];
  const sendPromise = (async () => {
    for await (const ev of session.send('long task')) {
      events.push(ev.kind);
    }
  })();

  // Give the event loop a tick so send() enters the drain loop (awaiting queue.pull)
  await new Promise((r) => setImmediate(r));
  assert.ok(turnStartResolved, 'turn/start should have resolved');

  // Crash the session (simulate daemon exit) — this pushes events to the queue
  session.markCrashed('test crash reason');

  await sendPromise;

  assert.ok(events.includes('turn_end'), 'markCrashed should push turn_end to terminate the drain');
  assert.ok(events.includes('mcp_server_error'), 'markCrashed should push mcp_server_error');
  const turnEnd = events[events.length - 1];
  assert.equal(turnEnd, 'turn_end', 'turn_end should be last event');
});
