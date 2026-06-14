import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/services/acpClient';

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
