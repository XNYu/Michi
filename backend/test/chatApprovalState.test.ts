import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { ApprovalCoordinator } from 'michi-runtime';
import { ChatApprovalState, chatApprovalOptions, acpPermissionToolName, approvalCoversTool } from '../src/agents/chatApprovalState';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner, runOwner } from './helpers/owners';

const owner = chatOwner('a');
afterEach(__resetRuntimeDeps);
function setup() {
    const grants = new Set<string>();
    const revisions: Record<string, string> = {};
    configureRuntimeDeps({
        dataDir: '/tmp/michi-approval-state-tests',
        historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null,
            hasGrant: () => false, grantPermission: () => { throw new Error('No workspace grants'); } },
        agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined },
        chatPermissions: {
            getMode: () => 'ask', hasGrant: (id, name) => grants.has(`${id}:${name}`),
            grant: (id, name) => { grants.add(`${id}:${name}`); }, resetToken: (id) => revisions[id] ?? '0',
        },
    });
    return { grants, revisions };
}

test('session trust works despite global Ask, is transient, and resets on explicit permissions updates', () => {
    const { grants, revisions } = setup();
    const state = new ChatApprovalState();
    assert.equal(state.accept('allow_session', owner, 'Bash'), true);
    assert.equal(state.policy(owner, null, 'edit', true, 'ask'), 'allow');
    assert.equal(state.policy(owner, null, 'mcp__unknown__mutate', true, 'ask'), 'allow');
    assert.equal(grants.size, 0, 'all-tools trust is not persisted');
    assert.equal(new ChatApprovalState().policy(owner, null, 'edit', true), 'ask', 'recreated runtime session loses trust');
    revisions.a = '1';
    assert.equal(state.policy(owner, null, 'edit', true), 'ask');
    state.accept('allow_session', owner, undefined);
    assert.equal(state.policy(chatOwner('b'), null, 'edit', true), 'ask', 'owner rebinding cannot inherit session trust');
    assert.equal(state.policy(owner, null, 'edit', true), 'ask');
    state.accept('allow_session', owner, undefined, 'alice');
    assert.equal(state.policy(owner, 'bob', 'edit', true), 'ask', 'session trust cannot cross authenticated owners');
});

test('Michi thread messages avoid a second runtime approval in Ask mode without trusting other MCP tools', () => {
    setup();
    const state = new ChatApprovalState();
    for (const name of ['send_to_thread', 'mcp____michi_internal____send_to_thread', '@michi/send_to_thread']) {
        assert.equal(state.policy(owner, null, name, false, 'ask'), 'allow');
        assert.equal(state.policy(owner, null, name, true, 'ask'), 'allow');
    }
    assert.equal(acpPermissionToolName({ title: '@michi/send_to_thread' }), '@michi/send_to_thread');
    for (const name of ['bash', 'mcp__other__send_to_thread', '@other/send_to_thread']) {
        assert.equal(state.policy(owner, null, name, true, 'ask'), 'ask');
    }
    assert.equal(state.policy(runOwner('r', 'a'), null, 'send_to_thread', true, 'ask'), 'ask');
});

test('Run owners cannot acquire ordinary session or tool trust; ambiguous ACP titles cannot grant a tool', () => {
    setup();
    const state = new ChatApprovalState();
    const run = runOwner('r', 'attempt');
    assert.equal(state.accept('allow_session', run, 'Bash'), false);
    assert.equal(state.accept('allow_always', run, 'Bash'), false);
    assert.equal(state.accept('allow_always', owner, undefined), false);
    assert.equal(acpPermissionToolName({ title: 'Run shell command to change files' }), undefined);
    assert.equal(acpPermissionToolName({ title: 'execute_bash' }), 'execute_bash');
    assert.equal(acpPermissionToolName({ title: 'Read files' }, { toolName: 'mcp__reader__read' }), 'mcp__reader__read');
    assert.equal(chatApprovalOptions().find((o) => o.kind === 'allow_always')?.disabled, true);
});

test('ChatApprovalState is the package ApprovalCoordinator; a grant covers the same Michi canonical tool', () => {
    assert.ok(new ChatApprovalState() instanceof ApprovalCoordinator);
    assert.equal(approvalCoversTool('allow_always', 'Bash', 'bash'), true);
    assert.equal(approvalCoversTool('allow_always', 'MultiEdit', 'Edit'), true);
    assert.equal(approvalCoversTool('allow_always', 'Read', 'read'), false, 'Read grants keep their own key');
    assert.equal(approvalCoversTool('allow_always', 'bash', 'edit'), false);
    assert.equal(approvalCoversTool('allow_session', 'bash', 'edit'), true);
    assert.equal(new ChatApprovalState().covers('allow_always', 'Write', 'write'), true);
});

for (const decision of ['allow_once', 'reject_once', 'michi:allow_always', 'michi:allow_session']) {
}

test('ACP resolved and cancelled requests cannot create grants', async () => {
    const { grants } = setup();
    const wire: unknown[] = [];
    const runtime = {
        host: michiTestHost(),
        ensureClient: async () => ({ prompt: async function* () {
            yield { sessionUpdate: 'permission_request', requestId: 10, toolCall: { title: 'bash' }, options: [
                { optionId: 'once', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
            ] };
            yield { sessionUpdate: 'permission_resolved', requestId: 10 };
            yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        } }), getCurrentMode: () => undefined, getCurrentModel: () => undefined,
        respondToPermission: (...args: unknown[]) => wire.push(args), cancelPermission: () => {},
    } as unknown as KiroRuntime;
    const session = new KiroSession('a', 'native-a', runtime, '/tmp', { owner });
    for await (const event of session.send('test')) {
        if (event.kind === 'permission_request') assert.throws(() => session.respondToPermission(10, 'forged'), /Invalid/);
        if (event.kind === 'permission_resolved') session.respondToPermission(10, 'michi:allow_always');
    }
    assert.equal(grants.size, 0);
    assert.equal(wire.length, 0);
});

for (const choice of ['michi:allow_always', 'michi:allow_session']) test(`ACP ${choice} also drains earlier matching pending requests with single-use native approvals`, async () => {
    setup();
    const wire: unknown[] = [];
    const runtime = {
        host: michiTestHost(),
        ensureClient: async () => ({ prompt: async function* () {
            for (const id of [1, 2]) yield { sessionUpdate: 'permission_request', requestId: id,
                toolCall: { title: 'bash' }, options: [{ optionId: 'native-once', kind: 'allow_once', name: 'Allow' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] };
            yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        } }), getCurrentMode: () => undefined, getCurrentModel: () => undefined,
        respondToPermission: (...args: unknown[]) => wire.push(args),
    } as unknown as KiroRuntime;
    const session = new KiroSession('a', 'native-a', runtime, '/tmp', { owner });
    const turn = session.send('test');
    assert.equal((await turn.next()).value?.kind, 'permission_request');
    assert.equal((await turn.next()).value?.kind, 'permission_request');
    session.respondToPermission(2, choice);
    assert.deepEqual(wire, [['native-a', 2, 'native-once'], ['native-a', 1, 'native-once']]);
    await turn.return?.(undefined);
});
