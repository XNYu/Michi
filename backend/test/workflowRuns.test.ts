/**
 * Workflow runs, replayed from real (sanitized) wires recorded by
 * benchmarks/workflow-observability/2026-10-16: a Claude Code `Workflow`
 * with one phase and two agents, and a Kiro CLI workflow with a parallel
 * node and a combine step.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  BACKGROUND_SUBAGENT_LIMITS,
  boundWorkflowRun,
  isBackgroundSubagentPending,
  parseBackgroundSubagentsEnded,
  parseBackgroundSubagentsUpdate,
  parseWorkflowRunDto,
  parseWorkflowRunSseEnvelope,
  SUBAGENT_END_LIMITS,
  SUBAGENT_UNTRACKED_ERROR,
  untrackedSubagent,
  WORKFLOW_LIMITS,
  type SubagentInfo,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { BackgroundSubagentRegistry } from '../src/services/backgroundSubagentRegistry';
import { WorkflowRunHub, workflowRunId, type WorkflowRunContext } from '../src/services/workflowRunHub';
import type { WorkflowRunStore } from '../src/services/workflowRunsRepository';
import { createClaudeWorkflowTap, readClaudeWorkflowOutput } from 'michi-runtime/internal/core/workflows/claudeWorkflowTap';
import { claudeControlResponse } from 'michi-runtime/internal/core/workflows/claudeWorkflowFold';
import { createKiroWorkflowBridge } from 'michi-runtime/internal/core/workflows/kiroWorkflowBridge';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { setupWorkflowRunRoutes, snapshotRuns } from '../src/routes/workflowRuns';
import { michiTestHost } from './helpers/michiTestHost';
import { workflowSink } from './helpers/hostSinks';
import { chatOwner, hostOwner, runOwner } from './helpers/owners';

const FIXTURES = path.join(__dirname, 'fixtures', 'workflows');
const CONTEXT: WorkflowRunContext = { ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' };
/** The same chat as the adapters name it to the workflow port. */
const PORT_CONTEXT = { ownerUserId: 'owner-a', workspaceId: 'ws-a', owner: chatOwner('node-1') };

function memoryStore(seed: Array<{ ownerUserId: string; run: WorkflowRunDtoV1 }> = []): WorkflowRunStore & { rows: Map<string, { ownerUserId: string; run: WorkflowRunDtoV1 }> } {
  const rows = new Map(seed.map((row) => [row.run.id, row]));
  return {
    rows,
    upsert(ownerUserId, run) { rows.set(run.id, { ownerUserId, run }); },
    get(ownerUserId, id) { const row = rows.get(id); return row && row.ownerUserId === ownerUserId ? row.run : null; },
    list(ownerUserId, workspaceId) { return [...rows.values()].filter((row) => row.ownerUserId === ownerUserId && row.run.workspaceId === workspaceId).map((row) => row.run); },
    listOpen() {
      return [...rows.values()].filter((row) => row.run.status === 'running' || row.run.status === 'paused'
        || row.run.actions.length > 0 || (row.run.approvals?.length ?? 0) > 0);
    },
    workspaceOwnedBy(ownerUserId, workspaceId) { return ownerUserId === 'owner-a' && workspaceId === 'ws-a'; },
    workspaceOfNode() { return 'ws-a'; },
  };
}

function lines(name: string): Array<Record<string, any>> {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('Claude Code workflows', () => {
  it('folds task frames into one run with phases, agents, usage and the final report', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const stops: string[] = [];
    let outputRead: (() => void) | undefined;
    const outputDone = new Promise<void>((resolve) => { outputRead = resolve; });
    const tap = createClaudeWorkflowTap({
      hub: workflowSink(hub),
      context: () => PORT_CONTEXT,
      stopTask: async (taskId) => { stops.push(taskId); },
      readOutput: async (file) => {
        assert.match(file, /\.output$/);
        setImmediate(() => outputRead?.());
        return { summary: 'done', result: 'ALPHA_MARKER=CLAUDE_WF_A_20261016\nBETA_MARKER=CLAUDE_WF_B_20261016', logs: ['phase read finished'] };
      },
    });
    const revisions: number[] = [];
    hub.subscribe((_owner, run) => revisions.push(run.revision));

    let sawStop = false;
    for (const envelope of lines('claude-workflow-wire.jsonl')) {
      tap.observe(envelope);
      const [running] = hub.list('owner-a', 'ws-a');
      if (running?.status === 'running' && running.actions.includes('stop')) sawStop = true;
    }
    await outputDone;
    const [run] = hub.list('owner-a', 'ws-a');
    assert.ok(sawStop, 'a running Claude workflow can be stopped');
    assert.equal(run.runtime, 'claude');
    assert.equal(run.name, 'read-probe');
    assert.equal(run.parentToolCallId, 'toolu_bdrk_015FY3JkLdcGysJ6nVwDxXfH');
    assert.match(run.definition ?? '', /phase\('read'\)/);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.actions, []);
    assert.deepEqual(run.nodes.map((node) => [node.id, node.kind, node.title, node.status]), [
      ['phase:1', 'phase', 'read', 'completed'],
      ['agent:1', 'agent', 'alpha', 'completed'],
      ['agent:2', 'agent', 'beta', 'completed'],
    ]);
    const alpha = run.nodes[1];
    assert.equal(alpha.parentId, 'phase:1');
    assert.match(alpha.prompt ?? '', /Use only the Read tool/);
    assert.equal(alpha.model, 'claude-sonnet-5-5');
    assert.ok((run.usage?.totalTokens ?? 0) > 0);
    assert.match(run.result ?? '', /ALPHA_MARKER=CLAUDE_WF_A_20261016/);
    assert.equal(run.log.at(-1)?.text, 'phase read finished');
    assert.ok(revisions.every((value, index) => index === 0 || value > revisions[index - 1]), 'revisions only increase');

    await hub.act('owner-a', run.id, 'stop').then(() => assert.fail('a finished run cannot be stopped'), (error) => assert.match(String(error), /Cannot stop/));
    assert.deepEqual(stops, []);
  });

  it('stops a running workflow through the control channel (real stop_task round-trip)', async () => {
    const frames = lines('claude-stop-wire.jsonl');
    const hub = new WorkflowRunHub(memoryStore());
    const stops: string[] = [];
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async (taskId) => { stops.push(taskId); } });
    const reply = frames.find((frame) => frame.type === 'control_response')!;
    assert.deepEqual(claudeControlResponse(reply), { requestId: 'michi-probe-1', ok: true });
    assert.deepEqual(claudeControlResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'x', error: 'no such task' } }), { requestId: 'x', ok: false, error: 'no such task' });
    let stoppedOnce = false;
    for (const frame of frames) {
      if (frame.type === 'control_response') continue;
      tap.observe(frame);
      const [run] = hub.list('owner-a', 'ws-a');
      if (!stoppedOnce && run?.nodes.some((node) => node.kind === 'agent')) {
        stoppedOnce = true;
        await hub.act('owner-a', run.id, 'stop');
      }
    }
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(stops.length, 1);
    assert.equal(run.status, 'cancelled', 'killed → stopped');
    assert.ok(run.nodes.every((node) => node.status !== 'running'));
    assert.deepEqual(run.actions, []);
  });

  it('says why a chat action stopped the workflow, but not for the user\'s own stop', async () => {
    const frames = lines('claude-stop-wire.jsonl').filter((frame) => frame.type !== 'control_response');
    const killed = frames.findIndex((frame) => frame.subtype === 'task_updated');
    const replay = (tap: ReturnType<typeof createClaudeWorkflowTap>, beforeKill: () => Promise<void> | void) => async () => {
      for (const [index, frame] of frames.entries()) {
        if (index === killed) await beforeKill();
        tap.observe(frame);
      }
    };

    const chatHub = new WorkflowRunHub(memoryStore());
    const chatTap = createClaudeWorkflowTap({ hub: workflowSink(chatHub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    await replay(chatTap, () => {
      assert.equal(chatTap.hasOpenRuns(), true);
      chatTap.expectStop('Stopped with the chat reply');
    })();
    const [chatRun] = chatHub.list('owner-a', 'ws-a');
    assert.equal(chatRun.status, 'cancelled');
    assert.equal(chatRun.statusDetail, 'Stopped with the chat reply');
    assert.equal(chatTap.hasOpenRuns(), false);

    const userHub = new WorkflowRunHub(memoryStore());
    const userTap = createClaudeWorkflowTap({ hub: workflowSink(userHub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    await replay(userTap, async () => {
      // A chat action announced a stop that did not happen; the user then
      // stopped the run from its card.
      userTap.expectStop('Stopped with the chat reply');
      const [open] = userHub.list('owner-a', 'ws-a');
      await userHub.act('owner-a', open.id, 'stop');
    })();
    const [userRun] = userHub.list('owner-a', 'ws-a');
    assert.equal(userRun.status, 'cancelled');
    assert.notEqual(userRun.statusDetail, 'Stopped with the chat reply');
  });

  it('stops counting a run as background work once it reaches a terminal status', () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    const frames = lines('claude-stop-wire.jsonl').filter((frame) => frame.type !== 'control_response' && frame.subtype !== 'task_notification');
    for (const frame of frames) tap.observe(frame);
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'cancelled');
    assert.equal(tap.hasOpenRuns(), false, 'a killed run waiting for its notification is not background work');
    assert.equal(tap.requestApproval({ title: 'Allow Bash?', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] }, 1_000), null,
      'a finished run cannot carry an approval');
  });

  it('ignores ordinary subagent tasks and releases open runs when the process exits', () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    tap.observe({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 't', task_type: 'local_agent' });
    assert.equal(hub.list('owner-a', 'ws-a').length, 0);
    tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 't2', task_type: 'local_workflow', workflow_name: 'w' });
    tap.release('The Claude session ended before this workflow finished');
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'cancelled');
    assert.match(run.statusDetail ?? '', /session ended/);
    assert.deepEqual(run.actions, []);
  });
});

describe('Kiro CLI workflows', () => {
  it('routes workflow traffic out of band and folds it into the node tree', async () => {
    const [head, ...frames] = lines('kiro-workflow-wire.jsonl');
    const hub = new WorkflowRunHub(memoryStore());
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3');
    const parentUpdates: unknown[] = [];
    (client as any).sessionQueues.set(head.parentSessionId, { push: (item: unknown) => parentUpdates.push(item) });
    const controls: string[] = [];
    const bridge = createKiroWorkflowBridge({
      hub: workflowSink(hub),
      resolve: (sid) => sid === head.parentSessionId ? PORT_CONTEXT : null,
      control: async (method, workflowId) => { controls.push(`${method}:${workflowId}`); },
    });
    client.setWorkflowRouter({
      onEvent: (method, params) => bridge.handle(method, params),
      isStepSession: (sid) => bridge.isStepSession(sid),
      requestPermission: (request) => bridge.requestPermission(request),
    });
    let midRun: WorkflowRunDtoV1 | undefined;
    for (const frame of frames) {
      (client as any).dispatch(frame);
      const [run] = hub.list('owner-a', 'ws-a');
      if (!midRun && run?.nodes.some((node) => node.currentTool)) midRun = run;
    }
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.runtime, 'kiro');
    assert.equal(run.nativeId, 'wf_9defadbd8f7c427d');
    assert.equal(run.name, 'readonly-observability-probe');
    assert.match(run.parentToolCallId ?? '', /^toolu_/, 'linked to the parent Run Workflow chip');
    assert.match(run.definition ?? '', /alpha_path/);
    assert.equal(run.status, 'completed');
    assert.deepEqual(run.nodes.map((node) => [node.id, node.kind, node.parentId ?? null, node.status]), [
      ['read-both', 'parallel', null, 'completed'],
      ['read-alpha', 'step', 'read-both', 'completed'],
      ['read-beta', 'step', 'read-both', 'completed'],
      ['combine', 'step', null, 'completed'],
    ]);
    assert.match(run.nodes[1].result ?? '', /ALPHA_MARKER=KIRO_WF_A_20261016/);
    assert.ok((run.nodes[1].toolCount ?? 0) >= 1);
    assert.equal(run.nodes.some((node) => node.currentTool), false);
    assert.ok(midRun, 'step tool calls show as the node\'s current tool while it runs');
    assert.match(run.result ?? '', /ALPHA_MARKER: KIRO_WF_A_20261016 \| BETA_MARKER: KIRO_WF_B_20261016/);
    assert.ok(run.log.some((entry) => entry.nodeId === 'read-beta' && /BETA_MARKER/.test(entry.text)));
    // Workflow notifications and step sessions never reach the parent's turn queue.
    const leaked = parentUpdates.filter((item: any) => JSON.stringify(item).includes('_kiro/workflow') || item?.update?.update?._meta?.kiro?.workflow);
    assert.deepEqual(leaked, []);
    assert.deepEqual(run.actions, []);
    assert.deepEqual(controls, []);
  });

  it('follows a real pause → resume → cancel → retry → cancel round-trip', () => {
    const [head, ...frames] = lines('kiro-controls-wire.jsonl');
    const hub = new WorkflowRunHub(memoryStore());
    const bridge = createKiroWorkflowBridge({ hub: workflowSink(hub), resolve: (sid) => sid === head.parentSessionId ? PORT_CONTEXT : null, control: async () => {} });
    const statuses: string[] = [];
    hub.subscribe((_owner, run) => { if (statuses.at(-1) !== run.status) statuses.push(run.status); });
    for (const frame of frames) {
      if (frame.method === 'session/update') bridge.handle('michi/workflow_launched', { sessionId: frame.params.sessionId, workflowId: frame.params.update.rawOutput.workflowId, toolCallId: frame.params.update.toolCallId });
      else bridge.handle(frame.method, frame.params);
    }
    // pause ends the run loop with run_complete{paused}; resume and retry
    // re-send run_start; cancel ends with `aborted`.
    assert.deepEqual(statuses, ['running', 'paused', 'running', 'cancelled', 'running', 'cancelled']);
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.nodes.find((node) => node.id === 'create-workflow')?.status, 'cancelled');
    assert.deepEqual(run.actions, ['retry']);
  });

  it('exposes pause/stop while running and resume while paused, through the runtime', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const controls: string[] = [];
    const bridge = createKiroWorkflowBridge({ hub: workflowSink(hub), resolve: () => PORT_CONTEXT, control: async (method) => { controls.push(method); } });
    bridge.handle('_kiro/workflow/run_start', { workflowId: 'wf_1', workflowName: 'demo', nodeTree: [{ nodeId: 'a', type: 'step' }], parentSessionId: 'p' });
    let [run] = hub.list('owner-a', 'ws-a');
    assert.deepEqual(run.actions, ['pause', 'stop']);
    await hub.act('owner-a', run.id, 'pause');
    bridge.handle('_kiro/workflow/paused', { workflowId: 'wf_1', pauseReason: 'Waiting for approval', parentSessionId: 'p' });
    [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'paused');
    assert.equal(run.statusDetail, 'Waiting for approval');
    assert.deepEqual(run.actions, ['resume', 'stop']);
    await hub.act('owner-a', run.id, 'stop');
    assert.deepEqual(controls, ['pause', 'cancel']);
    await assert.rejects(hub.act('owner-b', run.id, 'stop'), /not_found/);
  });
});

describe('workflow approvals', () => {
  it('Kiro: a step session\'s permission request waits on the run and the answer goes back to Kiro', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3');
    const written: any[] = [];
    (client as any).proc = { stdin: { destroyed: false, write: (line: string) => { written.push(JSON.parse(line)); return true; } } };
    (client as any).sessionQueues.set('parent', { push: () => {} });
    const controls: unknown[] = [];
    const bridge = createKiroWorkflowBridge({
      hub: workflowSink(hub),
      resolve: (sid) => sid === 'parent' ? PORT_CONTEXT : null,
      control: async (...args) => { controls.push(args); },
      supports: (method) => method !== 'retry',
      answerPermission: (requestId, optionId) => { if (optionId) client.respondToPermission(requestId, optionId); else client.cancelPermission(requestId); },
    });
    client.setWorkflowRouter({
      onEvent: (method, params) => bridge.handle(method, params),
      isStepSession: (sid) => bridge.isStepSession(sid),
      requestPermission: (request) => bridge.requestPermission(request),
    });
    const dispatch = (msg: Record<string, unknown>) => (client as any).dispatch(msg);
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/run_start', params: { workflowId: 'wf_1', workflowName: 'edit', nodeTree: [{ nodeId: 'write', type: 'step' }], parentSessionId: 'parent' } });
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/node_start', params: { workflowId: 'wf_1', nodeId: 'write', type: 'step', sessionId: 'step-1', parentSessionId: 'parent' } });
    // Untagged step-session frames keep no per-session state in the client.
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'step-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
    assert.equal((client as any).snapshots.state('step-1').commands, undefined);
    dispatch({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
      sessionId: 'step-1',
      toolCall: { title: 'Write File', rawInput: { path: 'out.txt' } },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }],
    } });
    let [run] = hub.list('owner-a', 'ws-a');
    assert.equal(written.length, 0, 'the request is not auto-cancelled');
    assert.equal(run.approvals?.length, 1);
    assert.equal(run.approvals?.[0].nodeId, 'write');
    assert.match(run.approvals?.[0].detail ?? '', /out\.txt/);
    assert.deepEqual(run.actions, ['pause', 'stop'], 'only controls this Kiro build supports');
    await hub.answerApproval('owner-a', run.id, run.approvals![0].id, 'allow_once');
    assert.deepEqual(written, [{ jsonrpc: '2.0', id: 77, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }]);
    [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.approvals, undefined);
    // A second request lapses (cancelled) when the run ends.
    dispatch({ jsonrpc: '2.0', id: 78, method: 'session/request_permission', params: { sessionId: 'step-1', toolCall: { title: 'Bash' }, options: [{ optionId: 'allow_once', name: 'Allow' }] } });
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/run_complete', params: { workflowId: 'wf_1', status: 'aborted', parentSessionId: 'parent' } });
    assert.deepEqual(written.at(-1), { jsonrpc: '2.0', id: 78, result: { outcome: { outcome: 'cancelled' } } });
    [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'cancelled', "Kiro's aborted is a stopped run, not a completed one");
    // A permission request from a session nobody knows is still declined.
    dispatch({ jsonrpc: '2.0', id: 79, method: 'session/request_permission', params: { sessionId: 'stranger', options: [{ optionId: 'allow_once' }] } });
    assert.deepEqual(written.at(-1), { jsonrpc: '2.0', id: 79, result: { outcome: { outcome: 'cancelled' } } });
  });

  it('Kiro: a step request the launching chat already approves is answered at once and never shown', () => {
    const hub = new WorkflowRunHub(memoryStore());
    const answers: Array<[number, string | null]> = [];
    const asked: Array<[string, unknown, unknown]> = [];
    let verdict: boolean | 'throw' = true;
    const bridge = createKiroWorkflowBridge({
      hub: workflowSink(hub),
      resolve: (sid) => sid === 'parent' ? PORT_CONTEXT : null,
      control: async () => {},
      answerPermission: (requestId, optionId) => { answers.push([requestId, optionId]); },
      approves: (parentSessionId, request) => {
        asked.push([parentSessionId, request.toolCall?.title, request.meta?.toolName]);
        if (verdict === 'throw') throw new Error('policy unavailable');
        return verdict;
      },
    });
    bridge.handle('_kiro/workflow/run_start', { workflowId: 'wf_1', workflowName: 'edit', nodeTree: [{ nodeId: 'write', type: 'step' }], parentSessionId: 'parent' });
    bridge.handle('_kiro/workflow/node_start', { workflowId: 'wf_1', nodeId: 'write', type: 'step', sessionId: 'step-1', parentSessionId: 'parent' });
    const options = [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ];
    const request = (requestId: number) => bridge.requestPermission({
      sessionId: 'step-1', requestId, toolCall: { title: 'Write File' }, meta: { toolName: 'write' }, options,
    });

    assert.equal(request(1), true);
    assert.deepEqual(answers, [[1, 'once']], "allow_once, never Kiro's own always-allow");
    assert.deepEqual(asked, [['parent', 'Write File', 'write']], 'asked about the launching chat, with the tool name Kiro sent');
    assert.equal(hub.list('owner-a', 'ws-a')[0].approvals, undefined, 'nothing shown');

    verdict = false;
    assert.equal(request(2), true);
    assert.equal(answers.length, 1, 'a request the chat would ask about waits for the person');
    assert.equal(hub.list('owner-a', 'ws-a')[0].approvals?.length, 1);

    verdict = 'throw';
    assert.equal(request(3), true);
    assert.equal(answers.length, 1, 'a policy that cannot be read asks');
    assert.equal(hub.list('owner-a', 'ws-a')[0].approvals?.length, 2);

    verdict = true;
    assert.equal(bridge.requestPermission({ sessionId: 'step-1', requestId: 4, toolCall: { title: 'Bash' },
      options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] }), true);
    assert.equal(answers.length, 1, 'without a single-use option nothing is approved on its behalf');
    assert.equal(hub.list('owner-a', 'ws-a')[0].approvals?.length, 3);
  });

  it('Kiro: the request _meta reaches the workflow router', () => {
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3');
    (client as any).proc = { stdin: { destroyed: false, write: () => true } };
    const seen: unknown[] = [];
    client.setWorkflowRouter({
      onEvent: () => {},
      isStepSession: (sid) => sid === 'step-1',
      requestPermission: (request) => { seen.push(request.meta); return true; },
    });
    (client as any).dispatch({ jsonrpc: '2.0', id: 5, method: 'session/request_permission', params: {
      sessionId: 'step-1', toolCall: { title: 'Write File' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }], _meta: { toolName: 'write' },
    } });
    assert.deepEqual(seen, [{ toolName: 'write' }]);
  });

  it('Claude: an approval asked while the chat is idle goes to the open workflow and times out cleanly', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    assert.equal(tap.requestApproval({ title: 'Approve Bash?', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 1_000), null, 'no workflow, no routing');
    tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 't', task_type: 'local_workflow', workflow_name: 'w' });
    const answer = tap.requestApproval({ title: 'Approve Bash?', detail: 'Command: npm test', options: [{ optionId: 'allow_once', name: 'Allow' }, { optionId: 'reject_once', name: 'Deny' }] }, 1_000)!;
    let [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.approvals?.[0].title, 'Approve Bash?');
    assert.equal(run.approvals?.[0].scope, 'session', 'Claude does not say who asked');
    await hub.answerApproval('owner-a', run.id, run.approvals![0].id, 'reject_once');
    assert.deepEqual(await answer, { kind: 'answered', optionId: 'reject_once' });
    const lapsing = tap.requestApproval({ title: 'Approve Edit?', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 20)!;
    assert.deepEqual(await lapsing, { kind: 'lapsed' });
    [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.approvals, undefined, 'a timed-out approval is withdrawn');
    await assert.rejects(hub.answerApproval('owner-a', run.id, 'nope', 'allow_once'), /no longer pending/);
  });

  it('Claude: a session approval survives the end of one workflow and is answered once on all', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    const start = (taskId: string, name: string) => tap.observe({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `t-${taskId}`, task_type: 'local_workflow', workflow_name: name });
    const byName = (name: string) => hub.list('owner-a', 'ws-a').find((run) => run.name === name)!;
    start('wf-A', 'A');
    start('wf-B', 'B');
    const answer = tap.requestApproval({ title: 'Approve Bash?', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 60_000)!;
    assert.equal(byName('A').approvals?.length, 1, 'shown on every running workflow');
    assert.equal(byName('B').approvals?.length, 1);
    // B finishes first: the request stays on A instead of being denied.
    tap.observe({ type: 'system', subtype: 'task_updated', task_id: 'wf-B', patch: { status: 'completed' } });
    assert.equal(byName('B').approvals, undefined);
    assert.equal(byName('A').approvals?.length, 1);
    // A workflow that starts while it waits shows it too.
    start('wf-C', 'C');
    assert.equal(byName('C').approvals?.length, 1);
    await hub.answerApproval('owner-a', byName('C').id, byName('C').approvals![0].id, 'allow_once');
    assert.deepEqual(await answer, { kind: 'answered', optionId: 'allow_once' });
    assert.equal(byName('A').approvals, undefined, 'answered on one, gone from all');
    assert.equal(byName('C').approvals, undefined);
  });

  it('Claude: a session approval goes to the chat when its workflows complete, is denied when one was stopped, and lapses on exit', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    const ask = () => tap.requestApproval({ title: 'Approve Bash?', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 60_000)!;
    const start = (taskId: string) => tap.observe({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `t-${taskId}`, task_type: 'local_workflow', workflow_name: taskId });
    const end = (taskId: string, status: string) => tap.observe({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } });

    start('wf-A');
    const unhosted = ask();
    end('wf-A', 'completed');
    assert.deepEqual(await unhosted, { kind: 'unhosted' }, 'no workflow agent was waiting: the asker is other work, ask in the chat');

    start('wf-B');
    const stopped = ask();
    end('wf-B', 'killed');
    assert.deepEqual(await stopped, { kind: 'lapsed' }, 'the asker most likely died with the stopped run');

    // Stopped first, then the remaining host completes: still denied.
    start('wf-C');
    start('wf-D');
    const mixed = ask();
    end('wf-C', 'failed');
    end('wf-D', 'completed');
    assert.deepEqual(await mixed, { kind: 'lapsed' });

    start('wf-E');
    const lapsed = ask();
    tap.release('The Claude session ended before this workflow finished');
    assert.deepEqual(await lapsed, { kind: 'lapsed' }, 'the CLI that asked is gone');
  });

  it('Claude: stopping a workflow that started after the request does not deny it', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    const start = (taskId: string) => tap.observe({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `t-${taskId}`, task_type: 'local_workflow', workflow_name: taskId });
    const end = (taskId: string, status: string) => tap.observe({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } });
    start('wf-A');
    const answer = tap.requestApproval({ title: 'Approve Bash?', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 60_000)!;
    start('wf-B');
    end('wf-B', 'killed');
    end('wf-A', 'completed');
    assert.deepEqual(await answer, { kind: 'unhosted' }, 'no agent of B can have asked; the asker is other live work');
  });

  it('Claude: an "always allow" answered elsewhere answers the session approvals it covers', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const tap = createClaudeWorkflowTap({ hub: workflowSink(hub), context: () => PORT_CONTEXT, stopTask: async () => {} });
    tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-A', tool_use_id: 't', task_type: 'local_workflow', workflow_name: 'A' });
    const bash = tap.requestApproval({ title: 'Approve Bash?', toolName: 'Bash', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 60_000)!;
    const edit = tap.requestApproval({ title: 'Approve Edit?', toolName: 'Edit', options: [{ optionId: 'allow_once', name: 'Allow' }] }, 60_000)!;
    tap.answerCovered((toolName) => toolName === 'Bash', 'allow_once');
    assert.deepEqual(await bash, { kind: 'answered', optionId: 'allow_once' });
    const [run] = hub.list('owner-a', 'ws-a');
    assert.deepEqual(run.approvals?.map((approval) => approval.title), ['Approve Edit?'], 'other tools still wait');
    tap.answerCovered(() => true, 'allow_once');
    assert.deepEqual(await edit, { kind: 'answered', optionId: 'allow_once' });
  });
});

describe('Kiro workflow opt-in on recovery', () => {
  async function recoveringRuntime(anchors: boolean) {
    const { AcpAgentRuntime } = await import('michi-runtime/internal/adapters/kiro/AcpAgentRuntime');
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
    const runtime = new AcpAgentRuntime({ bridge, defaultCwd: os.tmpdir(), host: michiTestHost(), engine: 'v3', isolatedSession: !anchors }) as any;
    runtime.sessionAnchorsEnabled = anchors;
    const loads: Array<{ sessionId: string; workflows?: boolean }> = [];
    const bindings = new Map<string, any>([
      ['sess-run', { publicSessionId: 'attempt-1', nativeSessionId: 'sess-run', owner: runOwner('run-1', 'attempt-1'), cwd: '/tmp/run', workspaceId: 'ws-a', ownerUserId: 'owner-a' }],
      ['sess-chat', { publicSessionId: 'node-1', nativeSessionId: 'sess-chat', owner: chatOwner('node-1'), cwd: '/tmp/chat', workspaceId: 'ws-a', ownerUserId: 'owner-a' }],
    ]);
    runtime.workflowsWanted = () => true;
    runtime.getBindingByNativeSid = (sid: string) => runtime.bindings.get(runtime.publicIdByNativeSid.get(sid)) ?? bindings.get(sid);
    // The respawn purges the bindings of its cwd, as purgeSessionsForCwd does.
    runtime.forceRespawn = async (cwd: string) => {
      for (const [sid, binding] of bindings) if (binding.cwd === cwd) bindings.delete(sid);
      for (const [publicId, binding] of runtime.bindings) {
        if (binding.cwd !== cwd) continue;
        runtime.bindings.delete(publicId);
        runtime.publicIdByNativeSid.delete(binding.nativeSessionId);
      }
    };
    runtime.loadAcpSession = async (opts: { sessionId: string; workflows?: boolean }) => { loads.push(opts); return {}; };
    return { runtime, loads };
  }

  it('re-enables workflows on an anchored chat recovery, again on the next one, never for an Agent Run', async () => {
    const { runtime, loads } = await recoveringRuntime(true);
    assert.equal(await runtime.recoverSession('sess-run', '/tmp/cwd'), true);
    assert.equal(await runtime.recoverSession('sess-chat', '/tmp/cwd'), true);
    const restored = runtime.workflowContext('sess-chat');
    assert.ok(restored, 'the restored binding attributes its workflows');
    assert.deepEqual(hostOwner(restored.owner), { kind: 'chat_node', nodeId: 'node-1' }, 'the restored binding attributes its workflows');
    // A second crash: the binding the first recovery restored is purged
    // again and read before the respawn.
    assert.equal(await runtime.recoverSession('sess-chat', '/tmp/cwd'), true);
    assert.deepEqual(loads.map((load) => [load.sessionId, load.workflows]), [
      ['sess-run', false],
      ['sess-chat', true],
      ['sess-chat', true],
    ]);
  });

  it('keeps workflows off when a recovery cannot restore the binding that attributes them', async () => {
    const { runtime, loads } = await recoveringRuntime(false);
    assert.equal(await runtime.recoverSession('sess-chat', '/tmp/cwd'), true);
    assert.equal(runtime.workflowContext('sess-chat'), null);
    assert.deepEqual(loads.map((load) => [load.sessionId, load.workflows]), [['sess-chat', false]]);
  });
});

describe('Kiro workflow runs through the owner port', () => {
  it('record the chat binding\'s node id and no node for an Agent Run, as the node-id context did', async () => {
    const { AcpAgentRuntime } = await import('michi-runtime/internal/adapters/kiro/AcpAgentRuntime');
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
    const runtime = new AcpAgentRuntime({ bridge, defaultCwd: os.tmpdir(), host: michiTestHost(), engine: 'v3' }) as any;
    const bindings = [['node-1', 'sid-chat', chatOwner('node-1')], ['attempt-1', 'sid-run', runOwner('run-1', 'attempt-1')]] as const;
    for (const [publicId, sid, owner] of bindings) {
      runtime.bindings.set(publicId, { publicSessionId: publicId, nativeSessionId: sid, owner, cwd: os.tmpdir(), workspaceId: 'ws-a', ownerUserId: 'owner-a' });
      runtime.publicIdByNativeSid.set(sid, publicId);
    }
    const hub = new WorkflowRunHub(memoryStore());
    const contexts = new Set<string>();
    const update = hub.update.bind(hub);
    hub.update = (context, ...rest) => { contexts.add(JSON.stringify(context)); return update(context, ...rest); };
    const workflows = createKiroWorkflowBridge({ hub: workflowSink(hub), resolve: (sid) => runtime.workflowContext(sid), control: async () => {} });
    for (const [, sid] of bindings) {
      workflows.handle('_kiro/workflow/run_start', { workflowId: `wf-${sid}`, workflowName: 'demo', nodeTree: [{ nodeId: 'a', type: 'step' }], parentSessionId: sid });
    }
    // The context Michi's hub receives, and so the run's nodeId on the wire and in the store.
    assert.deepEqual([...contexts], [
      JSON.stringify({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' }),
      JSON.stringify({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: null }),
    ]);
    assert.deepEqual(hub.list('owner-a', 'ws-a').map((run) => [run.nativeId, run.nodeId]).sort(), [['wf-sid-chat', 'node-1'], ['wf-sid-run', null]]);
  });
});

describe('Claude workflow output file', () => {
  it('reads only <tasks>/<taskId>.output, not through symlinks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-wf-output-'));
    try {
      const tasks = path.join(dir, 'tasks');
      fs.mkdirSync(tasks);
      const file = path.join(tasks, 'wf-1.output');
      fs.writeFileSync(file, JSON.stringify({ result: 'ok' }));
      assert.deepEqual(await readClaudeWorkflowOutput(file, 'wf-1'), { result: 'ok' });
      assert.equal(await readClaudeWorkflowOutput(file, 'other'), undefined);
      const secret = path.join(dir, 'secret.json');
      fs.writeFileSync(secret, JSON.stringify({ secret: true }));
      fs.symlinkSync(secret, path.join(tasks, 'wf-2.output'));
      assert.equal(await readClaudeWorkflowOutput(path.join(tasks, 'wf-2.output'), 'wf-2'), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WorkflowRunHub persistence', () => {
  it('outranks a live revision a renderer kept across a restart, and stored runs accept no actions', () => {
    let now = 1_000;
    const store = memoryStore();
    const live = new WorkflowRunHub(store, () => now);
    const tap = createClaudeWorkflowTap({ hub: workflowSink(live), context: () => PORT_CONTEXT, stopTask: async () => {} });
    tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-1', tool_use_id: 't', task_type: 'local_workflow', workflow_name: 'w' });
    for (let index = 0; index < 5; index += 1) {
      now += 10;
      tap.observe({ type: 'system', subtype: 'task_progress', task_id: 'wf-1', usage: { total_tokens: index } });
    }
    const [seen] = live.list('owner-a', 'ws-a');
    // Process dies without flushing: the store holds an older revision.
    now += 5_000;
    const restarted = new WorkflowRunHub(store, () => now);
    const [recovered] = restarted.list('owner-a', 'ws-a');
    assert.equal(recovered.status, 'cancelled');
    assert.ok(recovered.revision > seen.revision, `${recovered.revision} > ${seen.revision}`);
    assert.deepEqual(recovered.actions, []);
  });

  it('closes runs a previous process left open', () => {
    const stale: WorkflowRunDtoV1 = {
      version: 1, id: 'wfr_stale', runtime: 'claude', nativeId: 'x', workspaceId: 'ws-a', nodeId: null, parentToolCallId: null,
      name: 'old', status: 'running', nodes: [{ id: 'agent:1', kind: 'agent', title: 'a', status: 'running' }], log: [], actions: ['stop'],
      startedAt: 1, updatedAt: 1, revision: 3,
    };
    const store = memoryStore([{ ownerUserId: 'owner-a', run: stale }]);
    const hub = new WorkflowRunHub(store, () => 50);
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'cancelled');
    assert.match(run.statusDetail ?? '', /Michi restarted/);
    assert.equal(run.nodes[0].status, 'cancelled');
    assert.deepEqual(run.actions, []);
    assert.equal(store.rows.get('wfr_stale')?.run.status, 'cancelled');
  });

  it('rewrites finished runs stored with actions so a kept Retry button goes away', () => {
    const failed: WorkflowRunDtoV1 = {
      version: 1, id: 'wfr_failed', runtime: 'kiro', nativeId: 'wf_1', workspaceId: 'ws-a', nodeId: null, parentToolCallId: null,
      name: 'failed', status: 'failed', statusDetail: 'step write failed', nodes: [], log: [], actions: ['retry'],
      startedAt: 1, updatedAt: 1, revision: 9,
    };
    const store = memoryStore([{ ownerUserId: 'owner-a', run: failed }]);
    const hub = new WorkflowRunHub(store, () => 70);
    const [run] = hub.list('owner-a', 'ws-a');
    assert.equal(run.status, 'failed', 'a finished run keeps its outcome');
    assert.equal(run.statusDetail, 'step write failed');
    assert.deepEqual(run.actions, []);
    assert.ok(run.revision > failed.revision, 'outranks the copy a renderer kept');
    assert.deepEqual(store.rows.get('wfr_failed')?.run.actions, []);
  });

  it('lists an old open run ahead of fifty newer finished ones', () => {
    let now = 1_000;
    const finished = Array.from({ length: 60 }, (_, i): { ownerUserId: string; run: WorkflowRunDtoV1 } => ({
      ownerUserId: 'owner-a',
      run: {
        version: 1, id: `wfr_done_${i}`, runtime: 'kiro', nativeId: `wf_done_${i}`, workspaceId: 'ws-a', nodeId: null, parentToolCallId: null,
        name: `done ${i}`, status: 'completed', nodes: [], log: [], actions: [], startedAt: 10_000 + i, updatedAt: 10_000 + i, revision: 1,
      },
    }));
    const hub = new WorkflowRunHub(memoryStore(finished), () => now);
    // The open run's last change is older than every finished run.
    hub.update(CONTEXT, 'kiro', 'wf_open', (run) => ({ ...run, name: 'waiting' }));
    now = 2_000;
    const listed = hub.list('owner-a', 'ws-a', 50);
    assert.equal(listed.length, 50);
    assert.equal(listed[0].name, 'waiting', 'open runs come first');
    assert.equal(listed[1].name, 'done 59', 'then the newest finished');
  });

  it('lets a stored finished run leave memory again after a late frame', () => {
    const id = workflowRunId('owner-a', 'kiro', 'wf_done');
    const done: WorkflowRunDtoV1 = {
      version: 1, id, runtime: 'kiro', nativeId: 'wf_done', workspaceId: 'ws-a', nodeId: null, parentToolCallId: null,
      name: 'done', status: 'completed', nodes: [], log: [], actions: [], startedAt: 1, updatedAt: 1, revision: 4,
    };
    const hub = new WorkflowRunHub(memoryStore([{ ownerUserId: 'owner-a', run: done }]));
    const unchanged = hub.update(CONTEXT, 'kiro', 'wf_done', (run) => run);
    assert.equal(unchanged?.revision, 4, 'nothing changed, nothing committed');
    const entry = (hub as any).live.get(id);
    assert.ok(entry?.evictTimer, 'the reloaded run is scheduled to leave memory');
    clearTimeout(entry.evictTimer);
  });
});

describe('boundWorkflowRun', () => {
  const big = (patch: Partial<WorkflowRunDtoV1> = {}): WorkflowRunDtoV1 => ({
    version: 1, id: 'wfr_big', runtime: 'kiro', nativeId: 'wf_big', workspaceId: 'ws-a', nodeId: null, parentToolCallId: null,
    name: 'big', status: 'running', log: Array.from({ length: 80 }, (_, i) => ({ at: i, text: 'x'.repeat(400) })), actions: ['stop'],
    nodes: Array.from({ length: 200 }, (_, i) => ({
      id: `node-${i}`, kind: 'step' as const, title: `step ${i}`, status: i === 199 ? 'running' as const : 'completed' as const,
      prompt: 'p'.repeat(4_000), result: 'r'.repeat(8_000), error: 'e'.repeat(2_000), currentTool: 't'.repeat(400),
    })),
    approvals: [{ id: 'a1', title: 'Approve Bash?', detail: 'd'.repeat(4_000), options: [{ optionId: 'allow_once', name: 'Allow' }], requestedAt: 1 }],
    startedAt: 1, updatedAt: 1, revision: 1,
    ...patch,
  });

  it('keeps every node, status and approval while trimming text to fit', () => {
    const run = big();
    const bounded = boundWorkflowRun(run);
    assert.ok(JSON.stringify(bounded).length <= WORKFLOW_LIMITS.snapshotBytes);
    assert.equal(bounded.nodes.length, 200, 'no node is dropped');
    assert.equal(bounded.nodes[199].status, 'running');
    assert.deepEqual(bounded.approvals?.map((approval) => approval.id), ['a1']);
    assert.equal(bounded.approvals?.[0].detail, run.approvals![0].detail, 'what the user is asked to allow is never cut');
    assert.deepEqual(bounded.actions, ['stop']);
    const skeleton = boundWorkflowRun(run, 1_000);
    assert.equal(skeleton.approvals?.[0].detail, run.approvals![0].detail, 'not even in a skeleton');
  });

  it('fits a much smaller budget with node skeletons, and leaves small runs untouched', () => {
    const run = big();
    const bounded = boundWorkflowRun(run, 40_000);
    assert.ok(JSON.stringify(bounded).length <= 40_000, `${JSON.stringify(bounded).length}`);
    assert.equal(bounded.nodes.length, 200);
    assert.equal(bounded.nodes[0].prompt, undefined);
    const small = big({ nodes: [], log: [], approvals: undefined });
    assert.equal(boundWorkflowRun(small), small);
  });

  const bytes = (runs: WorkflowRunDtoV1[]) => runs.reduce((sum, run) => sum + Buffer.byteLength(JSON.stringify(run), 'utf8'), 0);

  it('marks runs the bulk snapshot trimmed as partial and keeps it within its byte budget', () => {
    const runs = [big({ id: 'wfr_1' }), big({ id: 'wfr_2', nodes: [], log: [], approvals: undefined })];
    const trimmed = snapshotRuns(runs, 100_000);
    assert.equal(trimmed[0].partial, true);
    assert.equal(trimmed[1], runs[1], 'a run that fits is sent as is');
    assert.ok(bytes(trimmed) <= 100_000);
    assert.equal(snapshotRuns(runs.slice(1), 100_000)[0], runs[1]);
    assert.equal(parseWorkflowRunDto(trimmed[0])?.partial, true, 'the flag survives the client parser');
  });

  it('counts bytes, not UTF-16 units, and leaves out the oldest runs whose skeletons do not fit', () => {
    // Long CJK titles: 3 bytes per unit, and too large to trim away.
    const cjk = (id: string) => big({
      id, approvals: undefined, log: [],
      nodes: Array.from({ length: 200 }, (_, i) => ({ id: `n-${i}`, kind: 'step' as const, title: '工作流步骤'.repeat(16), status: 'completed' as const, agentName: '代理'.repeat(20) })),
    });
    const runs = Array.from({ length: 50 }, (_, i) => cjk(`wfr_${i}`));
    const sent = snapshotRuns(runs, 2_000_000);
    assert.ok(bytes(sent) <= 2_000_000, `${bytes(sent)} bytes`);
    assert.ok(sent.length > 0 && sent.length < runs.length, `${sent.length} of ${runs.length} runs`);
    assert.deepEqual(sent.map((run) => run.id), runs.slice(0, sent.length).map((run) => run.id), 'the newest are kept');
  });

  it('keeps finished runs as a newest-first prefix even when a smaller older one would fit', () => {
    const cjk = (id: string, nodes: number) => big({
      id, status: 'completed', actions: [], approvals: undefined, log: [],
      nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n-${i}`, kind: 'step' as const, title: '工作流步骤'.repeat(16), status: 'completed' as const })),
    });
    const runs = [cjk('wfr_new', 200), cjk('wfr_huge', 200), cjk('wfr_old', 10)];
    const budget = bytes([boundWorkflowRun(runs[0], 10_000_000)]) + 1_000;
    const sent = snapshotRuns(runs, budget);
    assert.deepEqual(sent.map((run) => run.id), ['wfr_new'], 'a newer run is never dropped while an older one is kept');
  });

  it('keeps an old open run waiting on an approval over newer finished ones', () => {
    const skeletal = (id: string, patch: Partial<WorkflowRunDtoV1> = {}) => big({
      id, status: 'completed', actions: [], approvals: undefined, log: [],
      nodes: Array.from({ length: 200 }, (_, i) => ({ id: `n-${i}`, kind: 'step' as const, title: '工作流步骤'.repeat(16), status: 'completed' as const })),
      ...patch,
    });
    const finished = Array.from({ length: 49 }, (_, i) => skeletal(`wfr_done_${i}`));
    const waiting = skeletal('wfr_waiting', {
      status: 'running', actions: ['stop'],
      approvals: [{ id: 'a1', title: 'Approve write?', options: [{ optionId: 'allow_once', name: 'Allow' }], requestedAt: 1 }],
    });
    const sent = snapshotRuns([...finished, waiting], 2_000_000);
    assert.ok(sent.length < 50);
    assert.ok(sent.some((run) => run.id === 'wfr_waiting'), 'the open run is kept');
    assert.ok(bytes(sent) <= 2_000_000);
  });

  it('counts the partial flag in the budget, so a run that fits whole is not dropped for it', () => {
    const small = big({ id: 'wfr_small', nodes: [], log: [], approvals: undefined });
    const large = big({ id: 'wfr_large' });
    const budget = bytes([small]) + bytes([boundWorkflowRun(large, 200_000, (run) => Buffer.byteLength(JSON.stringify(run), 'utf8'))]);
    const sent = snapshotRuns([large, small], budget);
    assert.ok(sent.some((run) => run.id === 'wfr_small'));
    assert.ok(bytes(sent) <= budget);
  });

  it('gives the share small runs leave unused to a large one', () => {
    const small = Array.from({ length: 9 }, (_, i) => big({ id: `wfr_s${i}`, nodes: [], log: [], approvals: undefined }));
    const large = big({ id: 'wfr_large' });
    const sent = snapshotRuns([large, ...small], 400_000);
    assert.equal(sent.length, 10);
    assert.ok(bytes([sent[0]]) > 400_000 / 10 * 2, 'more than an equal split');
    assert.ok(bytes(sent) <= 400_000);
  });
});

describe('SqliteWorkflowRunStore (real migrations)', () => {
  it('upserts snapshots per owner, keeps the node link and survives a dangling node', async () => {
    const { closeDb, getDb, initDb } = await import('../src/services/db');
    const { SqliteWorkflowRunStore } = await import('../src/services/workflowRunsRepository');
    const previous = process.env.MICHI_DATA_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-workflow-runs-'));
    process.env.MICHI_DATA_DIR = dir;
    try {
      closeDb(); initDb();
      const db = getDb();
      db.prepare("INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES ('ws-a', 'A', NULL, 1, 1)").run();
      db.prepare("INSERT INTO nodes (id, workspace_id, kind, created_at) VALUES ('node-1', 'ws-a', 'chat', 1)").run();
      const store = new SqliteWorkflowRunStore();
      const base: WorkflowRunDtoV1 = {
        version: 1, id: 'wfr_a', runtime: 'kiro', nativeId: 'wf_1', workspaceId: 'ws-a', nodeId: 'node-1', parentToolCallId: 't',
        name: 'demo', status: 'running', nodes: [], log: [], actions: [], startedAt: 1, updatedAt: 1, revision: 1,
      };
      store.upsert('local-user', base);
      store.upsert('local-user', { ...base, status: 'completed', revision: 2, updatedAt: 2 });
      // Another owner cannot overwrite the row through the same id.
      store.upsert('intruder', { ...base, name: 'hijacked', revision: 3, updatedAt: 3 });
      assert.equal(store.get('local-user', 'wfr_a')?.status, 'completed');
      assert.equal(store.get('local-user', 'wfr_a')?.name, 'demo');
      assert.equal(store.get('intruder', 'wfr_a'), null);
      assert.deepEqual(store.list('local-user', 'ws-a', 10).map((run) => run.id), ['wfr_a']);
      assert.equal(store.listOpen().length, 0);
      assert.equal(store.workspaceOwnedBy('local-user', 'ws-a'), true, 'desktop workspaces have a NULL owner');
      assert.equal(store.workspaceOfNode('node-1'), 'ws-a');
      // A run whose chat node no longer exists still persists.
      store.upsert('local-user', { ...base, id: 'wfr_b', nativeId: 'wf_2', nodeId: 'gone' });
      assert.equal(store.get('local-user', 'wfr_b')?.nodeId, 'gone');
      assert.equal((db.prepare("SELECT node_id FROM workflow_runs WHERE id = 'wfr_b'").get() as { node_id: string | null }).node_id, null);
      assert.equal(store.listOpen().length, 1);
      // A finished run stored with actions still needs settling after a restart.
      store.upsert('local-user', { ...base, id: 'wfr_c', nativeId: 'wf_3', status: 'failed', actions: ['retry'] });
      assert.deepEqual(store.listOpen().map((row) => row.run.id).sort(), ['wfr_b', 'wfr_c']);
      // A malformed row (only possible past the CHECK) does not break recovery.
      db.exec('PRAGMA ignore_check_constraints = ON');
      db.prepare(`INSERT INTO workflow_runs (id, owner_user_id, workspace_id, runtime, native_id, status, run_json, started_at, updated_at)
        VALUES ('wfr_bad', 'local-user', 'ws-a', 'kiro', 'wf_bad', 'completed', '{not json', 1, 1)`).run();
      db.exec('PRAGMA ignore_check_constraints = OFF');
      assert.deepEqual(store.listOpen().map((row) => row.run.id).sort(), ['wfr_b', 'wfr_c']);
      // The settings column exists.
      db.prepare("INSERT INTO user_agent_configs (user_id, runtime, provider, updated_at, workflows_by_runtime) VALUES ('u', 'kiro', '', 1, '{\"kiro\":true}')").run();
    } finally {
      closeDb();
      if (previous === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow run routes', () => {
  let server: ReturnType<express.Express['listen']> | undefined;
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });

  async function start(hub: WorkflowRunHub, backgroundSubagents?: BackgroundSubagentRegistry): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { const owner = req.header('x-user'); if (owner) req.user = { id: owner }; next(); });
    app.use('/api', setupWorkflowRunRoutes({ hub, heartbeatMs: 60_000, ...(backgroundSubagents ? { backgroundSubagents } : {}) }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  }

  it('scopes reads to the workspace owner and streams snapshots then live changes', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    hub.update(CONTEXT, 'claude', 'task-1', (run) => ({ ...run, name: 'first' }));
    const base = await start(hub);
    assert.equal((await fetch(`${base}/workflow-runs?workspaceId=ws-a`, { headers: { 'x-user': 'owner-b' } })).status, 404);
    const listed = await (await fetch(`${base}/workflow-runs?workspaceId=ws-a`, { headers: { 'x-user': 'owner-a' } })).json() as { runs: WorkflowRunDtoV1[] };
    assert.deepEqual(listed.runs.map((run) => run.name), ['first']);

    const controller = new AbortController();
    const response = await fetch(`${base}/workflow-runs/subscribe?workspaceId=ws-a`, { headers: { 'x-user': 'owner-a' }, signal: controller.signal });
    const reader = response.body!.getReader();
    const frames: any[] = [];
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('closed'); buffer += new TextDecoder().decode(chunk.value); }
      const [frame, rest] = [buffer.slice(0, buffer.indexOf('\n\n')), buffer.slice(buffer.indexOf('\n\n') + 2)];
      buffer = rest;
      return JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    };
    frames.push(await next());
    hub.update(CONTEXT, 'claude', 'task-1', (run) => ({ ...run, name: 'renamed' }));
    hub.update({ ...CONTEXT, ownerUserId: 'owner-b' }, 'claude', 'task-9', (run) => ({ ...run, name: 'not yours' }));
    frames.push(await next());
    controller.abort();
    assert.deepEqual(frames.map((frame) => [frame.event, frame.run.name]), [['workflow_run', 'first'], ['workflow_run', 'renamed']]);
    assert.ok(frames[1].run.revision > frames[0].run.revision);
  });

  /** An SSE reader over the subscribe route: each frame's event line and parsed data. */
  async function openFeed(base: string, owner: string, workspaceId: string) {
    const controller = new AbortController();
    const response = await fetch(`${base}/workflow-runs/subscribe?workspaceId=${workspaceId}`, { headers: { 'x-user': owner }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let buffer = '';
    const next = async (): Promise<{ event: string; data: any }> => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('closed'); buffer += new TextDecoder().decode(chunk.value); }
      const frame = buffer.slice(0, buffer.indexOf('\n\n'));
      buffer = buffer.slice(buffer.indexOf('\n\n') + 2);
      const lines = frame.split('\n');
      return {
        event: lines.find((line) => line.startsWith('event: '))!.slice(7),
        data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)),
      };
    };
    return { next, close: () => controller.abort() };
  }

  it('sends the caller\'s background subagents first, then their changes only', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    hub.update(CONTEXT, 'claude', 'task-1', (run) => ({ ...run, name: 'first' }));
    const registry = new BackgroundSubagentRegistry({ graceMs: 30, resolveWorkspace: () => null });
    registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:1', ['agent-1']);
    registry.report({ ownerUserId: 'owner-b', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:2', ['not-yours']);
    registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-b', nodeId: 'node-9' }, 'claude:3', ['other-workspace']);
    const base = await start(hub, registry);

    // An unowned workspace is refused before anything is streamed.
    const refused = await fetch(`${base}/workflow-runs/subscribe?workspaceId=ws-a`, { headers: { 'x-user': 'owner-b' } });
    await refused.text();
    assert.equal(refused.status, 404);

    const feed = await openFeed(base, 'owner-a', 'ws-a');
    try {
      const snapshot = await feed.next();
      assert.equal(snapshot.event, 'background_subagents');
      assert.deepEqual(snapshot.data.backgroundSubagents, { snapshot: true, nodes: { 'node-1': ['agent-1'] } });
      assert.equal(snapshot.data.run, null);
      assert.deepEqual(parseWorkflowRunSseEnvelope(snapshot.data)?.backgroundSubagents, snapshot.data.backgroundSubagents,
        'the shared parser reads what the route writes');
      const run = await feed.next();
      assert.deepEqual([run.event, run.data.run.name], ['workflow_run', 'first'], 'run history follows the background snapshot');

      // Other owners and workspaces change: not sent here.
      registry.report({ ownerUserId: 'owner-b', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:2', ['not-yours', 'still-not']);
      registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-b', nodeId: 'node-9' }, 'claude:3', []);
      registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-2' }, 'codex:1', ['agent-2']);
      const added = await feed.next();
      assert.equal(added.event, 'background_subagents');
      assert.deepEqual(added.data.backgroundSubagents, { snapshot: false, nodes: { 'node-2': ['agent-2'] } });

      // A withdrawal arrives as the node's empty list once its grace ran out.
      registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:1', []);
      const removed = await feed.next();
      assert.deepEqual(removed.data.backgroundSubagents, { snapshot: false, nodes: { 'node-1': [] } });

      // Runs still stream alongside.
      hub.update(CONTEXT, 'claude', 'task-1', (current) => ({ ...current, name: 'renamed' }));
      const renamed = await feed.next();
      assert.deepEqual([renamed.event, renamed.data.run.name], ['workflow_run', 'renamed']);
    } finally {
      feed.close();
    }
    // Closing the feed unsubscribes it from the registry.
    for (let i = 0; i < 50 && (registry as any).listeners.size > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((registry as any).listeners.size, 0);
  });

  it('sends an empty background snapshot when the workspace has none', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const registry = new BackgroundSubagentRegistry({ resolveWorkspace: () => null });
    const base = await start(hub, registry);
    const feed = await openFeed(base, 'owner-a', 'ws-a');
    try {
      const first = await feed.next();
      assert.equal(first.event, 'background_subagents');
      assert.deepEqual(first.data.backgroundSubagents, { snapshot: true, nodes: {} });
      // With no runs, the next frame is the next change.
      registry.report({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:1', ['agent-1']);
      assert.deepEqual((await feed.next()).data.backgroundSubagents, { snapshot: false, nodes: { 'node-1': ['agent-1'] } });
    } finally {
      feed.close();
    }
  });

  it('sends the caller\'s ended background subagents, after they are stored', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const stored: string[] = [];
    const registry = new BackgroundSubagentRegistry({
      resolveWorkspace: () => null,
      recordEnds: (ownerUserId, nodeId) => {
        stored.push(`${ownerUserId}|${nodeId}`);
        return { workspaceId: nodeId === 'node-9' ? 'ws-b' : 'ws-a' };
      },
    });
    const base = await start(hub, registry);
    const feed = await openFeed(base, 'owner-a', 'ws-a');
    try {
      assert.equal((await feed.next()).event, 'background_subagents');
      const stopped = { sessionId: 'agent-1', outcome: 'cancelled' as const, endedAt: 7, error: 'gone' };
      // Another owner's and another workspace's ends: not sent here.
      registry.end({ ownerUserId: 'owner-b', workspaceId: 'ws-a', nodeId: 'node-1' }, 'claude:2', [stopped]);
      registry.end({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-9' }, 'claude:3', [stopped]);
      registry.end({ ownerUserId: 'owner-a', workspaceId: null, nodeId: 'node-1' }, 'claude:1', [stopped]);
      const ended = await feed.next();
      assert.equal(ended.event, 'background_subagents_ended');
      assert.equal(ended.data.run, null);
      assert.deepEqual(ended.data.backgroundSubagentsEnded, { nodeId: 'node-1', subagents: [stopped] });
      assert.deepEqual(parseWorkflowRunSseEnvelope(ended.data)?.backgroundSubagentsEnded, ended.data.backgroundSubagentsEnded,
        'the shared parser reads what the route writes');
      assert.deepEqual(stored, ['owner-b|node-1', 'owner-a|node-9', 'owner-a|node-1'], 'each was stored first');
    } finally {
      feed.close();
    }
    for (let i = 0; i < 50 && (registry as any).endedListeners.size > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((registry as any).endedListeners.size, 0, 'closing the feed unsubscribes it');
  });

  it('replays ends published while the caller was not subscribed, before the liveness snapshot', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const registry = new BackgroundSubagentRegistry({ resolveWorkspace: () => null, recordEnds: () => ({ workspaceId: 'ws-a' }) });
    const base = await start(hub, registry);
    const done = { sessionId: 'agent-1', outcome: 'completed' as const, endedAt: 7, result: 'all done' };
    const stopped = { sessionId: 'agent-2', outcome: 'cancelled' as const, endedAt: 8 };
    // Nobody is subscribed: these ends reach no renderer now.
    registry.end({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-1' }, 'codex:1', [done]);
    registry.end({ ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-2' }, 'claude:1', [stopped]);
    registry.end({ ownerUserId: 'owner-b', workspaceId: 'ws-a', nodeId: 'node-3' }, 'claude:2', [stopped]);
    const feed = await openFeed(base, 'owner-a', 'ws-a');
    try {
      const first = await feed.next();
      const second = await feed.next();
      const snapshot = await feed.next();
      assert.deepEqual([first.event, second.event, snapshot.event], ['background_subagents_ended', 'background_subagents_ended', 'background_subagents']);
      assert.deepEqual(parseWorkflowRunSseEnvelope(first.data)?.backgroundSubagentsEnded, { nodeId: 'node-1', subagents: [done] });
      assert.deepEqual(parseWorkflowRunSseEnvelope(second.data)?.backgroundSubagentsEnded, { nodeId: 'node-2', subagents: [stopped] });
      assert.deepEqual(snapshot.data.backgroundSubagents, { snapshot: true, nodes: {} }, 'another owner\'s ends are not replayed');
    } finally {
      feed.close();
    }
  });

  it('rejects actions the run does not accept now', async () => {
    const hub = new WorkflowRunHub(memoryStore());
    const run = hub.update(CONTEXT, 'claude', 'task-2', (current) => ({ ...current, status: 'completed' as const }))!;
    const base = await start(hub);
    const bad = await fetch(`${base}/workflow-runs/${run.id}/actions`, { method: 'POST', headers: { 'x-user': 'owner-a', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'explode' }) });
    assert.equal(bad.status, 400);
    const refused = await fetch(`${base}/workflow-runs/${run.id}/actions`, { method: 'POST', headers: { 'x-user': 'owner-a', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
    assert.equal(refused.status, 409);
    const missing = await fetch(`${base}/workflow-runs/${run.id}`, { headers: { 'x-user': 'owner-b' } });
    assert.equal(missing.status, 404);
  });
});

describe('background_subagents envelopes (shared parsing)', () => {
  const envelope = (backgroundSubagents: unknown, extra: Record<string, unknown> = {}) =>
    ({ version: 1, event: 'background_subagents', run: null, backgroundSubagents, emittedAt: 5, ...extra });

  it('accepts a valid snapshot and delta', () => {
    assert.deepEqual(parseWorkflowRunSseEnvelope(envelope({ snapshot: true, nodes: { 'node-1': ['a', 'b'], 'node-2': [] } })), {
      version: 1, event: 'background_subagents', run: null,
      backgroundSubagents: { snapshot: true, nodes: { 'node-1': ['a', 'b'], 'node-2': [] } }, emittedAt: 5,
    });
    const delta = parseWorkflowRunSseEnvelope(envelope({ snapshot: false, nodes: { 'node-1': [] } }, { emittedAt: undefined }));
    assert.deepEqual(delta?.backgroundSubagents, { snapshot: false, nodes: { 'node-1': [] } });
    assert.equal(typeof delta?.emittedAt, 'number', 'a missing emittedAt is stamped');
    // The run is not read for this event.
    assert.equal(parseWorkflowRunSseEnvelope(envelope({ snapshot: false, nodes: {} }, { run: { junk: true } }))?.run, null);
  });

  it('drops malformed envelopes', () => {
    for (const bad of [
      undefined,
      null,
      'nodes',
      [],
      { nodes: {} },
      { snapshot: 'yes', nodes: {} },
      { snapshot: true },
      { snapshot: true, nodes: null },
      { snapshot: true, nodes: [['node-1', ['a']]] },
      { snapshot: true, nodes: 'node-1' },
    ]) {
      assert.equal(parseWorkflowRunSseEnvelope(envelope(bad)), null, JSON.stringify(bad));
    }
    assert.equal(parseWorkflowRunSseEnvelope(envelope({ snapshot: true, nodes: {} }, { version: 2 })), null);
  });

  it('drops invalid nodes and ids and enforces the limits', () => {
    const long = 'x'.repeat(BACKGROUND_SUBAGENT_LIMITS.idLength + 1);
    const max = 'm'.repeat(BACKGROUND_SUBAGENT_LIMITS.idLength);
    const parsed = parseBackgroundSubagentsUpdate({
      snapshot: false,
      nodes: {
        'node-1': ['a', '', 7, null, long, max, 'a'],
        'node-2': 'a',
        'node-3': { 0: 'a' },
        [long]: ['a'],
        '': ['a'],
      },
    });
    assert.deepEqual(parsed, { snapshot: false, nodes: { 'node-1': ['a', max] } }, 'deduplicated; bad ids and nodes dropped');

    const many = Array.from({ length: BACKGROUND_SUBAGENT_LIMITS.idsPerNode + 10 }, (_, i) => `agent-${i}`);
    assert.equal(parseBackgroundSubagentsUpdate({ snapshot: true, nodes: { n: many } })!.nodes.n.length, BACKGROUND_SUBAGENT_LIMITS.idsPerNode);

    const nodes = Object.fromEntries(Array.from({ length: BACKGROUND_SUBAGENT_LIMITS.nodes + 10 }, (_, i) => [`node-${i}`, ['a']]));
    assert.equal(Object.keys(parseBackgroundSubagentsUpdate({ snapshot: true, nodes })!.nodes).length, BACKGROUND_SUBAGENT_LIMITS.nodes);
  });

  it('reads a pending background agent as interrupted once untracked', () => {
    const base: SubagentInfo = {
      sessionId: 'toolu_bg', sessionName: 'Audit docs', agentName: 'explore', initialQuery: 'Audit docs',
      status: 'working', group: '', dependsOn: [], source: 'claude', background: true,
    };
    assert.equal(isBackgroundSubagentPending(base), true);
    assert.equal(isBackgroundSubagentPending({ ...base, status: 'terminated' }), true, 'finished, report pending');
    assert.equal(isBackgroundSubagentPending({ ...base, status: 'terminated', outcome: 'completed' }), false);
    assert.equal(isBackgroundSubagentPending({ ...base, background: undefined }), false);

    const running = { ...base, currentTool: 'Read', endedAt: 123, startedAt: 100 } as SubagentInfo;
    const untracked = untrackedSubagent(running);
    assert.equal(untracked.status, 'terminated');
    assert.equal(untracked.outcome, 'cancelled');
    assert.equal(untracked.error, SUBAGENT_UNTRACKED_ERROR);
    assert.equal('currentTool' in untracked, false);
    assert.equal('endedAt' in untracked, false, 'the launch turn end is not when the agent stopped');
    assert.equal(untracked.startedAt, 100);
    assert.equal(running.status, 'working', 'the stored entry is left as it is');
    assert.equal(untrackedSubagent({ ...base, error: 'boom' }).error, 'boom', 'an existing error is kept');
  });
});

describe('background_subagents_ended envelopes (shared parsing)', () => {
  const envelope = (backgroundSubagentsEnded: unknown) =>
    ({ version: 1, event: 'background_subagents_ended', run: null, backgroundSubagentsEnded, emittedAt: 5 });

  it('accepts ends and keeps only what they say', () => {
    const parsed = parseWorkflowRunSseEnvelope(envelope({ nodeId: 'node-1', subagents: [
      { sessionId: 'a', outcome: 'cancelled', endedAt: 3, error: 'gone', status: 'working', junk: true },
      { sessionId: 'b', outcome: 'completed', result: 'done', usage: { totalTokens: 4, bogus: 'x' } },
    ] }));
    assert.deepEqual(parsed, {
      version: 1, event: 'background_subagents_ended', run: null, emittedAt: 5,
      backgroundSubagentsEnded: { nodeId: 'node-1', subagents: [
        { sessionId: 'a', outcome: 'cancelled', endedAt: 3, error: 'gone' },
        { sessionId: 'b', outcome: 'completed', result: 'done', usage: { totalTokens: 4 } },
      ] },
    });
  });

  it('drops malformed ends, and an envelope with none', () => {
    const long = 'x'.repeat(SUBAGENT_END_LIMITS.idLength + 1);
    const parsed = parseBackgroundSubagentsEnded({ nodeId: 'node-1', subagents: [
      { sessionId: 'ok', outcome: 'failed' },
      { sessionId: '', outcome: 'failed' },
      { sessionId: long, outcome: 'failed' },
      { sessionId: 'no-outcome' },
      { sessionId: 'bad-outcome', outcome: 'exploded' },
      null,
      'x',
    ] });
    assert.deepEqual(parsed, { nodeId: 'node-1', subagents: [{ sessionId: 'ok', outcome: 'failed' }] });
    const many = Array.from({ length: SUBAGENT_END_LIMITS.ends + 3 }, (_, i) => ({ sessionId: `a-${i}`, outcome: 'cancelled' }));
    assert.equal(parseBackgroundSubagentsEnded({ nodeId: 'node-1', subagents: many })?.subagents.length, SUBAGENT_END_LIMITS.ends);
    for (const bad of [undefined, null, [], {}, { nodeId: 'node-1' }, { nodeId: 'node-1', subagents: [] },
      { nodeId: '', subagents: [{ sessionId: 'a', outcome: 'cancelled' }] },
      { nodeId: long, subagents: [{ sessionId: 'a', outcome: 'cancelled' }] },
      { nodeId: 'node-1', subagents: [{ sessionId: 'a' }] }]) {
      assert.equal(parseWorkflowRunSseEnvelope(envelope(bad)), null, JSON.stringify(bad));
    }
  });
});
