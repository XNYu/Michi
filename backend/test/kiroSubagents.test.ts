/**
 * Kiro subagent observability, replayed from real (sanitized) wires recorded
 * by benchmarks/subagent-observability/2026-10-14. Each test drives the
 * production path: AcpClient.dispatch → session queue → KiroSession.send →
 * NormalizedEvents → the shared roster fold used by persistence and the UI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applySubagentActivity,
  mergeSubagentRoster,
  type SubagentInfo,
} from 'michi-shared';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { createSubtaskNarration, kiroV2SummaryResult, kiroV3DelegationEntry } from 'michi-runtime/internal/adapters/kiro/kiroSubagents';
import { michiTestHost } from './helpers/michiTestHost';

const FIXTURES = path.join(__dirname, 'fixtures', 'subagents');

function readWire(name: string): { parent: string; frames: Array<Record<string, any>> } {
  const [head, ...rest] = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { parent: head.parentSessionId, frames: rest };
}

/** Run frames through AcpClient's real routing and collect the parent queue. */
function routeThroughAcp(engine: 'v2' | 'v3', parent: string, frames: Array<Record<string, any>>): Array<Record<string, any>> {
  const client = new AcpClient(undefined, os.tmpdir(), undefined, engine);
  const updates: Array<Record<string, any>> = [];
  (client as any).sessionQueues.set(parent, { push: (item: any) => { if (item.update) updates.push(item.update.update ?? item.update); } });
  for (const frame of frames) (client as any).dispatch(frame);
  return updates;
}

async function sendThroughSession(updates: Array<Record<string, any>>): Promise<NormalizedEvent[]> {
  const client = {
    async *prompt() {
      for (const update of updates) yield update;
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    },
  };
  const runtime = { host: michiTestHost(), ensureClient: async () => client, getCurrentMode: () => null, getCurrentModel: () => null } as unknown as KiroRuntime;
  const session = new KiroSession('node-1', 'native-1', runtime, '/tmp');
  const events: NormalizedEvent[] = [];
  for await (const event of session.send('probe')) events.push(event);
  return events;
}

function foldRoster(events: NormalizedEvent[]): SubagentInfo[] {
  let roster: SubagentInfo[] | undefined;
  for (const ev of events) {
    if (ev.kind === 'subagent_list_update') roster = mergeSubagentRoster(roster, ev.subagents);
    if (ev.kind === 'subagent_tool_activity') {
      const { kind: _kind, ...payload } = ev;
      roster = applySubagentActivity(roster, payload);
    }
  }
  return roster ?? [];
}

describe('Kiro V3 subagents (agent-subtask)', () => {
  it('builds a roster entry with task, activity and result, and keeps child output out of the parent', async () => {
    const { parent, frames } = readWire('kiro-v3-wire.jsonl');
    const events = await sendThroughSession(routeThroughAcp('v3', parent, frames));
    const roster = foldRoster(events);

    assert.equal(roster.length, 1);
    const [sub] = roster;
    assert.equal(sub.sessionId, 'f3b5aa87-39ac-47f2-951a-473a768611c3');
    assert.equal(sub.agentName, 'general-task-execution');
    assert.equal(sub.parentToolCallId, 'invoke_subagent_toolu_bdrk_01XLzBkJDVUftmTD2c2KiKnE');
    assert.match(sub.prompt ?? '', /read-only observability probe child agent/);
    assert.match(sub.description ?? '', /Delegating a single read-only child agent/);
    assert.equal(sub.status, 'terminated');
    assert.equal(sub.outcome, 'completed');
    assert.match(sub.result ?? '', /SUBAGENT_OBSERVABILITY_20261014/);

    const tools = (sub.activity ?? []).filter((a) => a.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'completed');
    assert.equal(tools[0].toolKind, 'read');
    assert.match(tools[0].output ?? '', /PROBE_MARKER=SUBAGENT_OBSERVABILITY_20261014/);
    const narration = (sub.activity ?? []).filter((a) => a.kind === 'message').map((a) => a.title);
    assert.ok(narration.some((t) => t.includes("going to read fixture.txt")), JSON.stringify(narration));

    // The child's narration and tools never become parent answer or chips.
    const parentText = events.filter((e) => e.kind === 'chunk').map((e) => (e as { text: string }).text).join('');
    assert.doesNotMatch(parentText, /going to read fixture\.txt/);
    const parentTools = events.filter((e) => e.kind === 'tool_call') as Array<{ toolCallId: string; kindType?: string }>;
    assert.deepEqual(parentTools.map((t) => t.toolCallId), ['invoke_subagent_toolu_bdrk_01XLzBkJDVUftmTD2c2KiKnE']);
    assert.equal(parentTools[0].kindType, 'subagent');
  });

  it('maps a failed delegation to a failed outcome with its error text', () => {
    const entry = kiroV3DelegationEntry({
      toolCallId: 'd1', title: 'Sub-agent: reviewer', status: 'failed',
      rawInput: { name: 'reviewer', prompt: 'Review it' }, rawOutput: 'Model unavailable',
      _meta: { kiro: { kind: 'agent-subtask', agentSubtaskId: 'sub-1' } },
    });
    assert.equal(entry?.outcome, 'failed');
    assert.equal(entry?.error, 'Model unavailable');
    assert.equal(entry?.result, undefined);
  });

  it('coalesces streamed narration per native message instead of per token', () => {
    const narration = createSubtaskNarration(1_000);
    assert.deepEqual(narration.push('s', 'r1', 'Reading'), []);
    assert.deepEqual(narration.push('s', 'r1', ' the file'), []);
    const flushed = narration.push('s', 'r1', ' now.');
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].title, 'Reading the file now.');
    assert.equal(flushed[0].toolCallId, 's:m:r1');
    // A new native message flushes the previous one and starts its own id.
    narration.push('s', 'r2', 'Done');
    assert.deepEqual(narration.flushAll().map((a) => a.toolCallId), ['s:m:r2']);
  });
});

describe('Kiro V2 subagents (native roster)', () => {
  it('links the roster to the crew tool call and captures task, activity and the summary result', async () => {
    const { parent, frames } = readWire('kiro-v2-wire.jsonl');
    const events = await sendThroughSession(routeThroughAcp('v2', parent, frames));
    const roster = foldRoster(events);

    assert.equal(roster.length, 1);
    const [sub] = roster;
    assert.equal(sub.sessionName, 'read_fixture');
    assert.equal(sub.agentName, 'probe-observer');
    assert.equal(sub.parentToolCallId, 'call_6e93f6da-4d00-474a-a116-5962eb3524dc');
    assert.match(sub.prompt ?? '', /isolated read-only observability probe/);
    assert.equal(sub.status, 'terminated');
    assert.equal(sub.outcome, 'completed');
    assert.match(sub.result ?? '', /PROBE_MARKER=SUBAGENT_OBSERVABILITY_20261014/);
    const read = (sub.activity ?? []).find((a) => a.toolKind === 'read');
    assert.equal(read?.status, 'completed');
    assert.match(read?.title ?? '', /Read only fixture\.txt/);
    assert.equal(read?.detail, 'fixture.txt');
    assert.match(read?.output ?? '', /PROBE_MARKER=SUBAGENT_OBSERVABILITY_20261014/);
    // The child's own narration reaches the trail, before its first tool.
    const kinds = (sub.activity ?? []).map((a) => a.kind);
    assert.ok(kinds.indexOf('message') >= 0 && kinds.indexOf('message') < kinds.indexOf('tool'), `narration precedes tools: ${kinds}`);
  });

  it('only treats the summary tool as the final report', () => {
    assert.equal(kiroV2SummaryResult({ status: 'completed', title: 'Summarizing', rawInput: { taskResult: 'R' }, _meta: { kiro: { toolName: 'summary' } } }), 'R');
    assert.equal(kiroV2SummaryResult({ status: 'in_progress', title: 'Summarizing', rawInput: { taskResult: 'R' } }), undefined);
    assert.equal(kiroV2SummaryResult({ status: 'completed', title: 'Writing', rawInput: { taskResult: 'R' }, _meta: { kiro: { toolName: 'write' } } }), undefined);
  });
});

describe('Kiro V2 roster routing with concurrent sessions', () => {
  it('keeps known agents with their session and does not stamp a guessed chip link', () => {
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v2');
    const queues: Record<string, Array<Record<string, any>>> = { A: [], B: [] };
    for (const sid of ['A', 'B']) {
      (client as any).sessionQueues.set(sid, { push: (item: any) => queues[sid].push(item.update) });
    }
    const dispatch = (msg: Record<string, unknown>) => (client as any).dispatch(msg);
    const update = (sessionId: string, u: Record<string, unknown>) => dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
    const roster = (subagents: unknown[]) => dispatch({ jsonrpc: '2.0', method: '_kiro.dev/subagent/list_update', params: { subagents } });

    update('A', { sessionUpdate: 'tool_call', toolCallId: 'crewA', title: 'Spawning agent crew' });
    roster([{ sessionId: 'a1', status: { type: 'working' } }]);
    assert.equal(queues.A.at(-1)?.parentToolCallId, 'crewA', 'a single owner is unambiguous');

    update('B', { sessionUpdate: 'tool_call', toolCallId: 'crewB', title: 'Spawning agent crew' });
    roster([{ sessionId: 'a1', status: { type: 'working' } }, { sessionId: 'b1', status: { type: 'working' } }]);
    const toA = queues.A.at(-1)!;
    const toB = queues.B.at(-1)!;
    assert.deepEqual(toA.subagents.map((s: any) => s.sessionId), ['a1'], 'a known agent stays with its session');
    assert.equal(toA.parentToolCallId, 'crewA');
    assert.deepEqual(toB.subagents.map((s: any) => s.sessionId), ['b1']);
    assert.equal(toB.parentToolCallId, undefined, 'a guess under ambiguity is not linked to a chip');
  });
});
