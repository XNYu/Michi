/**
 * ClaudeSession steer and compaction, at the SDK boundary.
 *
 * The scripted frames follow what the installed CLI (2.1.312, SDK 0.3.306)
 * sent in the standalone probes: command_lifecycle (msg_lifecycle_v1) for
 * each uuid-stamped user message, a held steer running as the next CLI turn
 * when the running turn makes no further model call, cancel_async_message
 * withdrawing a queued steer, and /compact reporting status + compact_boundary.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../src/services/chatEvents';
import {
  newScriptedSession as newSession, restoreClaudeSpawn as restoreSpawn, runningScriptedTurn as runningTurn,
  startScriptedTurn as startTurn, stubClaudeSpawn as stubSpawn, until,
} from './helpers/claudeScriptedChild';

describe('ClaudeSession steer', () => {
  beforeEach(() => { stubSpawn(); mock.restoreAll(); });
  afterEach(() => { restoreSpawn(); mock.restoreAll(); });

  test('a steer folded into the running turn ends with that turn', async () => {
    const { session, child, query } = await newSession();
    query.cancelAsyncMessage = async () => true;
    try {
      const turn = await runningTurn(session, child);
      const result = await session.steer('also say BANANA');
      assert.deepEqual(result, { accepted: true, pending: true });
      const steer = child.lines[1];
      assert.equal(steer.type, 'user');
      assert.equal(steer.priority, 'next');
      assert.equal(steer.message.content, 'also say BANANA');
      assert.equal(steer.session_id, 'ext-steer-1');
      child.lifecycle(steer.uuid, 'queued');
      child.lifecycle(steer.uuid, 'started');
      child.chunk('done BANANA');
      child.lifecycle(steer.uuid, 'completed');
      child.result();
      await turn.done;
      assert.deepEqual(turn.events.filter((ev) => ev.kind === 'turn_end'), [{ kind: 'turn_end', stopReason: 'end_turn' }]);
      assert.equal(session.getState(), 'idle');
      assert.deepEqual(session.getHistory().map((m) => [m.role, m.content]),
        [['user', 'first'], ['user', 'also say BANANA'], ['assistant', 'done BANANA']]);
    } finally { await session.dispose(); }
  });

  test('a steer the turn could not fold runs as the next CLI turn inside the same Michi turn', async () => {
    const { session, child, query } = await newSession();
    query.cancelAsyncMessage = async () => true;
    try {
      const turn = await runningTurn(session, child);
      child.chunk('1 2 3');
      assert.equal((await session.steer('then say END')).accepted, true);
      const steer = child.lines[1];
      child.lifecycle(steer.uuid, 'queued');
      child.result('success', { input_tokens: 100, output_tokens: 10 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(turn.events.some((ev) => ev.kind === 'turn_end'), false, 'the first CLI result is held');
      assert.equal(session.getState(), 'in_turn');
      child.lifecycle(steer.uuid, 'started');
      child.send({ type: 'system', subtype: 'init', session_id: 'ext-steer-1', capabilities: ['msg_lifecycle_v1'] });
      child.chunk(' END');
      child.result('success', { input_tokens: 200, output_tokens: 20 });
      await turn.done;
      const ends = turn.events.filter((ev) => ev.kind === 'turn_end');
      assert.deepEqual(ends, [{ kind: 'turn_end', stopReason: 'end_turn' }]);
      const summaries = turn.events.filter((ev): ev is Extract<NormalizedEvent, { kind: 'usage_summary' }> => ev.kind === 'usage_summary');
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].inputTokens, 300);
      assert.equal(summaries[0].outputTokens, 30);
      assert.equal(session.getHistory().at(-1)?.content, '1 2 3 END');
    } finally { await session.dispose(); }
  });

  test('a steer is refused outside a turn, for slash commands, and without the CLI lifecycle or withdrawal', async () => {
    const { session, child, query } = await newSession();
    try {
      assert.deepEqual(await session.steer('idle'), { accepted: false, reason: 'no_active_turn' });
      query.cancelAsyncMessage = async () => true;
      const turn = await runningTurn(session, child, ['interrupt_receipt_v1']);
      assert.deepEqual(await session.steer('x'), { accepted: false, reason: 'unsupported' }, 'no msg_lifecycle_v1');
      assert.deepEqual(await session.steer('/compact'), { accepted: false, reason: 'not_queued' });
      assert.deepEqual(await session.steer('   '), { accepted: false, reason: 'empty' });
      child.result();
      await turn.done;
      delete query.cancelAsyncMessage;
      const second = startTurn(session, 'second');
      await until(() => child.lines.length === 2, 'the second prompt');
      child.init();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(await session.steer('x'), { accepted: false, reason: 'unsupported' }, 'no cancel_async_message');
      child.result();
      await second.done;
      assert.equal(child.lines.length, 2, 'nothing was sent for a refused steer');
    } finally { await session.dispose(); }
  });

  test('an Agent Run session does not steer', async () => {
    const { runOwner } = require('./helpers/owners') as typeof import('./helpers/owners');
    const { session } = await newSession({ owner: runOwner('run-1', 'node-steer') });
    try {
      assert.deepEqual(await session.steer('x'), { accepted: false, reason: 'unsupported' });
    } finally { await session.dispose(); }
  });

  test('Stop withdraws a queued steer before interrupting, and keeps the process', async () => {
    const { session, child, query } = await newSession();
    const calls: string[] = [];
    query.cancelAsyncMessage = async (uuid: string) => { calls.push(`cancel:${uuid}`); child.lifecycle(uuid, 'cancelled'); return true; };
    query.interrupt = async () => {
      calls.push('interrupt');
      setTimeout(() => child.result('error_during_execution'), 5);
      return { still_queued: [] };
    };
    try {
      const turn = await runningTurn(session, child);
      await session.steer('later');
      const steer = child.lines[1];
      child.lifecycle(steer.uuid, 'queued');
      const ack = await session.cancel();
      await turn.done;
      assert.deepEqual(calls, [`cancel:${steer.uuid}`, 'interrupt']);
      assert.equal(ack.source, 'native');
      assert.equal(ack.nativeMethod, 'SDK interrupt + result');
      assert.equal(turn.events.at(-1)?.kind === 'turn_end' && turn.events.at(-1)?.kind, 'turn_end');
      assert.deepEqual(turn.events.filter((ev) => ev.kind === 'turn_end'), [{ kind: 'turn_end', stopReason: 'cancelled' }]);
      assert.equal(child.killed, false);
    } finally { await session.dispose(); }
  });

  test('Stop between a held result and the steer\'s turn withdraws the steer and ends the turn without an interrupt', async () => {
    const { session, child, query } = await newSession();
    let interrupted = false;
    query.cancelAsyncMessage = async (uuid: string) => { child.lifecycle(uuid, 'cancelled'); return true; };
    query.interrupt = async () => { interrupted = true; return { still_queued: [] }; };
    try {
      const turn = await runningTurn(session, child);
      await session.steer('later');
      child.lifecycle(child.lines[1].uuid, 'queued');
      child.result();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(turn.events.some((ev) => ev.kind === 'turn_end'), false);
      const ack = await session.cancel();
      await turn.done;
      assert.equal(interrupted, false, 'the CLI was idle');
      assert.equal(ack.nativeMethod, 'SDK cancel_async_message');
      assert.deepEqual(turn.events.filter((ev) => ev.kind === 'turn_end'), [{ kind: 'turn_end', stopReason: 'cancelled' }]);
      assert.equal(session.getState(), 'idle');
      assert.equal(child.killed, false);
    } finally { await session.dispose(); }
  });

  test('Stop retires the process when a steer of the turn survives the interrupt', async () => {
    const { session, child, query } = await newSession();
    let uuid = '';
    query.cancelAsyncMessage = async () => false; // already taken for the next turn
    query.interrupt = async () => {
      setTimeout(() => child.result('error_during_execution'), 5);
      return { still_queued: [uuid] };
    };
    try {
      const turn = await runningTurn(session, child);
      await session.steer('later');
      uuid = child.lines[1].uuid;
      const ack = await session.cancel();
      await turn.done;
      assert.equal(ack.source, 'inferred');
      assert.equal(child.killed, true, 'a Stop must not let the steer run');
    } finally { await session.dispose(); }
  });

  test('the CLI dropping a held steer ends the turn with the held result', async () => {
    const { session, child, query } = await newSession();
    query.cancelAsyncMessage = async () => true;
    try {
      const turn = await runningTurn(session, child);
      await session.steer('later');
      child.result('success', { input_tokens: 7, output_tokens: 3 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      child.lifecycle(child.lines[1].uuid, 'cancelled');
      await turn.done;
      const summary = turn.events.find((ev): ev is Extract<NormalizedEvent, { kind: 'usage_summary' }> => ev.kind === 'usage_summary');
      assert.equal(summary?.totalTokens, 10);
      assert.deepEqual(turn.events.filter((ev) => ev.kind === 'turn_end'), [{ kind: 'turn_end', stopReason: 'end_turn' }]);
    } finally { await session.dispose(); }
  });
});

describe('ClaudeSession compact', () => {
  beforeEach(() => { stubSpawn(); mock.restoreAll(); });
  afterEach(() => { restoreSpawn(); mock.restoreAll(); });

  test('/compact runs between turns and reports the context before and after', async () => {
    const { session, child } = await newSession();
    try {
      assert.deepEqual(await session.compact(), { started: false, detail: 'Claude has no conversation to compact yet.' });
      const turn = await runningTurn(session, child);
      assert.deepEqual(await session.compact(), { started: false, detail: 'Wait for the active turn to finish before compacting.' });
      child.result();
      await turn.done;
      const pending = session.compact('  keep the\n code word ');
      await until(() => child.lines.length === 2, 'the /compact message');
      assert.equal(child.lines[1].message.content, '/compact keep the code word');
      assert.equal(child.lines[1].priority, undefined);
      child.lifecycle(child.lines[1].uuid, 'started');
      child.send({ type: 'system', subtype: 'status', status: 'compacting' });
      child.send({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      child.send({ type: 'system', subtype: 'init', session_id: 'ext-steer-1' });
      child.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 19_107, post_tokens: 4_174 } });
      child.send({ type: 'user', message: { role: 'user', content: 'This session is being continued…' }, isReplay: true });
      child.result('success', { input_tokens: 0, output_tokens: 0 });
      assert.deepEqual(await pending, { started: true, completed: true, detail: 'Compacted 19.1k → 4.2k tokens.' });
      assert.equal(session.getState(), 'idle');
      assert.deepEqual(session.getHistory().map((m) => m.content), ['first'], 'compaction adds nothing to the transcript');
    } finally { await session.dispose(); }
  });

  test('a failed /compact is not reported as started', async () => {
    const { session, child } = await newSession();
    try {
      const turn = await runningTurn(session, child);
      child.result();
      await turn.done;
      const pending = session.compact();
      await until(() => child.lines.length === 2, 'the /compact message');
      assert.equal(child.lines[1].message.content, '/compact');
      child.send({ type: 'system', subtype: 'status', status: 'compacting' });
      child.send({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' });
      child.result('success', { input_tokens: 0, output_tokens: 0 });
      assert.deepEqual(await pending, { started: false, detail: 'Compaction failed: Not enough messages to compact.' });
      assert.equal(session.getState(), 'idle');
    } finally { await session.dispose(); }
  });

  test('an automatic compaction during a turn reaches the turn stream', async () => {
    const { session, child } = await newSession();
    try {
      const turn = await runningTurn(session, child);
      child.send({ type: 'system', subtype: 'status', status: 'compacting' });
      child.send({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      child.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 20_000 } });
      child.result();
      await turn.done;
      assert.deepEqual(turn.events.filter((ev) => ev.kind.startsWith('compaction')).map((ev) => ev.kind), ['compaction_start', 'compaction_end']);
    } finally { await session.dispose(); }
  });
});
