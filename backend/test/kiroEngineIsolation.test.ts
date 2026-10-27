import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';

import type { AgentToolBridge } from '../src/agents/toolBridge';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';

test('v3 gives same-cwd Run sessions independent clients, release preserves peers, and tokens keep engine', async (t) => {
    const clients: AcpClient[] = []; const stops: AcpClient[] = [];
    t.mock.method(AcpClient.prototype, 'start', function(this: AcpClient) { clients.push(this); });
    t.mock.method(AcpClient.prototype, 'initialize', async () => {});
    t.mock.method(AcpClient.prototype, 'shutdown', async function(this: AcpClient) { stops.push(this); });
    let sequence = 0;
    t.mock.method(AcpClient.prototype, 'newSession', async () => ({ sessionId: `native-${++sequence}` }));
    t.mock.method(AcpClient.prototype, 'cancel', async () => false);
    const runtime = new KiroRuntime({ bridge: {} as AgentToolBridge, defaultCwd: '/tmp', host: michiTestHost(), engine: 'v3' });
    const a = runOwner('run-a', 'a');
    const b = runOwner('run-b', 'b');
    try {
        const first = await runtime.newSession({ sessionId: 'a', cwd: '/tmp', owner: a });
        const second = await runtime.newSession({ sessionId: 'b', cwd: '/tmp', owner: b });
        assert.equal(clients.length, 2);
        assert.notEqual(clients[0], clients[1]);
        assert.deepEqual(first.getNativeResumeToken?.(), { engine: 'v3', sessionId: first.nativeSessionId });
        assert.equal(runtime.getBinding('b')?.nativeSessionId, second.nativeSessionId);
        await assert.rejects(runtime.releaseSession('a', b), /owner/i);
        assert.equal(stops.length, 0);
        await runtime.releaseSession('a', a);
        assert.equal(stops.length, 1);
        assert.equal(runtime.getBinding('a'), undefined);
        assert.equal(runtime.getBinding('b')?.owner, b);
    } finally { await runtime.shutdown(); }
    assert.equal(stops.length, 2);
});
