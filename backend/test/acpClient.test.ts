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
