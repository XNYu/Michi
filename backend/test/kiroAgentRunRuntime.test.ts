/**
 * T05 — AcpAgentRuntime Agent Run session tests (requires Node 22+ for node:sqlite).
 *
 * These tests exercise AcpAgentRuntime.newSession, loadSession, releaseSession,
 * and binding records for `agent_run` owners. They import AcpAgentRuntime which
 * transitively depends on node:sqlite via dbRepository. On Node < 22 these
 * tests will fail with ERR_UNKNOWN_BUILTIN_MODULE — same as the pre-existing
 * kiroRuntime.test.ts. Run on Node 22+ for full coverage.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { RuntimePermissionBroker, RuntimePermissionRequest, RuntimeSessionOwner } from '../src/agents/types';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const bridge: AgentToolBridge = {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
};

const RUN_OWNER: RuntimeSessionOwner = runOwner('run-1', 'attempt-1');
const RUN_ATTEMPT = 'attempt-1';

const WRONG_OWNER: RuntimeSessionOwner = runOwner('run-2', 'attempt-2');
const WRONG_ATTEMPT = 'attempt-2';

// ---------------------------------------------------------------------------
// loadSession for agent_run
// ---------------------------------------------------------------------------

describe('AcpAgentRuntime Agent Run loadSession', () => {
    test('fresh and resumed Runs both disable follow-ups', async () => {
        const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost(), engine: 'v2' });
        const rt = runtime as any;
        rt.ensureClient = async () => ({
            newSession: async () => ({ sessionId: 'acp-fresh', modes: {}, models: {} }),
            loadSession: async () => ({ modes: {}, models: {} }),
        });
        try {
            const fresh = await runtime.newSession({ sessionId: RUN_ATTEMPT, owner: RUN_OWNER, cwd: '/tmp/cwd' });
            const resumedOwner = runOwner('run-resume', 'attempt-resume');
            const resumed = await runtime.loadSession({
                sessionId: 'attempt-resume', owner: resumedOwner, cwd: '/tmp/cwd', nativeResumeToken: 'acp-resumed',
            });
            assert.equal((fresh as AcpAgentSession).getEnableFollowUps(), false);
            assert.equal((resumed as AcpAgentSession).getEnableFollowUps(), false);
        } finally {
            await runtime.shutdown();
        }
    });

    test('resumes from nativeResumeToken without Node lookup', async () => {
        const loadedSids: string[] = [];
        const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
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

    test('the Run permission broker receives canonical tool names and the Run owner ids', async () => {
        const requests: RuntimePermissionRequest[] = [];
        const broker: RuntimePermissionBroker = {
            async requestPermission(request) { requests.push(request); return 'deny'; },
        };
        const options = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }];
        const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost(), engine: 'v2' });
        (runtime as any).ensureClient = async () => ({
            newSession: async () => ({ sessionId: 'acp-fresh', modes: {}, models: {} }),
            loadSession: async () => ({ modes: {}, models: {} }),
            async *prompt() {
                // Kiro titles are prose; only provider metadata names the tool.
                yield { sessionUpdate: 'permission_request', requestId: 1, options, _meta: { toolName: 'execute_bash' },
                    toolCall: { toolCallId: 'tc-named', title: 'Running: rm -rf build' } };
                yield { sessionUpdate: 'permission_request', requestId: 2, options,
                    toolCall: { toolCallId: 'tc-prose', title: 'Editing README.md' } };
                yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
            },
        });
        const ids = { workspaceId: 'ws-run', ownerUserId: 'alice', permissionBroker: broker };
        try {
            const fresh = await runtime.newSession({ sessionId: RUN_ATTEMPT, owner: RUN_OWNER, cwd: '/tmp/cwd', ...ids });
            const resumed = await runtime.loadSession!({
                sessionId: WRONG_ATTEMPT, owner: WRONG_OWNER, cwd: '/tmp/cwd', nativeResumeToken: 'acp-resumed', ...ids,
            });
            const rebound = await runtime.rebindRunSession(runtime.getBinding(WRONG_ATTEMPT)!);
            for (const session of [fresh, resumed, rebound]) {
                for await (const _event of session.send('go')) { /* drain */ }
            }
            // execute_bash is Kiro's shell tool: the broker receives Michi's canonical bash.
            assert.deepEqual(requests.map((r) => [r.toolName, r.ownerUserId, r.workspaceId, r.toolCallId]), [
                ['bash', 'alice', 'ws-run', 'tc-named'], ['unknown', 'alice', 'ws-run', 'tc-prose'],
                ['bash', 'alice', 'ws-run', 'tc-named'], ['unknown', 'alice', 'ws-run', 'tc-prose'],
                ['bash', 'alice', 'ws-run', 'tc-named'], ['unknown', 'alice', 'ws-run', 'tc-prose'],
            ]);
        } finally {
            await runtime.shutdown();
        }
    });

    test('rejects agent_run loadSession without nativeResumeToken', async () => {
        const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
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
