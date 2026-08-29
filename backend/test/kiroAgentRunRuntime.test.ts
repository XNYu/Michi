/**
 * T05 — KiroRuntime Agent Run session tests (requires Node 22+ for node:sqlite).
 *
 * These tests exercise KiroRuntime.newSession, loadSession, releaseSession,
 * and binding records for `agent_run` owners. They import KiroRuntime which
 * transitively depends on node:sqlite via dbRepository. On Node < 22 these
 * tests will fail with ERR_UNKNOWN_BUILTIN_MODULE — same as the pre-existing
 * kiroRuntime.test.ts. Run on Node 22+ for full coverage.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type {
    AgentSession,
    RuntimeSessionOwner,
    RuntimeToolProfile,
} from '../src/agents/types';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const bridge: AgentToolBridge = {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
};

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

// ---------------------------------------------------------------------------
// newSession for agent_run
// ---------------------------------------------------------------------------

describe('KiroRuntime Agent Run newSession', () => {
    test('creates a fresh ACP session with agent_run owner and returns attemptId as public id', async () => {
        const createdSlots: any[] = [];
        const slots = new Map<string, any>();
        const registry = {
            get: (id: string) => slots.get(id),
            dispose: async (id: string) => { slots.delete(id); },
            create: (parentChatId: string, cwd: string, ownerUserId: string | null, cbs: any, opts?: any) => {
                const slot = { slotId: `slot-${createdSlots.length}`, parentChatId, cwd, ownerUserId, ...cbs, ...opts };
                slots.set(slot.slotId, slot);
                createdSlots.push(slot);
                return slot;
            },
        };

        const runtime = new KiroRuntime(bridge, registry as any, 9999, '/tmp/default');
        const rt = runtime as any;
        let sessionNewCount = 0;
        rt.ensureClient = async () => ({
            newSession: async (mcpServers: any[]) => {
                sessionNewCount++;
                return { sessionId: `acp-run-sid-${sessionNewCount}`, modes: {}, models: {} };
            },
        });
        // Warm sessions should NOT be consumed for runs.
        rt.warmedSessions.set('/tmp/cwd', { sid: 'warm-sid', slotId: 'warm-slot' });

        const toolProfile: RuntimeToolProfile = { allowedToolNames: ['submit_agent_result', 'read'] };

        const session = await runtime.newSession({
            cwd: '/tmp/cwd',
            owner: RUN_OWNER,
            toolProfile,
            profileHash: 'hash-abc',
            workspaceId: 'ws-run',
            ownerUserId: 'user-run',
        });

        assert.equal(session.id, 'attempt-1');
        assert.equal(session.nativeSessionId, 'acp-run-sid-1');
        assert.equal(session.runtimeProfileHash, 'hash-abc');
        assert.deepEqual(session.owner, RUN_OWNER);

        // Warm session was NOT consumed.
        assert.ok(rt.warmedSessions.has('/tmp/cwd'));

        // Fresh session/new was called.
        assert.equal(sessionNewCount, 1);

        // MCP slot was created with agent_run owner.
        assert.equal(createdSlots.length, 1);
        assert.deepEqual(createdSlots[0].owner, RUN_OWNER);

        // Binding record stored.
        const binding = runtime.getBinding('attempt-1');
        assert.ok(binding);
        assert.equal(binding.publicSessionId, 'attempt-1');
        assert.equal(binding.nativeSessionId, 'acp-run-sid-1');
        assert.deepEqual(binding.owner, RUN_OWNER);
        assert.equal(binding.runtimeProfileHash, 'hash-abc');
        assert.equal(binding.workspaceId, 'ws-run');
    });

    test('chat session still consumes warm pool (backward compat)', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({});
        rt.warmNextSession = () => {};
        rt.warmedSessions.set('/tmp/cwd', { sid: 'warm-chat-sid', currentModeId: 'default' });

        const session = await runtime.newSession({
            cwd: '/tmp/cwd',
            sessionId: 'node-chat-1',
        });

        assert.equal(session.id, 'node-chat-1');
        assert.equal(session.nativeSessionId, 'warm-chat-sid');
        assert.ok(!rt.warmedSessions.has('/tmp/cwd'));
    });
});

// ---------------------------------------------------------------------------
// loadSession for agent_run
// ---------------------------------------------------------------------------

describe('KiroRuntime Agent Run loadSession', () => {
    test('resumes from nativeResumeToken without Node lookup', async () => {
        const loadedSids: string[] = [];
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({
            loadSession: async (sid: string) => {
                loadedSids.push(sid);
                return { modes: {}, models: {} };
            },
        });

        const session = await runtime.loadSession!({
            sessionId: 'attempt-resume',
            cwd: '/tmp/cwd',
            owner: RUN_OWNER,
            nativeResumeToken: 'acp-original-sid',
            profileHash: 'hash-resume',
            workspaceId: 'ws-resume',
        });

        assert.equal(session.id, 'attempt-1');
        assert.equal(session.nativeSessionId, 'acp-original-sid');
        assert.deepEqual(session.owner, RUN_OWNER);
        assert.equal(session.runtimeProfileHash, 'hash-resume');

        // loadSession used nativeResumeToken directly.
        assert.deepEqual(loadedSids, ['acp-original-sid']);

        // Binding stored.
        const binding = runtime.getBinding('attempt-1');
        assert.ok(binding);
        assert.equal(binding.nativeSessionId, 'acp-original-sid');
    });

    test('rejects agent_run loadSession without nativeResumeToken', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({});

        await assert.rejects(
            () => runtime.loadSession!({
                sessionId: 'attempt-bad',
                cwd: '/tmp/cwd',
                owner: RUN_OWNER,
            }),
            /nativeResumeToken/,
        );
    });
});

// ---------------------------------------------------------------------------
// releaseSession with owner verification
// ---------------------------------------------------------------------------

describe('KiroRuntime releaseSession with owner verification', () => {
    test('releases session when owner matches', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        let sessionNewCalls = 0;
        rt.ensureClient = async () => ({
            newSession: async () => ({ sessionId: `acp-release-${++sessionNewCalls}`, modes: {}, models: {} }),
            cancel: async () => {},
            destroySession: () => {},
        });

        await runtime.newSession({ cwd: '/tmp/cwd', owner: RUN_OWNER });
        await runtime.releaseSession('attempt-1', RUN_OWNER);
        assert.equal(runtime.getBinding('attempt-1'), undefined);
    });

    test('rejects release when owner does not match', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({
            newSession: async () => ({ sessionId: 'acp-release-wrong', modes: {}, models: {} }),
            cancel: async () => {},
            destroySession: () => {},
        });

        await runtime.newSession({ cwd: '/tmp/cwd', owner: RUN_OWNER });
        await assert.rejects(
            () => runtime.releaseSession('attempt-1', WRONG_OWNER),
            /Owner mismatch/,
        );
        assert.ok(runtime.getBinding('attempt-1'));
    });
});

// ---------------------------------------------------------------------------
// Binding record management
// ---------------------------------------------------------------------------

describe('KiroRuntime binding records', () => {
    test('getBindingByNativeSid returns binding via reverse index', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({
            newSession: async () => ({ sessionId: 'acp-native-lookup', modes: {}, models: {} }),
        });

        await runtime.newSession({ cwd: '/tmp/cwd', owner: RUN_OWNER, profileHash: 'hash-lookup' });

        const binding = runtime.getBindingByNativeSid('acp-native-lookup');
        assert.ok(binding);
        assert.equal(binding.publicSessionId, 'attempt-1');
        assert.equal(binding.runtimeProfileHash, 'hash-lookup');
    });

    test('bindings are cleaned up on shutdown', async () => {
        const runtime = new KiroRuntime(bridge, undefined, 9999, '/tmp/default');
        const rt = runtime as any;
        rt.ensureClient = async () => ({
            newSession: async () => ({ sessionId: 'acp-shutdown', modes: {}, models: {} }),
            shutdown: async () => {},
        });

        await runtime.newSession({ cwd: '/tmp/cwd', owner: RUN_OWNER });
        assert.ok(runtime.getBinding('attempt-1'));

        await runtime.shutdown();

        assert.equal(runtime.getBinding('attempt-1'), undefined);
        assert.equal(runtime.getBindingByNativeSid('acp-shutdown'), undefined);
    });
});
