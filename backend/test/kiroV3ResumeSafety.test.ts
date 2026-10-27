import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, ACPError, ACPNativeSessionMissingError, ACPNotRunningError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { isNativeSessionUnavailable } from 'michi-runtime/internal/adapters/kiro/acpErrors';
import { nativeSessionExists } from 'michi-runtime/internal/adapters/kiro/nativeSessionLookup';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { michiTestHost } from './helpers/michiTestHost';

test('V3 refuses create-or-load for a missing native ID, permitting only explicit unavailable fallback', async () => {
    const client = new AcpClient('/bin/false', '/tmp', undefined, 'v3');
    const calls: string[] = [];
    (client as any).send = async (method: string) => {
        calls.push(method);
        if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } };
        if (method === 'session/list') return { sessions: [] };
        throw new Error('session/load would silently create an empty session');
    };
    await client.initialize();
    await assert.rejects(client.loadSession('saved-native-id', '/tmp'), (error) => {
        assert.ok(error instanceof ACPNativeSessionMissingError);
        return isNativeSessionUnavailable(error, 'saved-native-id');
    });
    assert.deepEqual(calls, ['initialize', 'session/list']);
});

for (const result of [ {}, { sessions: [{}] }, { sessions: [], nextCursor: 'loop' },
    { sessions: [{ sessionId: 'saved', cwd: '/other' }] },
    { sessions: [{ sessionId: 'saved', cwd: '/tmp', _meta: { kiro: { source: 'remote' } } }] },
]) test(`incomplete or mismatched catalog retains binding: ${JSON.stringify(result)}`, async () => {
    await assert.rejects(nativeSessionExists('saved', '/tmp', async () => result), (error) => !isNativeSessionUnavailable(error, 'saved'));
});

for (const failure of [new ACPError('connection reset'), new ACPNotRunningError('client shut down'), new ACPError('failed to generate a response')]) {
    test(`V3 does not resend an uncertain submitted request: ${failure.message}`, async () => {
        let prompts = 0, recoveries = 0;
        const runtime = { host: michiTestHost(), engine: 'v3', ensureClient: async () => ({ async *prompt() { prompts++; throw failure; } }),
            recoverSession: async () => { recoveries++; return true; },
        } as unknown as KiroRuntime;
        const session = new KiroSession('node', 'native', runtime, '/tmp');
        await assert.rejects(async () => { for await (const _ of session.send('write once')) {} }, /may have performed actions/);
        assert.equal(prompts, 1);
        assert.equal(recoveries, 0);
        assert.equal(session.nativeSessionId, 'native');
    });
}
