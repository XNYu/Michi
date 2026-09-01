import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError } from '../src/services/acpClient';

describe('AcpClient prompt timeout policy', () => {
  test('does not arm an ACP idle timeout for session/prompt turns', async () => {
    const client = new AcpClient('/bin/false', '/tmp') as any;

    client.send = async (method: string, _params?: unknown, timeoutMs?: number) => {
      if (method === 'session/new') {
        return { sessionId: 's1' };
      }
      if (method === 'session/prompt') {
        assert.equal(
          timeoutMs,
          0,
          'long-running prompt turns should not fail while the agent is silent inside a tool call',
        );
        return { stopReason: 'end_turn' };
      }
      throw new Error(`unexpected ACP method ${method}`);
    };

    await client.newSession();

    const updates: string[] = [];
    for await (const update of client.prompt('s1', 'look this up')) {
      updates.push(update.sessionUpdate);
      if (update.sessionUpdate === 'turn_end') break;
    }

    assert.deepEqual(updates, ['turn_end']);
  });
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

describe('AcpClient cancellation transport', () => {
  test('sends session/cancel as a JSON-RPC notification', async () => {
    const client = new AcpClient('/bin/false', '/tmp') as any;
    const writes: string[] = [];
    client.proc = {
      stdin: {
        destroyed: false,
        write(payload: string, callback?: (error?: Error | null) => void) {
          writes.push(payload);
          callback?.(null);
          return true;
        },
      },
    };
    client.sessionQueues.set('session-1', {});

    const cancelPromise = client.cancel('session-1');
    const payload = JSON.parse(writes[0].trim()) as Record<string, unknown>;

    // Let the old request-based implementation settle so a failing assertion
    // cannot leave its idle timer running.
    if (typeof payload.id === 'number') {
      client.dispatch({ jsonrpc: '2.0', id: payload.id, result: null });
    }
    await cancelPromise;

    assert.deepEqual(payload, {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'session-1' },
    });
    assert.equal(client.pending.size, 0);
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

  test('routes list_update to the correct session when only one owner exists', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');
    const qB = makeQueue('session-B');

    // Session A triggers a subagent tool call
    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));

    // list_update arrives — should route to session-A only
    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'gpu-coder', status: 'Running' }]));

    const aUpdates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    const bUpdates = qB.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(aUpdates.length, 1, 'session-A should receive the list_update');
    assert.equal(bUpdates.length, 0, 'session-B should NOT receive the list_update');
    assert.equal(aUpdates[0].update.subagents[0].name, 'gpu-coder');
  });

  test('does not route list_update to a session whose tool_call already completed', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');
    const qB = makeQueue('session-B');

    // Session A triggers and completes a subagent tool call
    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));
    client.dispatch(toolCallUpdateMsg('session-A', 'tc-1', 'completed'));

    // Session B triggers a subagent tool call
    client.dispatch(toolCallMsg('session-B', 'tc-2', 'subagent'));

    // list_update arrives — should route to session-B only
    client.dispatch(listUpdateMsg([{ sessionId: 'sub-2', name: 'gpu-research', status: 'Running' }]));

    const aUpdates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    const bUpdates = qB.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(aUpdates.length, 0, 'completed session-A should NOT receive list_update');
    assert.equal(bUpdates.length, 1, 'session-B should receive the list_update');
  });

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

  test('after the most recent owner completes, the remaining owner takes over', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');
    const qB = makeQueue('session-B');

    // Both sessions trigger subagent tool calls
    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));
    client.dispatch(toolCallMsg('session-B', 'tc-2', 'task'));

    // B completes → A should become the sole owner
    client.dispatch(toolCallUpdateMsg('session-B', 'tc-2', 'completed'));

    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'gpu-coder', status: 'Running' }]));

    const aUpdates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    const bUpdates = qB.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(aUpdates.length, 1, 'session-A (remaining) should receive the list_update');
    assert.equal(bUpdates.length, 0, 'session-B (completed) should NOT receive list_update');
  });

  test('no owners → list_update is silently discarded', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');

    // No tool_call registered — list_update should be dropped
    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'gpu-coder', status: 'Running' }]));

    const updates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(updates.length, 0, 'list_update should be discarded when there are no owners');
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

  test('error status also releases ownership', () => {
    const { client, makeQueue } = makeTestClient();
    const qA = makeQueue('session-A');
    const qB = makeQueue('session-B');

    client.dispatch(toolCallMsg('session-A', 'tc-1', 'agent'));
    client.dispatch(toolCallUpdateMsg('session-A', 'tc-1', 'error'));

    // Session B triggers after A errored
    client.dispatch(toolCallMsg('session-B', 'tc-2', 'agent'));

    client.dispatch(listUpdateMsg([{ sessionId: 'sub-1', name: 'coder', status: 'Running' }]));

    const aUpdates = qA.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    const bUpdates = qB.items.filter((i: any) => i.update?.sessionUpdate === 'subagent_list_update');
    assert.equal(aUpdates.length, 0);
    assert.equal(bUpdates.length, 1);
  });
});