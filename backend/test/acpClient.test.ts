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

describe('AcpClient MCP tool-result backfill', () => {
  test('injects a tool_call_update only for an in-flight placeholder tool', () => {
    const client = new AcpClient('/bin/false', '/tmp') as any;
    const pushed: any[] = [];
    client.sessionQueues.set('s1', { push: (item: unknown) => pushed.push(item) });
    client.sessionInFlight.set('s1', Promise.resolve());
    client.inflightToolBySession.set('s1', { toolCallId: 'tc-1', lastOutput: { success: true } });

    assert.equal(client.backfillToolOutput('s1', { content: [{ type: 'text', text: '{"n":2}' }] }), true);
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0].update, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      rawOutput: '{"n":2}',
    });
  });

  test('does not invent a toolCallId when none is in flight', () => {
    const client = new AcpClient('/bin/false', '/tmp') as any;
    const pushed: any[] = [];
    client.sessionQueues.set('s1', { push: (item: unknown) => pushed.push(item) });
    client.sessionInFlight.set('s1', Promise.resolve());
    assert.equal(client.backfillToolOutput('s1', { content: [{ type: 'text', text: 'x' }] }), false);
    assert.equal(pushed.length, 0);
  });

  test('does not overwrite a real existing output', () => {
    const client = new AcpClient('/bin/false', '/tmp') as any;
    const pushed: any[] = [];
    client.sessionQueues.set('s1', { push: (item: unknown) => pushed.push(item) });
    client.sessionInFlight.set('s1', Promise.resolve());
    client.inflightToolBySession.set('s1', {
      toolCallId: 'tc-1',
      lastOutput: { items: [{ Json: { ok: true } }] },
    });
    assert.equal(client.backfillToolOutput('s1', { content: [{ type: 'text', text: 'late' }] }), false);
    assert.equal(pushed.length, 0);
  });
});
