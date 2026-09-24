import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/services/acpClient';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { michiMcpServer } from '../src/agents/kiro/kiroProtocol';
import type { AgentToolBridge } from '../src/agents/toolBridge';

test('v3 gives same-cwd Run sessions independent clients, release preserves peers, and tokens keep engine', async (t) => {
    const clients: AcpClient[] = []; const stops: AcpClient[] = [];
    t.mock.method(AcpClient.prototype, 'start', function(this: AcpClient) { clients.push(this); });
    t.mock.method(AcpClient.prototype, 'initialize', async () => {});
    t.mock.method(AcpClient.prototype, 'shutdown', async function(this: AcpClient) { stops.push(this); });
    let sequence = 0;
    t.mock.method(AcpClient.prototype, 'newSession', async () => ({ sessionId: `native-${++sequence}` }));
    t.mock.method(AcpClient.prototype, 'cancel', async () => false);
    const runtime = new KiroRuntime({} as AgentToolBridge, undefined, 0, '/tmp', undefined, { engine: 'v3' });
    const a = { kind: 'agent_run', attemptId: 'a', runId: 'run-a' } as const;
    const b = { kind: 'agent_run', attemptId: 'b', runId: 'run-b' } as const;
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

test('Michi MCP keeps stable tool names across reload and waits for v3 legacy HTTP readiness', () => {
    assert.deepEqual(michiMcpServer('v2', 'http://localhost:123/api', 'one'), {
        name: 'michi', type: 'http', url: 'http://localhost:123/api/mcp/one', headers: [],
    });
    const v3 = michiMcpServer('v3', 'http://localhost:123/api', 'two');
    assert.equal(v3.name, 'michi');
    assert.deepEqual(v3._meta, { kiro: { waitForReady: true, versionNegotiation: 'legacy' } });
    assert.deepEqual(v3.headers, []);
});
