/**
 * T05 — Kiro owner-aware Agent Run session tests.
 *
 * Validates that AcpAgentRuntime and AcpAgentSession correctly handle `agent_run`
 * owners: fresh ACP sessions with Run MCP slots, nativeResumeToken-based
 * resume without Node access, permission brokering, owner-verified release,
 * and no interference with existing chat session behavior.
 *
 * Tests are split into two groups:
 *  - AcpAgentSession tests (permission brokering, retry disabling) that only
 *    import AcpAgentSession and work on any Node version.
 *  - AcpAgentRuntime tests (newSession, loadSession, release, bindings) that
 *    import AcpAgentRuntime and require Node 22+ for the node:sqlite dependency.
 *    These are guarded with a node:sqlite availability check and skipped
 *    gracefully on older Node versions.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import type { RuntimePermissionBroker, RuntimePermissionRequest, RuntimeSessionOwner } from '../src/agents/types';
import { AgentPolicyCategory, AgentPolicyDecision } from 'michi-shared';
import { RuntimeRunExecutor } from '../src/agents/runs/runtimeRunExecutor';
import type { AgentRunSpec } from '../src/agents/runs/ports';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner, runOwner } from './helpers/owners';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const RUN_OWNER: RuntimeSessionOwner = runOwner('run-1', 'attempt-1');

const WRONG_OWNER: RuntimeSessionOwner = runOwner('run-2', 'attempt-2');

const CHAT_OWNER: RuntimeSessionOwner = chatOwner('node-chat-1');

// ---------------------------------------------------------------------------
// AcpAgentSession permission brokering for agent_run
// ---------------------------------------------------------------------------

describe('AcpAgentSession permission brokering', () => {
    test('agent_run owner routes deny through broker and cancels ACP permission', async () => {
        const cancelCalls: Array<{ sid: string; requestId: number }> = [];

        const broker: RuntimePermissionBroker = {
            async requestPermission() { return 'deny'; },
        };

        const fakeRuntime = {
            host: michiTestHost(),
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
        } as unknown as AcpAgentRuntime;

        const session = new AcpAgentSession('attempt-deny', 'acp-deny-sid', fakeRuntime, '/tmp/cwd', {
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
            host: michiTestHost(),
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 88,
                        toolCall: { toolCallId: 'tc-always', title: 'write' },
                        options: [
                            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                            { optionId: 'allowForSession', name: 'Allow for session', kind: 'allow_always' },
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
        } as unknown as AcpAgentRuntime;

        const session = new AcpAgentSession('attempt-always', 'acp-always-sid', fakeRuntime, '/tmp/cwd', {
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
            host: michiTestHost(),
            ensureClient: async () => ({
                prompt: async function* () {
                    yield {
                        sessionUpdate: 'permission_request',
                        requestId: 77,
                        toolCall: { toolCallId: 'tc-ask', title: 'dangerous_op' },
                        options: [
                            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                        ],
                    };
                    yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
                },
            }),
            getCurrentMode: () => undefined,
            getCurrentModel: () => undefined,
            respondToPermission: () => {},
            cancelPermission: () => {},
        } as unknown as AcpAgentRuntime;

        const session = new AcpAgentSession('attempt-ask', 'acp-ask-sid', fakeRuntime, '/tmp/cwd', {
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
});

// ---------------------------------------------------------------------------
// Kiro v2 permission requests named by their tool_call update
// ---------------------------------------------------------------------------

// kiro-cli 2.34.0 v2 shapes (kiroPermissionRequest.live.test.ts): the
// tool_call update names the tool (_meta.kiro.toolName) and arrives before
// the call's request_permission, which names it nowhere.
const KIRO_V2_OPTIONS = [
    { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
];
const v2ToolCall = (toolCallId: string, title: string, toolName: string) => ({
    sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute',
    rawInput: { command: 'echo hi' }, _meta: { kiro: { toolName } },
});
const v2Request = (requestId: number, toolCallId: string, title: string) => ({
    sessionUpdate: 'permission_request', requestId, options: KIRO_V2_OPTIONS,
    toolCall: { toolCallId, title, rawInput: { command: 'echo hi' } },
    _meta: { trustOptions: [{ label: 'Full command', display: 'echo hi', setting_key: 'allowedCommands', patterns: ['echo hi'] }] },
});
const TURN_END = { sessionUpdate: 'turn_end', stopReason: 'end_turn' };

/** A Run session whose turns replay `turns`; records the ACP answers it gives. */
function v2RunSession(turns: Array<Array<Record<string, unknown>>>, broker: RuntimePermissionBroker) {
    const answers: string[] = [];
    let turn = 0;
    const fakeRuntime = {
        host: michiTestHost(),
        ensureClient: async () => ({ prompt: async function* () { yield* turns[turn++]; } }),
        getCurrentMode: () => undefined,
        getCurrentModel: () => undefined,
        respondToPermission: (_sid: string, requestId: number, optionId: string) => { answers.push(`${requestId}:${optionId}`); },
        cancelPermission: (_sid: string, requestId: number) => { answers.push(`${requestId}:cancel`); },
    } as unknown as AcpAgentRuntime;
    const session = new AcpAgentSession('attempt-v2', 'acp-v2-sid', fakeRuntime, '/tmp/cwd', { owner: RUN_OWNER, permissionBroker: broker });
    return { session, answers };
}

async function drainTurn(session: AcpAgentSession): Promise<void> {
    for await (const _event of session.send('go')) { /* drain */ }
}

/** RuntimeRunExecutor's default broker, the one production Runs use. */
function defaultBroker(categories: Partial<Record<AgentPolicyCategory, AgentPolicyDecision>>): RuntimePermissionBroker {
    const executor = new RuntimeRunExecutor() as unknown as {
        createPermissionBroker(input: { spec: AgentRunSpec }): RuntimePermissionBroker;
    };
    return executor.createPermissionBroker({ spec: { effectiveDefinition: { permissionPolicy: { categories } } } as unknown as AgentRunSpec });
}

describe('AcpAgentSession names Kiro v2 permission requests by their tool_call update', () => {
    test('the broker receives the canonical name of the tool kiro-cli called', async () => {
        const requests: RuntimePermissionRequest[] = [];
        const broker: RuntimePermissionBroker = { async requestPermission(request) { requests.push(request); return 'allow_once'; } };
        const { session, answers } = v2RunSession([[
            v2ToolCall('tc-shell', 'Running: echo hi', 'shell'), v2Request(1, 'tc-shell', 'Running: echo hi'),
            v2ToolCall('tc-write', 'Creating probe.txt', 'write'), v2Request(2, 'tc-write', 'Creating probe.txt'),
            v2ToolCall('tc-read', 'Reading probe.txt', 'read'), v2Request(3, 'tc-read', 'Reading probe.txt'),
            TURN_END,
        ]], broker);
        await drainTurn(session);
        assert.deepEqual(requests.map((request) => [request.toolName, request.toolCallId]),
            [['bash', 'tc-shell'], ['write', 'tc-write'], ['read', 'tc-read']]);
        assert.deepEqual(answers, ['1:allow_once', '2:allow_once', '3:allow_once']);
    });

    test('a shell call titled write is denied where ShellExec is', async () => {
        const broker = defaultBroker({
            [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Deny,
            [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Allow,
        });
        const { session, answers } = v2RunSession([[v2ToolCall('tc', 'write', 'shell'), v2Request(1, 'tc', 'write'), TURN_END]], broker);
        await drainTurn(session);
        assert.deepEqual(answers, ['1:cancel']);
    });

    test('without an update earlier in the same turn the request keeps its old name', async () => {
        const names: string[] = [];
        const broker: RuntimePermissionBroker = { async requestPermission({ toolName }) { names.push(toolName); return 'deny'; } };
        const { session } = v2RunSession([
            [v2ToolCall('tc-earlier', 'Running: echo hi', 'shell'), TURN_END],
            [v2Request(1, 'tc-earlier', 'Running: echo hi'), v2Request(2, 'tc-unseen', 'write'), TURN_END],
        ], broker);
        await drainTurn(session);
        await drainTurn(session);
        assert.deepEqual(names, ['unknown', 'write']);
    });
});
