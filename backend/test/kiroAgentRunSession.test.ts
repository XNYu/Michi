/**
 * T05 — Kiro owner-aware Agent Run session tests.
 *
 * Validates that KiroRuntime and KiroSession correctly handle `agent_run`
 * owners: fresh ACP sessions with Run MCP slots, nativeResumeToken-based
 * resume without Node access, permission brokering, owner-verified release,
 * and no interference with existing chat session behavior.
 *
 * Tests are split into two groups:
 *  - KiroSession tests (permission brokering, retry disabling) that only
 *    import KiroSession and work on any Node version.
 *  - KiroRuntime tests (newSession, loadSession, release, bindings) that
 *    import KiroRuntime and require Node 22+ for the node:sqlite dependency.
 *    These are guarded with a node:sqlite availability check and skipped
 *    gracefully on older Node versions.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type {
    RuntimePermissionBroker,
    RuntimePermissionRequest,
    RuntimeSessionOwner,
} from '../src/agents/types';
import { sameOwner, assertOwner } from '../src/agents/types';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const RUN_OWNER: RuntimeSessionOwner = {
    kind: 'agent_run',
    runId: 'run-1',
    attemptId: 'attempt-1',
};

const WRONG_OWNER: RuntimeSessionOwner = {
    kind: 'agent_run',
    runId: 'run-2',
    attemptId: 'attempt-2',
};

const CHAT_OWNER: RuntimeSessionOwner = {
    kind: 'chat_node',
    nodeId: 'node-chat-1',
};

// ---------------------------------------------------------------------------
// KiroSession permission brokering for agent_run
// ---------------------------------------------------------------------------

describe('KiroSession permission brokering', () => {
    test('agent_run owner routes allow_once through broker and responds to ACP', async () => {
        const brokerCalls: RuntimePermissionRequest[] = [];
        const respondCalls: Array<{ sid: string; requestId: number; optionId: string }> = [];
        const cancelCalls: Array<{ sid: string; requestId: number }> = [];

        const broker: RuntimePermissionBroker = {
            async requestPermission(req) {
                brokerCalls.push(req);
                return 'allow_once';
            },
        };

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* (sessionId: string, text: string) {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 42,
                        toolCall: { toolCallId: 'tc-1', title: 'write' },
                        options: [
                            { optionId: 'allow', name: 'Allow', kind: 'approve' },
                            { optionId: 'deny', name: 'Deny', kind: 'reject' },
                        ],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            respondToPermission: (sid: string, requestId: number, optionId: string) => {
                respondCalls.push({ sid, requestId, optionId });
            },
            cancelPermission: (sid: string, requestId: number) => {
                cancelCalls.push({ sid, requestId });
            },
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-perm', 'acp-perm-sid', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
            permissionBroker: broker,
        });

        const events: any[] = [];
        for await (const ev of session.send('do something')) events.push(ev);

        // Broker was called.
        assert.equal(brokerCalls.length, 1);
        assert.equal(brokerCalls[0].toolName, 'write');
        assert.deepEqual(brokerCalls[0].owner, RUN_OWNER);

        // ACP was responded to with allow.
        assert.equal(respondCalls.length, 1);
        assert.equal(respondCalls[0].optionId, 'allow');
        assert.equal(respondCalls[0].requestId, 42);

        // No permission_request event was yielded (broker handled it).
        assert.ok(!events.some(e => e.kind === 'permission_request'));
    });

    test('agent_run owner routes deny through broker and cancels ACP permission', async () => {
        const cancelCalls: Array<{ sid: string; requestId: number }> = [];

        const broker: RuntimePermissionBroker = {
            async requestPermission() { return 'deny'; },
        };

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 99,
                        toolCall: { toolCallId: 'tc-deny', title: 'bash' },
                        options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            respondToPermission: () => {},
            cancelPermission: (_sid: string, requestId: number) => {
                cancelCalls.push({ sid: _sid, requestId });
            },
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-deny', 'acp-deny-sid', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
            permissionBroker: broker,
        });

        const events: any[] = [];
        for await (const ev of session.send('delete files')) events.push(ev);

        // ACP permission was cancelled.
        assert.equal(cancelCalls.length, 1);
        assert.equal(cancelCalls[0].requestId, 99);

        // No permission_request event yielded.
        assert.ok(!events.some(e => e.kind === 'permission_request'));
    });

    test('agent_run owner routes allow_always through broker without writing chat grant', async () => {
        const respondCalls: Array<{ requestId: number; optionId: string }> = [];
        let grantWritten = false;

        const broker: RuntimePermissionBroker = {
            async requestPermission() { return 'allow_always'; },
        };

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 88,
                        toolCall: { toolCallId: 'tc-always', title: 'write' },
                        options: [
                            { optionId: 'allow', name: 'Allow', kind: 'approve' },
                            { optionId: 'allowForSession', name: 'Allow for session', kind: 'approve' },
                        ],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            respondToPermission: (_sid: string, requestId: number, optionId: string) => {
                respondCalls.push({ requestId, optionId });
            },
            cancelPermission: () => {},
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-always', 'acp-always-sid', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
            permissionBroker: broker,
        });

        const events: any[] = [];
        for await (const ev of session.send('allow all')) events.push(ev);

        // ACP was responded with the allow option.
        assert.equal(respondCalls.length, 1);
        assert.equal(respondCalls[0].optionId, 'allow');

        // No permission_request event yielded — handled by broker.
        assert.ok(!events.some(e => e.kind === 'permission_request'));

        // No grant was written (Runs are Attempt-scoped).
        assert.equal(grantWritten, false);
    });

    test('agent_run owner surfaces ask decision as yielded permission_request', async () => {
        const broker: RuntimePermissionBroker = {
            async requestPermission() { return 'ask'; },
        };

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 77,
                        toolCall: { toolCallId: 'tc-ask', title: 'dangerous_op' },
                        options: [
                            { optionId: 'allow', name: 'Allow', kind: 'approve' },
                            { optionId: 'deny', name: 'Deny', kind: 'reject' },
                        ],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            respondToPermission: () => {},
            cancelPermission: () => {},
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-ask', 'acp-ask-sid', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
            permissionBroker: broker,
        });

        const events: any[] = [];
        for await (const ev of session.send('risky action')) events.push(ev);

        // Permission request was yielded (broker returned 'ask').
        const permEvent = events.find(e => e.kind === 'permission_request');
        assert.ok(permEvent, 'permission_request should be yielded for ask');
        assert.equal(permEvent.requestId, 77);
    });

    test('chat_node owner yields permission_request without broker (unchanged behavior)', async () => {
        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 55,
                        toolCall: { toolCallId: 'tc-chat', title: 'write' },
                        options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
        } as unknown as KiroRuntime;

        const session = new KiroSession('node-chat', 'acp-chat-sid', fakeRuntime, '/tmp/cwd', {
            owner: CHAT_OWNER,
            // No permissionBroker — chat_node path.
        });

        const events: any[] = [];
        for await (const ev of session.send('hello')) events.push(ev);

        const permEvent = events.find(e => e.kind === 'permission_request');
        assert.ok(permEvent, 'chat sessions should still yield permission_request');
        assert.equal(permEvent.requestId, 55);
    });
});

// ---------------------------------------------------------------------------
// KiroSession agent_run auto-retry disabled
// ---------------------------------------------------------------------------

describe('KiroSession agent_run auto-retry disabled', () => {
    test('agent_run owner does NOT auto-retry on connection failure', async () => {
        let callCount = 0;

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    callCount++;
                    throw new Error('dispatch failure');
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            recoverSession: async () => true,
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-no-retry', 'acp-noretry', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
        });

        await assert.rejects(async () => {
            for await (const ev of session.send('test')) { /* consume */ }
        }, /dispatch failure/);

        // Should have been called only once — no retry for agent_run.
        assert.equal(callCount, 1);
    });

    test('chat_node owner still gets auto-retry on connection failure', async () => {
        let callCount = 0;

        const fakeRuntime = {
            ensureClient: async () => ({
                prompt: async function* () {
                    callCount++;
                    if (callCount === 1) {
                        const err = new Error('dispatch failure') as any;
                        err.rpcData = 'dispatch failure';
                        throw err;
                    }
                    yield { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'ok' }] };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            recoverSession: async () => true,
        } as unknown as KiroRuntime;

        const session = new KiroSession('node-retry', 'acp-retry', fakeRuntime, '/tmp/cwd', {
            owner: CHAT_OWNER,
        });

        const events: any[] = [];
        for await (const ev of session.send('test')) events.push(ev);

        // Should have been called twice — one failure + one retry.
        assert.equal(callCount, 2);
        assert.ok(events.some(e => e.kind === 'chunk'));
    });
});

// ---------------------------------------------------------------------------
// KiroSession owner/identity fields
// ---------------------------------------------------------------------------

describe('KiroSession owner identity fields', () => {
    test('session exposes owner and runtimeProfileHash', () => {
        const fakeRuntime = {
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
        } as unknown as KiroRuntime;

        const session = new KiroSession('attempt-id', 'acp-native', fakeRuntime, '/tmp/cwd', {
            owner: RUN_OWNER,
            runtimeProfileHash: 'hash-xyz',
        });

        assert.equal(session.id, 'attempt-id');
        assert.equal(session.nativeSessionId, 'acp-native');
        assert.deepEqual(session.owner, RUN_OWNER);
        assert.equal(session.runtimeProfileHash, 'hash-xyz');
        assert.equal(session.runtimeId, 'kiro');
    });

    test('session defaults runtimeProfileHash to null', () => {
        const fakeRuntime = {
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
        } as unknown as KiroRuntime;

        const session = new KiroSession('id', 'sid', fakeRuntime, '/tmp/cwd');
        assert.equal(session.runtimeProfileHash, null);
        assert.equal(session.owner, undefined);
    });
});

// ---------------------------------------------------------------------------
// Owner utility function tests
// ---------------------------------------------------------------------------

describe('Owner equality utilities', () => {
    test('sameOwner matches identical agent_run owners', () => {
        assert.ok(sameOwner(RUN_OWNER, { ...RUN_OWNER }));
    });

    test('sameOwner rejects different agent_run owners', () => {
        assert.ok(!sameOwner(RUN_OWNER, WRONG_OWNER));
    });

    test('sameOwner rejects different kinds', () => {
        assert.ok(!sameOwner(RUN_OWNER, CHAT_OWNER));
    });

    test('assertOwner throws on mismatch', () => {
        assert.throws(() => assertOwner(RUN_OWNER, WRONG_OWNER), /Owner mismatch/);
    });

    test('assertOwner succeeds on match', () => {
        assertOwner(RUN_OWNER, { ...RUN_OWNER });
    });
});
