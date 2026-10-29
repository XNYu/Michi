/**
 * Kiro V2 subagent approvals. A crew child runs in its own native session,
 * which Michi never opened and which has no queue; kiro-cli 2.35.1 asks for
 * the child's tool approval with that child's sessionId (recorded probe,
 * 2026-10-29). The approval must reach the parent's turn: a cancelled one
 * ends the child ("Tool use was cancelled by the user") and leaves a
 * blocking crew waiting forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import { kiroV2RosterEntry, SUBAGENT_APPROVAL_CANCELLED_ERROR, subagentPermissionTitle } from '../src/adapters/kiro/kiroSubagents';

const OPTIONS = [
    { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
    { optionId: 'allow_all_session', name: 'Allow all for this session', kind: 'allow_always' },
];

function harness({ promptActive = true } = {}) {
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v2');
    const parent: Array<Record<string, any>> = [];
    const writes: Array<Record<string, any>> = [];
    const internals = client as any;
    internals.sessionQueues.set('P', { push: (item: any) => parent.push(item.update) });
    if (promptActive) internals.activePrompts.add('P');
    internals.proc = { stdin: { destroyed: false, write: (line: string) => writes.push(JSON.parse(line)) } };
    const dispatch = (msg: Record<string, unknown>) => internals.dispatch(msg);
    // The crew tool call makes P the roster's owner; the roster maps the children.
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'P', update: {
        sessionUpdate: 'tool_call', toolCallId: 'crew', title: 'Spawning agent crew' } } });
    dispatch({ jsonrpc: '2.0', method: '_kiro.dev/subagent/list_update', params: { subagents: [
        { sessionId: 'C1', sessionName: 'kiro_research', agentName: 'kiro_default', status: { type: 'working', message: 'Running' } },
        { sessionId: 'C2', sessionName: 'codex_research', agentName: 'kiro_default', status: { type: 'working', message: 'Running' } },
    ], pendingStages: [] } });
    const ask = (rpcId: string, sessionId: string, command: string) => dispatch({
        jsonrpc: '2.0', id: rpcId, method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: `t-${rpcId}`, title: `Running: ${command}`, rawInput: { command } }, options: OPTIONS },
    });
    const approvals = () => parent.filter((update) => update.sessionUpdate === 'permission_request');
    return { client, parent, writes, ask, approvals, dispatch };
}

test('a V2 subagent approval waits in its parent turn, labelled with the subagent, instead of being cancelled', () => {
    const { client, writes, ask, approvals } = harness();
    ask('uuid-1', 'C1', 'wc -l *.ts');
    assert.deepEqual(writes, [], 'nothing answered for the user');
    const [shown] = approvals();
    assert.equal(shown.subagentSessionId, 'C1');
    assert.equal(shown.subagentName, 'kiro_research');
    assert.equal(shown.toolCall.title, 'Running: wc -l *.ts');
    assert.deepEqual(shown.options.map((option: any) => option.optionId), OPTIONS.map((option) => option.optionId));

    client.respondToPermission(shown.requestId, 'allow_once');
    assert.deepEqual(writes, [{ jsonrpc: '2.0', id: 'uuid-1', result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }]);
});

test('concurrent subagent approvals are shown one at a time, oldest first', () => {
    const { client, writes, ask, approvals } = harness();
    ask('uuid-1', 'C1', 'ls');
    ask('uuid-2', 'C2', 'cat a.ts');
    assert.deepEqual(approvals().map((update) => update.subagentSessionId), ['C1'], 'the second is held');

    client.respondToPermission(approvals()[0].requestId, 'reject_once');
    assert.deepEqual(approvals().map((update) => update.subagentSessionId), ['C1', 'C2'], 'the second is shown after the first is answered');
    client.respondToPermission(approvals()[1].requestId, 'allow_once');
    assert.deepEqual(writes.map((write) => [write.id, write.result.outcome.optionId]), [['uuid-1', 'reject_once'], ['uuid-2', 'allow_once']]);
});

test('a subagent approval waits while the parent itself waits for one', () => {
    const { client, ask, approvals } = harness();
    ask('parent-1', 'P', 'npm test');
    ask('uuid-1', 'C1', 'ls');
    assert.deepEqual(approvals().map((update) => update.subagentSessionId), [undefined]);
    client.cancelPermission(approvals()[0].requestId);
    assert.deepEqual(approvals().map((update) => update.subagentSessionId), [undefined, 'C1']);
});

test('without a running parent turn, or for an unknown session, the approval is cancelled as before', () => {
    const idle = harness({ promptActive: false });
    idle.ask('uuid-1', 'C1', 'ls');
    assert.deepEqual(idle.approvals(), []);
    assert.deepEqual(idle.writes, [{ jsonrpc: '2.0', id: 'uuid-1', result: { outcome: { outcome: 'cancelled' } } }]);

    const unknown = harness();
    unknown.ask('uuid-9', 'stranger', 'ls');
    assert.deepEqual(unknown.approvals(), []);
    assert.deepEqual(unknown.writes, [{ jsonrpc: '2.0', id: 'uuid-9', result: { outcome: { outcome: 'cancelled' } } }]);
});

test("cancelling the parent's approvals cancels its subagents' shown and held ones", () => {
    const { client, writes, ask, approvals } = harness();
    ask('uuid-1', 'C1', 'ls');
    ask('uuid-2', 'C2', 'cat a.ts');
    client.cancelPermissionsForSession('P');
    assert.deepEqual(writes.map((write) => write.id).sort(), ['uuid-1', 'uuid-2']);
    assert.ok(writes.every((write) => write.result.outcome.outcome === 'cancelled'));
    assert.equal(approvals().length, 1, 'the held one is never shown');
});

test('approval titles name the subagent asking', () => {
    assert.equal(subagentPermissionTitle({}, 'Approve shell?'), 'Approve shell?');
    assert.equal(subagentPermissionTitle({ subagentSessionId: 'C1', subagentName: 'kiro_research' }, 'Running: ls'), 'Running: ls (subagent kiro_research)');
    assert.equal(subagentPermissionTitle({ subagentSessionId: 'C1' }, 'Running: ls'), 'Running: ls (subagent)');
});

test("a cancelled subagent approval records the stage as stopped, and why, in the parent's running turn", () => {
    const { client, parent, ask, approvals } = harness();
    ask('uuid-1', 'C1', 'ls');
    client.cancelPermission(approvals()[0].requestId);
    const patch = parent.at(-1)!;
    assert.equal(patch.sessionUpdate, 'subagent_list_update');
    assert.equal(patch.michi, true);
    assert.deepEqual(patch.subagents, [{ sessionId: 'C1', status: 'terminated', outcome: 'cancelled', error: SUBAGENT_APPROVAL_CANCELLED_ERROR, source: 'kiro' }]);

    // An answered approval, or one of the parent itself, records nothing.
    ask('uuid-2', 'C2', 'cat a.ts');
    client.respondToPermission(approvals().at(-1)!.requestId, 'reject_once');
    ask('parent-1', 'P', 'npm test');
    client.cancelPermission(approvals().at(-1)!.requestId);
    assert.equal(parent.filter((update) => update.sessionUpdate === 'subagent_list_update' && update.michi).length, 1);
});

test('an idle parent gets no roster patch for a cancelled subagent approval', () => {
    const { parent, ask } = harness({ promptActive: false });
    const before = parent.length;
    ask('uuid-1', 'C1', 'ls');
    assert.equal(parent.length, before, 'nothing joins the next prompt');
});

test('V2 roster statuses: awaitingInstruction is idle, not running, and says so', () => {
    assert.equal(kiroV2RosterEntry({ sessionId: 's', status: { type: 'working', message: 'Running' } }).status, 'working');
    const idle = kiroV2RosterEntry({ sessionId: 's', status: { type: 'awaitingInstruction' } });
    assert.equal(idle.status, 'terminated');
    assert.equal(idle.outcome, undefined);
    assert.equal(idle.statusMessage, 'Waiting for instructions');
    assert.equal(kiroV2RosterEntry({ sessionId: 's', status: { type: 'awaitingInstruction', message: 'Idle' } }).statusMessage, 'Idle');
    assert.equal(kiroV2RosterEntry({ sessionId: 's', status: { type: 'terminated' } }).statusMessage, undefined);
});

test("when the parent's prompt settles, its subagents' shown and held approvals are answered, not left waiting", () => {
    const { client, writes, ask } = harness();
    ask('uuid-1', 'C1', 'ls');
    ask('uuid-2', 'C2', 'cat a.ts');
    (client as any).settlePrompt('P');
    assert.deepEqual(writes.map((write) => [write.id, write.result.outcome.outcome]).sort(), [['uuid-1', 'cancelled'], ['uuid-2', 'cancelled']]);
    assert.equal((client as any).forwardedPermissions.size, 0);
    assert.equal((client as any).heldPermissions.size, 0);
});
