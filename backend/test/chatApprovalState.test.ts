import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { ChatApprovalState, chatApprovalOptions, acpPermissionToolName } from '../src/agents/chatApprovalState';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';

const owner = { kind: 'chat_node' as const, nodeId: 'a' };
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

test('once and deny never grant trust; tool trust is canonical and chat scoped', () => {
    const { grants } = setup();
    const state = new ChatApprovalState();
    assert.equal(state.accept('reject_once', owner, 'Bash'), false);
    assert.equal(state.accept('allow_once', owner, 'Bash'), true);
    assert.equal(grants.size, 0);
    assert.equal(state.policy(owner, null, 'Bash', true), 'ask');
    assert.equal(state.accept('allow_always', owner, 'Bash'), true);
    assert.deepEqual([...grants], ['a:bash']);
    assert.equal(state.policy(owner, null, 'bash', true), 'allow');
    assert.equal(state.policy(owner, null, 'edit', true), 'ask');
    assert.equal(state.policy({ kind: 'chat_node', nodeId: 'b' }, null, 'bash', true), 'ask');
});

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
    assert.equal(state.policy({ kind: 'chat_node', nodeId: 'b' }, null, 'edit', true), 'ask', 'owner rebinding cannot inherit session trust');
    assert.equal(state.policy(owner, null, 'edit', true), 'ask');
    state.accept('allow_session', owner, undefined, 'alice');
    assert.equal(state.policy(owner, 'bob', 'edit', true), 'ask', 'session trust cannot cross authenticated owners');
});

test('Run owners cannot acquire ordinary session or tool trust; ambiguous ACP titles cannot grant a tool', () => {
    setup();
    const state = new ChatApprovalState();
    const run = { kind: 'agent_run' as const, runId: 'r', attemptId: 'attempt' };
    assert.equal(state.accept('allow_session', run, 'Bash'), false);
    assert.equal(state.accept('allow_always', run, 'Bash'), false);
    assert.equal(state.accept('allow_always', owner, undefined), false);
    assert.equal(acpPermissionToolName({ title: 'Run shell command to change files' }), undefined);
    assert.equal(acpPermissionToolName({ title: 'execute_bash' }), 'execute_bash');
    assert.equal(acpPermissionToolName({ title: 'Read files' }, { toolName: 'mcp__reader__read' }), 'mcp__reader__read');
    assert.equal(chatApprovalOptions().find((o) => o.kind === 'allow_always')?.disabled, true);
});

for (const decision of ['allow_once', 'reject_once', 'michi:allow_always', 'michi:allow_session']) {
    test(`ACP ${decision} uses the exact native single-use response and scopes future requests`, async () => {
        const { grants } = setup();
        const wire: unknown[] = [];
        const runtime = {
            ensureClient: async () => ({ prompt: async function* () {
                for (const [id, tool] of [[10, 'shell'], [11, 'shell'], [12, 'fs_write']] as const) {
                    yield { sessionUpdate: 'permission_request', requestId: id, toolCall: { title: tool }, _meta: { toolName: tool }, options: [
                        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
                        { optionId: 'native-always', kind: 'allow_always', name: 'Native trust' },
                        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
                    ] };
                }
                yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
            } }),
            getCurrentMode: () => undefined, getCurrentModel: () => undefined,
            respondToPermission: (...args: unknown[]) => { wire.push(args); }, cancelPermission: () => {},
        } as unknown as KiroRuntime;
        const session = new KiroSession('a', 'native-a', runtime, '/tmp', { owner });
        const cards: number[] = [];
        for await (const event of session.send('test')) {
            if (event.kind !== 'permission_request') continue;
            cards.push(event.requestId);
            assert.equal(event.options.length, 4);
            assert.equal(event.options.some((o) => o.optionId === 'native-always'), false);
            session.respondToPermission(event.requestId, event.requestId === 10 ? decision : 'reject_once');
        }
        const expectedCards = decision === 'michi:allow_session' ? [10] : decision === 'michi:allow_always' ? [10, 12] : [10, 11, 12];
        assert.deepEqual(cards, expectedCards);
        assert.deepEqual(wire[0], ['native-a', 10, decision === 'reject_once' ? 'reject_once' : 'allow_once']);
        assert.equal(grants.has('a:shell'), decision === 'michi:allow_always');
        const before = wire.length;
        session.respondToPermission(10, 'michi:allow_session');
        assert.equal(wire.length, before, 'old cards cannot authorize another turn');
        assert.equal(new ChatApprovalState().policy({ kind: 'chat_node', nodeId: 'b' }, null, 'shell', true), 'ask');
    });
}

test('ACP resolved and cancelled requests cannot create grants', async () => {
    const { grants } = setup();
    const wire: unknown[] = [];
    const runtime = {
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
