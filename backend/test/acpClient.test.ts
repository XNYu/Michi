import { michiTestHost } from './helpers/michiTestHost';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { EventEmitter } from 'node:events';
import * as processTree from '../src/agents/processTree';
import type { SpawnOptions } from 'node:child_process';
import { kiroAuth, KiroSignedOutError } from '../src/agents/kiro/kiroAuth';
import { log } from '../src/services/logger';

test('a failed ACP launch never logs a successful spawn', async t => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: 0, signalCode: null,
  });
  t.mock.method(processTree, 'spawnAgentProcess', () => child as any);
  const info = t.mock.method(log, 'info', () => {});
  const errors = t.mock.method(log, 'error', () => {});
  const client = new AcpClient('/bin/false', '/missing-workspace', undefined, 'v2', undefined, 'kiro', { observability: michiTestHost().observability });
  try {
    client.start();
    const failure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', failure);
    assert.equal(info.mock.calls.filter(call => call.arguments[1] === 'kiro process spawned').length, 0);
    assert.equal(errors.mock.calls.filter(call => call.arguments[1] === 'kiro process error').length, 1);
  } finally { await client.shutdown(); }
});

test('ACP spawn success is logged only after the child confirms startup', async t => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: 0, signalCode: null,
  });
  t.mock.method(processTree, 'spawnAgentProcess', () => child as any);
  const info = t.mock.method(log, 'info', () => {});
  const client = new AcpClient('/bin/false', '/tmp', undefined, 'v2', undefined, 'kiro', { observability: michiTestHost().observability, onSignedOut: binary => kiroAuth.signedOut(binary) });
  try {
    client.start();
    assert.equal(info.mock.calls.filter(call => call.arguments[1] === 'kiro process spawned').length, 0);
    child.emit('spawn');
    const messages = info.mock.calls.filter(call => call.arguments[1] === 'kiro process spawned');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].arguments[2]?.pid, 12345);
  } finally { await client.shutdown(); }
});

test('host environment is scoped to direct Kiro children and bypasses Crew launch overrides', async t => {
  const spawned: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  t.mock.method(processTree, 'spawnAgentProcess', (_bin: string, args: string[], options?: SpawnOptions) => {
    spawned.push({ args, env: options?.env });
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: 0, signalCode: null,
    }) as any;
  });
  const previousMandatory = process.env.MICHI_TEST_ENV_MARKER;
  const previousPreload = process.env.MICHI_KIRO_PRELOAD_TOOLS;
  process.env.MICHI_TEST_ENV_MARKER = 'existing';
  delete process.env.MICHI_KIRO_PRELOAD_TOOLS;
  // The host hands over the environment a child would inherit (Michi: process.env).
  const spawnEnv = () => process.env;
  let preloadReads = 0;
  const clients = [
    new AcpClient('/bin/false', '/tmp', undefined, 'v3', undefined, 'kiro', { spawnEnv }),
    new AcpClient('/bin/false', '/tmp', undefined, 'v2', undefined, 'kiro', { spawnEnv }),
    new AcpClient(undefined, '/tmp', undefined, 'v3', { bin: '/bin/false', args: () => ['crew-acp'] }, 'crew', { spawnEnv }),
    new AcpClient('/bin/false', '/tmp', undefined, 'v3'),
    new AcpClient('/bin/false', '/tmp', undefined, 'v3', undefined, 'kiro', { spawnEnv, preloadTools: () => { preloadReads++; return false; } }),
    // The adapter no longer reads Michi's switch itself: only preloadTools turns it off.
    new AcpClient('/bin/false', '/tmp', undefined, 'v3', undefined, 'kiro', { spawnEnv: () => ({ ...process.env, MICHI_KIRO_PRELOAD_TOOLS: 'false' }) }),
  ];
  try {
    for (const client of clients) client.start();
    assert.equal(spawned[0].env?.MICHI_TEST_ENV_MARKER, 'existing');
    assert.equal(spawned[1].env?.MICHI_TEST_ENV_MARKER, 'existing');
    assert.equal(spawned[2].env, undefined, 'custom ACP launches inherit the parent environment directly');
    assert.deepEqual(spawned[2].args, ['crew-acp']);
    assert.equal(spawned[3].env, undefined, 'without a host environment the child inherits this one unchanged');
    assert.equal(spawned[4].env?.MICHI_TEST_ENV_MARKER, 'existing', 'preloading off leaves the list as it is');
    assert.equal(preloadReads, 1, 'read once, at spawn');
    assert.equal(spawned[5].env?.MICHI_TEST_ENV_MARKER, 'existing');
    assert.equal(process.env.MICHI_TEST_ENV_MARKER, 'existing');
    assert.ok(!spawned[0].args.some(arg => /trust/.test(arg)), 'preloading must not add trust flags');
  } finally {
    await Promise.all(clients.map(client => client.shutdown()));
    if (previousMandatory === undefined) delete process.env.MICHI_TEST_ENV_MARKER;
    else process.env.MICHI_TEST_ENV_MARKER = previousMandatory;
    if (previousPreload === undefined) delete process.env.MICHI_KIRO_PRELOAD_TOOLS;
    else process.env.MICHI_KIRO_PRELOAD_TOOLS = previousPreload;
  }
});

describe('AcpClient RPC error diagnostics', () => {
  test('preserves RPC method, session, code, and data on ACP errors', async () => {
    const client = new AcpClient('/bin/false', '/tmp', 'test-model') as any;
    const rejection = new Promise((_resolve, reject) => {
      client.pending.set(42, {
        method: 'session/prompt',
        sessionId: 'session-1',
        timeoutMs: 0,
        resolve: () => {},
        reject,
        timer: null,
      });
    });

    client.dispatch({
      jsonrpc: '2.0',
      id: 42,
      error: {
        code: -32603,
        message: 'Internal error',
        data: { provider: 'test-provider', requestId: 'req-123' },
      },
    });

    await assert.rejects(rejection, (err: unknown) => {
      assert.ok(err instanceof ACPError);
      assert.equal(err.message, 'Internal error');
      assert.equal(err.method, 'session/prompt');
      assert.equal(err.sessionId, 'session-1');
      assert.equal(err.rpcCode, -32603);
      assert.deepEqual(err.rpcData, { provider: 'test-provider', requestId: 'req-123' });
      return true;
    });
  });
});

describe('AcpClient subagent routing (per-tool-call Map)', () => {
  /** Helper: build a minimal AcpClient with fake internals for dispatch testing. */
  function makeTestClient(): any {
    const client = new AcpClient('/bin/false', '/tmp') as any;
    // Create fake session queues so dispatch can route events
    const queues = new Map<string, { items: any[] }>();
    const makeQueue = (sid: string) => {
      const q = { items: [] as any[], push(item: any) { this.items.push(item); } };
      queues.set(sid, q);
      client.sessionQueues.set(sid, q);
      return q;
    };
    return { client, queues, makeQueue };
  }

  function toolCallMsg(sessionId: string, toolCallId: string, title: string) {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId, title },
      },
    };
  }

  function toolCallUpdateMsg(sessionId: string, toolCallId: string, status: string) {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status },
      },
    };
  }

  function listUpdateMsg(subagents: Array<{ sessionId?: string; name?: string; status?: string }>) {
    return {
      jsonrpc: '2.0',
      method: '_kiro.dev/subagent/list_update',
      params: { subagents },
    };
  }

  test('concurrent owners: most recently registered wins (LIFO)', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');
    const qB = makeQueue('session-B');

    // Both sessions trigger subagent tool calls — B is registered second
    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));
    client.dispatch(toolCallMsg('session-B', 'tc-2', 'spawn'));

    // list_update should route to session-B (most recent)
    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'gpu-coder', status: 'Running' }]));

    const aUpdates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    const bUpdates = qB.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(aUpdates.length, 0, 'session-A (older) should NOT receive the list_update');
    assert.equal(bUpdates.length, 1, 'session-B (newer) should receive the list_update');
  });

  test('empty roster does not clear another session\'s parent mappings', () => {
    const { client, makeQueue } = makeTestClient();
    makeQueue('session-A');
    makeQueue('session-B');

    // Both sessions trigger subagent tool calls
    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));
    client.dispatch(toolCallMsg('session-B', 'tc-2', 'agent'));

    // Roster with entries → builds parent mapping for the most recent owner (B)
    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'coder', status: 'Running' }]));
    assert.equal(client.subagentParentMap.get('sub-1'), 'session-B');

    // B completes. A becomes sole owner. Push a new sub for A.
    client.dispatch(toolCallUpdateMsg('session-B', 'tc-2', 'completed'));
    client.dispatch(listUpdateMsg([
      { sessionId: 'sub-2', name: 'researcher', status: 'Running' },
    ]));
    assert.equal(client.subagentParentMap.get('sub-2'), 'session-A');

    // Empty roster → should clear A's mappings only
    client.dispatch(listUpdateMsg([]));
    // sub-2 was mapped to A → should be cleared
    assert.equal(client.subagentParentMap.has('sub-2'), false);
  });

  test('tool_call without toolCallId does not register ownership', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');

    // tool_call with no toolCallId → should not register
    client.dispatch({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-A',
        update: { sessionUpdate: 'tool_call', title: 'agent' },
      },
    });

    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'coder', status: 'Running' }]));

    const updates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(updates.length, 0, 'no ownership → event discarded');
  });
});

test('adapter permission expiry is bound to session and request ID', () => {
  const client = new AcpClient('/bin/false', '/tmp') as any;
  const events: unknown[] = [];
  client.pendingPermissions.set(7, { sessionId: 'one' });
  client.sessionQueues.set('one', { push: (event: unknown) => events.push(event) });
  client.dispatch({ method: '_michi/permission_resolved', params: { sessionId: 'two', requestId: 7 } });
  assert.equal(client.pendingPermissions.has(7), true);
  client.dispatch({ method: '_michi/permission_resolved', params: { sessionId: 'one', requestId: 7 } });
  assert.equal(client.pendingPermissions.has(7), false);
  assert.deepEqual(events, [{ update: { sessionUpdate: 'permission_resolved', requestId: 7 } }]);
});

test('client options add argv and replace the environment for kiro-cli only', async t => {
  const spawned: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  t.mock.method(processTree, 'spawnAgentProcess', (_bin: string, args: string[], options?: SpawnOptions) => {
    spawned.push({ args, env: options?.env });
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: 0, signalCode: null,
    }) as any;
  });
  const clients = [
    new AcpClient('/bin/false', '/tmp', 'm', 'v2', undefined, 'kiro', { extraArgs: ['--agent', 'meta'], childEnv: { ONLY: '1' } }),
    new AcpClient(undefined, '/tmp', undefined, 'v2', { bin: '/bin/false', args: () => ['crew-acp'] }, 'crew', { extraArgs: ['--agent', 'meta'] }),
  ];
  try {
    for (const client of clients) client.start();
    assert.deepEqual(spawned[0].args, ['acp', '--agent-engine', 'v2', '--model', 'm', '--agent', 'meta']);
    assert.deepEqual(spawned[0].env, { ONLY: '1' });
    assert.deepEqual(spawned[1].args, ['crew-acp'], 'a custom launch owns its argv');
  } finally {
    await Promise.all(clients.map((client) => client.shutdown()));
  }
});

test('a rejecting client answers every permission request itself and never queues it', () => {
  const client = new AcpClient('/bin/false', '/tmp', undefined, 'v3', undefined, 'kiro', { rejectPermissions: true }) as any;
  const written: string[] = [];
  client.proc = { stdin: { destroyed: false, write: (line: string) => { written.push(line); return true; } } };
  const events: unknown[] = [];
  client.sessionQueues.set('s', { push: (event: unknown) => events.push(event) });
  client.dispatch({ jsonrpc: '2.0', id: 41, method: 'session/request_permission', params: {
    sessionId: 's', toolCall: { title: 'shell' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  } });
  client.dispatch({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { sessionId: 's', toolCall: { title: 'x' }, options: [] } });
  assert.deepEqual(events, []);
  assert.deepEqual(written.map((line) => JSON.parse(line)), [
    { jsonrpc: '2.0', id: 41, result: { outcome: { outcome: 'selected', optionId: 'no' } } },
    { jsonrpc: '2.0', id: 42, result: { outcome: { outcome: 'cancelled' } } },
  ]);
  assert.equal(client.pendingPermissions.size, 0);
  client.proc = null;
});

test('tool catalogs: v3 tags and v2 server initialization are recorded per session and awaited', async () => {
  const v3 = new AcpClient('/bin/false', '/tmp', undefined, 'v3') as any;
  const waiting = v3.waitForToolCatalog('s', (state: any) => (state?.seq ?? 0) >= 2, 1_000);
  v3.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 's', tags: [{ source: 'builtin', tag: 'read' }] } });
  assert.equal(v3.toolCatalog('s').seq, 1);
  v3.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 's', tags: [{ source: 'mcp', tag: '@michi/read_node' }] } });
  const state = await waiting;
  assert.deepEqual(state.tags, [{ source: 'mcp', tag: '@michi/read_node' }]);
  assert.equal(v3.toolCatalog('other'), undefined);
  const timedOut = await v3.waitForToolCatalog('s', (s: any) => s.seq > 5, 20);
  assert.equal(timedOut.seq, 2, 'the latest state once the wait runs out');
  let changes = 0;
  const off = v3.onToolCatalogChange('s', () => { changes += 1; });
  v3.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 's', tags: [] } });
  off();
  v3.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 's', tags: [] } });
  assert.equal(changes, 1);
  v3.destroySession('s');
  assert.equal(v3.toolCatalog('s'), undefined);

  const v2 = new AcpClient('/bin/false', '/tmp', undefined, 'v2') as any;
  v2.dispatch({ method: '_kiro.dev/mcp/server_initialized', params: { sessionId: 's', serverName: 'michi' } });
  v2.dispatch({ method: '_kiro.dev/mcp/server_initialized', params: { sessionId: 's', serverName: 'michi' } });
  assert.deepEqual(v2.toolCatalog('s'), { initializedServers: ['michi'], seq: 1 });
  v2.dispatch({ method: '_kiro/tools/didChange', params: { sessionId: 's', tags: [] } });
  assert.equal(v2.toolCatalog('s').tags, undefined, 'v2 has no tag catalog');
});


test('split startup stderr preserves sign-out and latches the shared gate', async t => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: 1, signalCode: null,
  });
  t.mock.method(processTree, 'spawnAgentProcess', () => child as any);
  const latch = t.mock.method(kiroAuth, 'signedOut', () => {});
  const client = new AcpClient('/bin/false', '/tmp', undefined, 'v2', undefined, 'kiro', { observability: michiTestHost().observability, onSignedOut: binary => kiroAuth.signedOut(binary) });
  let reason: Error | undefined;
  client.onExit(error => { reason = error; });
  client.start();
  child.stderr.emit('data', Buffer.from('You are not log'));
  child.stderr.emit('data', Buffer.from('ged in, please log in with kiro-cli login'));
  child.emit('exit', 1, null);
  assert.ok(reason instanceof KiroSignedOutError);
  assert.equal(latch.mock.calls.length, 1);
  await assert.rejects(client.initialize(), KiroSignedOutError);
  await client.shutdown();
});
