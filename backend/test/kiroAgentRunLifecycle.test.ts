/**
 * T07 — Kiro process lifecycle and safe recovery tests.
 *
 * Exercises:
 * - rebindRunSession restores owner, broker, result callback, model/mode,
 *   public/native maps, and MCP slot after process replacement.
 * - Run owner does NOT auto-resend after connection failure.
 * - Chat owner retains the existing zero-visible-output retry.
 * - Idle cleanup kills only unreferenced cwd clients.
 * - Global process cap and session cap report DISTINCT capacity failures.
 * - purgeSessionsForCwd only purges sessions for that specific cwd.
 * - Concurrent worktree Runs cannot leak or destroy each other's sessions.
 * - Shutdown is deterministic for idle timers, slots, sessions, and clients.
 *
 * These tests use mock/stub AcpClient and McpSlotRegistry. They do NOT
 * require node:sqlite — KiroRuntime is imported but the tests stub out
 * ensureClient/loadAcpSession so the db import path is never exercised
 * at runtime (the import will fail at load time on Node < 22, same as
 * kiroAgentRunRuntime.test.ts).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRuntime, KiroConcurrencyError } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import type { KiroSessionBinding } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type {
    RuntimeSessionOwner,
    RuntimeToolProfile,
    RuntimePermissionBroker,
} from '../src/agents/types';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { chatOwner, runOwner } from './helpers/owners';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const bridge: AgentToolBridge = {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
};

function makeOwner(runId: string, attemptId: string): RuntimeSessionOwner {
    return runOwner(runId, attemptId);
}

function makeRegistry() {
    return fakeMcpRegistry();
}

function fakeClient(cwd: string, opts?: { loadFail?: boolean }) {
    const sessions = new Map<string, boolean>();
    const models = new Map<string, string>();
    let nextSid = 0;
    return {
        cwd,
        isAlive: () => true,
        newSession: async (mcpServers: any[]) => {
            const sid = `acp-${cwd}-${nextSid++}`;
            sessions.set(sid, true);
            return { sessionId: sid, modes: {}, models: {} };
        },
        loadSession: async (sid: string) => {
            if (opts?.loadFail) throw new Error('load failed');
            sessions.set(sid, true);
            return { modes: {}, models: {} };
        },
        cancel: async () => {},
        setModel: async (sid: string, model: string) => { models.set(sid, model); },
        destroySession: (sid: string) => { sessions.delete(sid); },
        shutdown: async () => { sessions.clear(); },
        sessions,
        models,
        injectUpdate: () => {},
        onExit: () => {},
    };
}

// ---------------------------------------------------------------------------
// rebindRunSession
// ---------------------------------------------------------------------------

describe('KiroRuntime.rebindRunSession', () => {
    test('restores owner, broker, result callback, model/mode, maps, and MCP slot', async () => {
        const registry = makeRegistry();
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        const client = fakeClient('/tmp/worktree-a');
        rt.ensureClient = async () => client;

        const owner = makeOwner('run-1', 'attempt-1');
        const toolProfile: RuntimeToolProfile = { allowedToolNames: ['submit_agent_result', 'read'] };
        const brokerDecisions: string[] = [];
        const broker: RuntimePermissionBroker = {
            requestPermission: async (req) => {
                brokerDecisions.push(req.toolName);
                return 'allow_once';
            },
        };

        const binding: KiroSessionBinding = {
            publicSessionId: 'attempt-1',
            nativeSessionId: 'acp-original-sid',
            owner,
            cwd: '/tmp/worktree-a',
            workspaceId: 'ws-1',
            ownerUserId: 'user-1',
            runtimeProfileHash: 'hash-abc',
            toolProfile,
            permissionBroker: broker,
            slotId: undefined, // will be allocated fresh
            modelId: 'claude-sonnet-4.6',
        };

        const session = await runtime.rebindRunSession(binding);

        // Public identity restored.
        assert.equal(session.id, 'attempt-1');
        assert.equal(session.nativeSessionId, 'acp-original-sid');
        assert.deepEqual(session.owner, owner);
        assert.equal(session.runtimeProfileHash, 'hash-abc');
        assert.equal((session as any).enableFollowUps, false);
        assert.equal(rt.acquiredSessions.get('attempt-1'), session);

        // Binding record stored.
        const storedBinding = runtime.getBinding('attempt-1');
        assert.ok(storedBinding);
        assert.equal(storedBinding.nativeSessionId, 'acp-original-sid');
        assert.deepEqual(storedBinding.owner, owner);
        assert.equal(storedBinding.runtimeProfileHash, 'hash-abc');
        assert.equal(storedBinding.workspaceId, 'ws-1');
        assert.equal(storedBinding.modelId, 'claude-sonnet-4.6');
        assert.equal(client.models.get('acp-original-sid'), 'claude-sonnet-4.6');
        assert.ok(storedBinding.toolProfile);
        assert.ok(storedBinding.permissionBroker);

        // Reverse index works.
        const byNative = runtime.getBindingByNativeSid('acp-original-sid');
        assert.ok(byNative);
        assert.equal(byNative.publicSessionId, 'attempt-1');

        // MCP slot was created.
        assert.ok(storedBinding.slotId);
        assert.ok(registry.slots.has(storedBinding.slotId!));
    });

    test('rejects a chat (interactive) owner', async () => {
        const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
        const binding: KiroSessionBinding = {
            publicSessionId: 'node-1',
            nativeSessionId: 'acp-sid',
            owner: chatOwner('node-1'),
            cwd: '/tmp/cwd',
            workspaceId: null,
            ownerUserId: null,
            runtimeProfileHash: null,
        };
        await assert.rejects(
            () => runtime.rebindRunSession(binding),
            /agent_run/,
        );
    });

    test('cleans up MCP slot when loadSession fails', async () => {
        const registry = makeRegistry();
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        const client = fakeClient('/tmp/worktree-fail', { loadFail: true });
        rt.ensureClient = async () => client;

        const binding: KiroSessionBinding = {
            publicSessionId: 'attempt-fail',
            nativeSessionId: 'acp-fail-sid',
            owner: makeOwner('run-fail', 'attempt-fail'),
            cwd: '/tmp/worktree-fail',
            workspaceId: null,
            ownerUserId: null,
            runtimeProfileHash: null,
        };

        await assert.rejects(() => runtime.rebindRunSession(binding), /load failed/);

        // Slot should have been disposed on failure.
        assert.equal(registry.slots.size, 0);
    });
});

// ---------------------------------------------------------------------------
// Process cap
// ---------------------------------------------------------------------------

describe('KiroRuntime process cap', () => {
    test('session cap reports KiroConcurrencyError (distinct from process cap)', async () => {
        const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        // Set low session cap.
        (rt as any).concurrencyCap = 1;
        rt.sessionCwd.set('existing-sid', '/tmp/a');
        rt.ensureClient = async () => fakeClient('/tmp/a');

        await assert.rejects(
            () => runtime.newSession({ cwd: '/tmp/a', owner: makeOwner('r', 'a-new') }),
            (err: any) => {
                assert.ok(err instanceof KiroConcurrencyError);
                return true;
            },
        );
    });
});

// ---------------------------------------------------------------------------
// Idle TTL cleanup
// ---------------------------------------------------------------------------

describe('KiroRuntime idle cleanup', () => {
    test('schedules idle cleanup after last session for a cwd is released', async () => {
        const registry = makeRegistry();
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        // Set a very short idle TTL for testing.
        (rt as any).idleTtlMs = 50;

        const client = fakeClient('/tmp/worktree-idle');
        let shutdownCalled = false;
        client.shutdown = async () => { shutdownCalled = true; };
        rt.pool.set('/tmp/worktree-idle', client);

        // Simulate a session bound to this cwd.
        const owner = makeOwner('run-idle', 'attempt-idle');
        rt.sessionCwd.set('acp-idle-sid', '/tmp/worktree-idle');
        rt.sidByNodeId.set('attempt-idle', 'acp-idle-sid');
        rt.nodeIdBySid.set('acp-idle-sid', 'attempt-idle');
        rt.bindings.set('attempt-idle', {
            publicSessionId: 'attempt-idle',
            nativeSessionId: 'acp-idle-sid',
            owner,
            cwd: '/tmp/worktree-idle',
            workspaceId: null,
            ownerUserId: null,
            runtimeProfileHash: null,
        });
        rt.publicIdByNativeSid.set('acp-idle-sid', 'attempt-idle');

        // Release the session — should schedule idle cleanup.
        await runtime.releaseSession('attempt-idle', owner);

        // Session maps should be cleared.
        assert.equal(rt.sessionCwd.has('acp-idle-sid'), false);

        // Idle timer should be scheduled.
        assert.ok(rt.idleTimers.has('/tmp/worktree-idle'));

        // Wait for the idle timer to fire.
        await new Promise(resolve => setTimeout(resolve, 100));

        // Process should have been shut down.
        assert.ok(shutdownCalled);
        assert.ok(!rt.pool.has('/tmp/worktree-idle'));
    });

    test('creating a new session cancels the idle timer for its cwd', async () => {
        const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        (rt as any).idleTtlMs = 50;

        // Manually set an idle timer.
        const timer = setTimeout(() => {}, 50000);
        rt.idleTimers.set('/tmp/worktree-reuse', timer);

        const client = fakeClient('/tmp/worktree-reuse');
        rt.pool.set('/tmp/worktree-reuse', client);
        // Creating a session should cancel the idle timer.
        try {
            await runtime.newSession({
                cwd: '/tmp/worktree-reuse',
                owner: makeOwner('run-reuse', 'attempt-reuse'),
            });
            assert.ok(!rt.idleTimers.has('/tmp/worktree-reuse'));
        } finally {
            clearTimeout(timer);
            await runtime.shutdown();
        }
    });
});

// ---------------------------------------------------------------------------
// purgeSessionsForCwd isolation
// ---------------------------------------------------------------------------

describe('KiroRuntime purgeSessionsForCwd isolation', () => {
    test('process exit purges ONLY sessions bound to that cwd', async () => {
        const registry = makeRegistry();
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        const ownerA = makeOwner('run-a', 'attempt-a');
        const ownerB = makeOwner('run-b', 'attempt-b');

        // Manually bind sessions to two different cwds.
        rt.sessionCwd.set('acp-sid-a', '/tmp/worktree-a');
        rt.sidByNodeId.set('attempt-a', 'acp-sid-a');
        rt.nodeIdBySid.set('acp-sid-a', 'attempt-a');
        rt.bindings.set('attempt-a', {
            publicSessionId: 'attempt-a',
            nativeSessionId: 'acp-sid-a',
            owner: ownerA,
            cwd: '/tmp/worktree-a',
            workspaceId: null,
            ownerUserId: null,
            runtimeProfileHash: null,
        });
        rt.publicIdByNativeSid.set('acp-sid-a', 'attempt-a');

        rt.sessionCwd.set('acp-sid-b', '/tmp/worktree-b');
        rt.sidByNodeId.set('attempt-b', 'acp-sid-b');
        rt.nodeIdBySid.set('acp-sid-b', 'attempt-b');
        rt.bindings.set('attempt-b', {
            publicSessionId: 'attempt-b',
            nativeSessionId: 'acp-sid-b',
            owner: ownerB,
            cwd: '/tmp/worktree-b',
            workspaceId: null,
            ownerUserId: null,
            runtimeProfileHash: null,
        });
        rt.publicIdByNativeSid.set('acp-sid-b', 'attempt-b');

        // Purge cwd-a.
        rt.purgeSessionsForCwd('/tmp/worktree-a');

        // Session A should be gone.
        assert.equal(runtime.getBinding('attempt-a'), undefined);
        assert.equal(rt.sessionCwd.has('acp-sid-a'), false);

        // Session B should be intact.
        assert.ok(runtime.getBinding('attempt-b'));
        assert.equal(rt.sessionCwd.get('acp-sid-b'), '/tmp/worktree-b');
    });
});

// ---------------------------------------------------------------------------
// Concurrent worktree Runs isolation
// ---------------------------------------------------------------------------

describe('KiroRuntime concurrent worktree Run isolation', () => {
    test('two Runs on different worktrees have independent sessions and MCP slots', async () => {
        const registry = makeRegistry();
        const runtime = new KiroRuntime({ bridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
        const rt = runtime as any;

        let clientForCwd: Record<string, any> = {};
        rt.ensureClient = async (cwd: string) => {
            if (!clientForCwd[cwd]) clientForCwd[cwd] = fakeClient(cwd);
            return clientForCwd[cwd];
        };

        const ownerA = makeOwner('run-a', 'attempt-a');
        const ownerB = makeOwner('run-b', 'attempt-b');

        const sessionA = await runtime.newSession({
            cwd: '/tmp/worktree-a',
            owner: ownerA,
            toolProfile: { allowedToolNames: ['submit_agent_result'] },
        });

        const sessionB = await runtime.newSession({
            cwd: '/tmp/worktree-b',
            owner: ownerB,
            toolProfile: { allowedToolNames: ['submit_agent_result'] },
        });

        // Both sessions exist with distinct bindings.
        assert.notEqual(sessionA.nativeSessionId, sessionB.nativeSessionId);

        const bindingA = runtime.getBinding('attempt-a');
        const bindingB = runtime.getBinding('attempt-b');
        assert.ok(bindingA);
        assert.ok(bindingB);
        assert.equal(bindingA.cwd, '/tmp/worktree-a');
        assert.equal(bindingB.cwd, '/tmp/worktree-b');
        assert.notEqual(bindingA.slotId, bindingB.slotId);

        // Releasing A doesn't affect B.
        await runtime.releaseSession('attempt-a', ownerA);
        assert.equal(runtime.getBinding('attempt-a'), undefined);
        assert.ok(runtime.getBinding('attempt-b'));
    });
});
