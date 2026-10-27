/**
 * Turns Kiro CLI V3 starts on its own. When a workflow a chat launched
 * finishes, Kiro wakes the parent session and reports back in a turn with
 * no session/prompt (`turn_start` … `agent_message_chunk` … `turn_end`,
 * chunks tagged `agentInitiatedReason: "workflow-complete-wake"`). Replayed
 * from sanitized wires recorded by
 * benchmarks/workflow-observability/2026-10-16/probe-kiro-wake.cjs
 * (kiro-cli 2.32.0): an idle wake, a wake with a prompt sent during it
 * (Kiro cancels the wake and runs the prompt), and a wake stopped with
 * session/cancel (Kiro ends it with stopReason "cancelled").
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AcpClient, type AcpUpdate } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { ChatHub } from '../src/agents/chatHub';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent } from 'michi-shared';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { michiTestHost } from './helpers/michiTestHost';
import { workflowSink } from './helpers/hostSinks';
import { chatOwner, runOwner } from './helpers/owners';
import type { RuntimeSessionOwner } from '../src/agents/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'workflows');

function lines(name: string): Array<Record<string, any>> {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Same contract as AcpClient's private SessionQueue. */
function queue() {
  let items: unknown[] = [];
  let waiter: ((item: unknown) => void) | null = null;
  return {
    items: () => items,
    push(item: unknown) { if (waiter) { const w = waiter; waiter = null; w(item); } else items.push(item); },
    get() { const head = items.shift(); return head !== undefined ? Promise.resolve(head) : new Promise((resolve) => { waiter = resolve; }); },
    drain() { items = []; },
  };
}

function harness(cancelTimeoutMs = 5_000) {
  const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3', { bin: 'kiro-cli', args: () => [], cancelTimeoutMs });
  const written: any[] = [];
  (client as any).proc = { stdin: { destroyed: false, write: (line: string, cb?: (err?: Error) => void) => { written.push(JSON.parse(line)); cb?.(); return true; } } };
  const parent = queue();
  (client as any).sessionQueues.set('parent', parent);
  const dispatch = (frame: Record<string, unknown>) => (client as any).dispatch(frame);
  return { client, written, parent, dispatch };
}

/** Consume a stream, keeping what arrived before an error. */
function collector() {
  const seen: AcpUpdate[] = [];
  let result: Promise<AcpUpdate[]> | undefined;
  return {
    seen,
    get result() { return result; },
    take(updates: AsyncIterableIterator<AcpUpdate>) {
      result = (async () => {
        try { for await (const update of updates) seen.push(update); } catch (error) { seen.push({ sessionUpdate: 'error', error: String(error) }); }
        return seen;
      })();
    },
  };
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function promptOf(client: AcpClient, text: string) {
  return (async () => {
    const out: AcpUpdate[] = [];
    for await (const update of client.prompt('parent', text)) out.push(update);
    return out;
  })();
}

const info = (kiro: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'session_info_update', _meta: { kiro } } } });
const chunk = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const textOf = (updates: AcpUpdate[]) => updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content?.text ?? '').join('');
const turnStartIndex = (frames: Array<Record<string, any>>) => frames.findIndex((frame) => frame.params?.update?._meta?.kiro?.kind === 'turn_start');

afterEach(() => sessionRegistry.clearAllSessions());

describe('Kiro agent-initiated turns (AcpClient)', () => {
  it('gives a workflow-complete wake its own stream, ended by Kiro, and keeps it out of the chat queue', async () => {
    const { client, parent, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler((sid) => sid === 'parent' ? (updates) => wake.take(updates) : null);
    for (const frame of lines('kiro-wake-wire.jsonl')) dispatch(frame);
    assert.ok(wake.result, 'the wake was claimed');
    const updates = await wake.result!;
    assert.match(textOf(updates), /^The workflow completed successfully/);
    assert.match(textOf(updates), /ALPHA_MARKER=KIRO_WAKE_A_20261016/);
    assert.deepEqual(updates.at(-1), { sessionUpdate: 'turn_end', stopReason: 'end_turn' });
    assert.ok(updates.some((u) => u.sessionUpdate === 'usage_summary'), 'the turn\'s usage is reported with it');
    assert.equal(parent.items().some((item: any) => item.update?.update?.sessionUpdate === 'agent_message_chunk'), false,
      'no wake frame waits in the chat queue for the next prompt');
    assert.equal(client.hasAgentTurn('parent'), false);
    assert.equal((client as any).sessionInFlight.has('parent'), false, 'the session is free again');
  });

  it('makes a prompt sent during the wake wait for it, then streams only its own reply', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const frames = lines('kiro-wake-wire.jsonl');
    // Up to the wake's first chunk: it is shown, so a prompt waits for it.
    const shown = frames.findIndex((frame) => frame.params?.update?.sessionUpdate === 'agent_message_chunk');
    for (const frame of frames.slice(0, shown + 1)) dispatch(frame);
    assert.equal(client.hasAgentTurn('parent'), true);
    assert.ok(wake.result, 'claimed');

    const reply = promptOf(client, 'next question');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.some((msg) => msg.method === 'session/prompt'), false, 'held until Kiro ends its own turn');
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'a shown wake is not cut short');

    for (const frame of frames.slice(shown + 1)) dispatch(frame);
    assert.match(textOf(await wake.result!), /workflow completed/);
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(chunk('ANSWER'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'ANSWER', 'nothing from the wake leaks into the reply');
  });

  it('never shows a wake Kiro cancels for a prompt that was already on its way (send-during wire)', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    // The prompt holds the session (waiting on a predecessor) when the wake starts.
    let releasePredecessor!: () => void;
    (client as any).sessionInFlight.set('parent', new Promise<void>((resolve) => { releasePredecessor = resolve; }));
    const reply = promptOf(client, 'Reply with exactly: DURING_OK');
    const frames = lines('kiro-wake-send-wire.jsonl');
    const first = turnStartIndex(frames);
    for (const frame of frames.slice(0, first + 1)) dispatch(frame);
    releasePredecessor();
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    for (const frame of frames.slice(first + 1)) dispatch(frame);
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'DURING_OK');
    assert.equal(claims, 0, 'the cancelled wake showed nothing, so no empty self-turn appears');
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('cancels an unclaimed wake and its approvals instead of buffering them into the next prompt', async () => {
    const { client, written, dispatch } = harness();
    const frames = lines('kiro-wake-wire.jsonl');
    const start = turnStartIndex(frames);
    for (const frame of frames.slice(0, start + 1)) dispatch(frame);
    dispatch({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 42), { jsonrpc: '2.0', id: 42, result: { outcome: { outcome: 'cancelled' } } });
    assert.ok(written.some((msg) => msg.method === 'session/cancel'), 'nobody shows it, so it is stopped');
    const reply = promptOf(client, 'hello');
    for (const frame of frames.slice(start + 1)) dispatch(frame);
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), '');
  });

  it('does not treat the turn_start of our own prompt as a wake', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('mine'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'mine');
    assert.equal(claims, 0);
  });

  it('stops a wake with session/cancel as Kiro does it (cancel wire)', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const frames = lines('kiro-wake-cancel-wire.jsonl');
    const firstChunk = frames.findIndex((frame) => frame.params?.update?.sessionUpdate === 'agent_message_chunk');
    for (const frame of frames.slice(0, firstChunk + 1)) dispatch(frame);
    assert.equal(await client.cancelAgentTurn('parent'), true);
    assert.deepEqual(written.at(-1), { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'parent' } });
    assert.equal(await client.cancelAgentTurn('parent'), true, 'a second Stop sends nothing more');
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1);
    for (const frame of frames.slice(firstChunk + 1)) dispatch(frame);
    const updates = await wake.result!;
    assert.deepEqual(updates.at(-1), { sessionUpdate: 'turn_end', stopReason: 'cancelled' });
    assert.equal((client as any).sessionInFlight.has('parent'), false);
    assert.equal(client.needsSessionRecovery('parent'), false);
  });

  it('closes the stream at the cancel deadline, keeps discarding the wake, and quarantines if Kiro never ends it', async () => {
    const { client, written, dispatch } = harness(20);
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('wake-part-1 '));
    await client.cancelAgentTurn('parent');
    const updates = await wake.result!;
    assert.deepEqual(updates.at(-1), { sessionUpdate: 'turn_end', stopReason: 'cancelled' }, 'the user sees it stop');
    assert.equal((client as any).sessionInFlight.has('parent'), true, 'no safe boundary yet: the next prompt still waits');
    const reply = promptOf(client, 'next').catch((error) => error);
    dispatch(chunk('LATE-WAKE '));
    assert.equal(written.some((msg) => msg.method === 'session/prompt'), false);
    await until(() => client.needsSessionRecovery('parent'), 2_000);
    assert.equal((client as any).sessionInFlight.has('parent'), false);
    const outcome = await reply;
    assert.match(String(outcome), /needs recovery/, 'the next prompt asks for recovery instead of reading late wake frames');
  });

  it('releases the wake\'s reservation when the Kiro process exits', async () => {
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3', { bin: process.execPath, args: () => ['-e', 'setInterval(() => {}, 1000)'], cancelTimeoutMs: 50 });
    client.start();
    try {
      (client as any).sessionQueues.set('parent', queue());
      const wake = collector();
      client.setAgentTurnHandler(() => (updates) => wake.take(updates));
      (client as any).dispatch(info({ kind: 'turn_start', turnStart: true }));
      (client as any).dispatch(chunk('reporting'));
      const reply = promptOf(client, 'q').then(() => 'settled', (error) => String(error));
      process.kill((client as any).proc.pid, 'SIGKILL');
      const updates = await wake.result!;
      assert.match(String(updates.at(-1)?.error ?? ''), /exited/);
      assert.match(await reply, /exited|not running|stopped/i, 'a prompt waiting behind the wake settles');
      assert.equal((client as any).sessionInFlight.has('parent'), false);
    } finally {
      await client.shutdown().catch(() => {});
    }
  });

  it('opens no wake for a turn that started just before the process exited', async () => {
    const client = new AcpClient(undefined, os.tmpdir(), undefined, 'v3', { bin: process.execPath, args: () => ['-e', 'setInterval(() => {}, 1000)'], cancelTimeoutMs: 50 });
    client.start();
    try {
      (client as any).sessionQueues.set('parent', queue());
      client.setAgentTurnHandler(() => () => {});
      const reply = promptOf(client, 'q').then(() => 'settled', (error) => String(error));
      await until(() => (client as any).activePrompts.has('parent'));
      (client as any).dispatch(info({ kind: 'turn_start', turnStart: true }));
      (client as any).dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
      (client as any).dispatch(info({ kind: 'turn_start', turnStart: true }));
      process.kill((client as any).proc.pid, 'SIGKILL');
      assert.match(await reply, /exited/);
      assert.equal(client.hasAgentTurn('parent'), false);
      await until(() => !(client as any).sessionInFlight.has('parent'));
    } finally {
      await client.shutdown().catch(() => {});
    }
  });

  it('lets a prompt overtake a wake that has shown nothing yet, as Kiro does (send-during wire)', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    const frames = lines('kiro-wake-send-wire.jsonl');
    const first = turnStartIndex(frames);
    for (const frame of frames.slice(0, first + 1)) dispatch(frame);
    const reply = promptOf(client, 'Reply with exactly: DURING_OK');
    // The prompt goes out at once; no cancel, which would clear the
    // workflow report Kiro carries into the prompted turn.
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    // A wake frame already in flight, and an approval it asks for, are discarded.
    dispatch(chunk('late wake text'));
    dispatch({ jsonrpc: '2.0', id: 5, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 5)?.result, { outcome: { outcome: 'cancelled' } });
    const sent = written.find((msg) => msg.method === 'session/prompt');
    for (const frame of frames.slice(first + 1)) dispatch(frame);
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'DURING_OK');
    assert.equal(claims, 0, 'no self-turn appears for it');
    assert.equal(client.hasAgentTurn('parent'), false);
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('ends an overtaken wake when the prompt\'s own turn starts, even if Kiro never ended the wake', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    // No wake turn_end: our own turn simply starts.
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    assert.equal(client.hasAgentTurn('parent'), false);
    dispatch(chunk('mine'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'mine', 'our frames are not mistaken for the wake\'s');
  });

  it('stops a wake that lost frames while giving way to a turn that never prompts', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    const release = client.announcePrompt('parent');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('wake text'));
    assert.equal(claims, 0, 'a turn of ours is coming: the wake is not shown');
    await until(() => !(client as any).sessionInFlight.has('parent'));
    release(); // e.g. the turn failed to save before prompting
    assert.ok(written.some((msg) => msg.method === 'session/cancel'), 'it cannot be shown whole, so it is stopped');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    assert.equal(client.hasAgentTurn('parent'), false);
  });

  it('restores a wake that lost nothing when the turn it gave way to never prompts', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    dispatch(info({ kind: 'context_usage', contextUsage: { usagePercentage: 9 } }));
    await new Promise((resolve) => setImmediate(resolve)); // The reservation it gave up is gone.
    release();
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'not stopped');
    dispatch(chunk('WAKE REPORT'));
    assert.ok(wake.result, 'shown after all');
    // It holds the session again: a message sent now waits for it.
    const reply = promptOf(client, 'next');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.some((msg) => msg.method === 'session/prompt'), false, 'held until the shown wake ends');
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(chunk('ANSWER'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'ANSWER');
  });

  it('stops a wake whose frame was discarded after it gave way, when the turn never prompts', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    dispatch(chunk('FIRST HALF '));
    release();
    dispatch(chunk('SECOND HALF'));
    assert.equal(claims, 0, 'never shown without its first half');
    assert.ok(written.some((msg) => msg.method === 'session/cancel'));
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    assert.equal(client.hasAgentTurn('parent'), false);
  });

  it('keeps a wake stopped while it gave way stopped when the turn never prompts', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    assert.equal(await client.cancelAgentTurn('parent'), true);
    release();
    dispatch(chunk('wake text'));
    assert.equal(claims, 0, 'not restored');
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1);
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    assert.equal(client.hasAgentTurn('parent'), false);
  });

  it('stops a restored wake nobody shows, holding the session until Kiro ends it', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => null);
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    dispatch(chunk('wake text'));
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1);
    assert.equal((client as any).sessionInFlight.has('parent'), true, 'restored with a reservation of its own');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('keeps tagged wake chunks out of a prompt whatever order Kiro sends them in', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    // The prompt's turn starts before Kiro finishes the wake (unrecorded order).
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[late wake text]' },
      _meta: { kiro: { agentInitiated: true, agentInitiatedReason: 'workflow-complete-wake' } } } } });
    dispatch(chunk('mine'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'mine');
  });

  it('restores a wake that lost nothing when Kiro rejects the prompt that overtook it', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello').catch((error) => String(error));
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'rejected' } });
    assert.match(String(await reply), /rejected/);
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'a cancel would clear its report');
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAKE REPORT' }, _meta: { kiro: { agentInitiated: true } } } } });
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT', 'shown after all');
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('keeps discarding an overtaken wake that lost frames when Kiro rejects the prompt that overtook it', async () => {
    const { client, written, dispatch, parent } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello').catch((error) => [{ sessionUpdate: 'error', error: String(error) }]);
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(chunk('wake text in flight'));
    dispatch({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'rejected' } });
    await reply;
    assert.ok(written.some((msg) => msg.method === 'session/cancel'), 'the wake may still run: stop it');
    assert.equal(client.hasAgentTurn('parent'), true, 'and keep tracking it');
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[orphan wake text]' }, _meta: { kiro: { agentInitiated: true } } } } });
    dispatch({ jsonrpc: '2.0', id: 79, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 79)?.result, { outcome: { outcome: 'cancelled' } });
    assert.equal(parent.items().length, 0, 'nothing waits for the next prompt');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    assert.equal(client.hasAgentTurn('parent'), false);
  });

  it('discards an MCP side effect that arrives while an overtaken wake is still open', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    client.injectUpdate('parent', { sessionUpdate: 'user_input_request', requestId: 1, questions: [{ question: 'wake asks?' }] });
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    client.injectUpdate('parent', { sessionUpdate: 'follow_ups', followUps: ['mine'] });
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    const updates = await reply;
    assert.equal(updates.some((u) => u.sessionUpdate === 'user_input_request'), false);
    assert.ok(updates.some((u) => u.sessionUpdate === 'follow_ups'), 'the prompt\'s own side effects still arrive');
  });

  it('reports a discarded side effect as not shown, and counts it as a frame the wake lost', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    assert.equal(client.injectUpdate('parent', { sessionUpdate: 'user_input_request', requestId: 2, questions: [{ question: 'wake asks?' }] }), false);
    release();
    dispatch(chunk('wake text'));
    assert.equal(claims, 0, 'it cannot be shown whole');
    assert.ok(written.some((msg) => msg.method === 'session/cancel'));
  });

  it('keeps Michi\'s own session state with the prompt while an overtaken wake is open', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'current_mode_update', currentModeId: 'mode-after-wake' } } });
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    const states = (await reply).filter((u) => u.sessionUpdate === 'session_state');
    assert.ok(states.some((u) => JSON.stringify(u.state).includes('mode-after-wake')));
  });

  it('lets a prompt overtake a wake that already shows its first chunk elsewhere, and keeps its report (late-send wire)', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    const frames = lines('kiro-wake-send-late-wire.jsonl');
    const firstChunk = frames.findIndex((frame) => frame.params?.update?.sessionUpdate === 'agent_message_chunk');
    // The message is announced before the wake's first chunk: the wake gives way.
    for (const frame of frames.slice(0, firstChunk)) dispatch(frame);
    const release = client.announcePrompt('parent');
    dispatch(frames[firstChunk]);
    const reply = promptOf(client, 'What markers did the workflow report?');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    for (const frame of frames.slice(firstChunk + 1)) dispatch(frame);
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'ALPHA_MARKER=KIRO_WAKE_A_20261016, BETA_MARKER=KIRO_WAKE_B_20261016');
    release(); // ChatHub's claim ends with its turn; the prompt already used it.
    assert.equal(claims, 0, 'the wake never shows');
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('shows a wake Kiro starts after our turn ended but before the prompt\'s result, as its own turn', async () => {
    const { client, written, dispatch, parent } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const tagged = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { kiro: { agentInitiated: true, agentInitiatedReason: 'workflow-complete-wake' } } } } });
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('mine'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    // The wake starts in the few frames between our turn_end and the result.
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(tagged('[wake A]'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'mine');
    dispatch(tagged('[wake B]'));
    dispatch({ jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    const updates = await wake.result!;
    assert.equal(textOf(updates), '[wake A][wake B]');
    assert.ok(updates.some((u) => u.sessionUpdate === 'permission_request'), 'its approval waits on it');
    assert.equal(parent.items().some((item: any) => ['agent_message_chunk', 'permission_request'].includes(item.update?.update?.sessionUpdate ?? item.update?.sessionUpdate)), false);
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  for (const [first, settles] of [['tagged chunk', 'result'], ['untagged tool call', 'result'], ['untagged tool call', 'error']] as const) {
    it(`shows a wake that starts just before the prompt's ${settles}, whose first frame (${first}) comes after it`, async () => {
      const { client, written, dispatch, parent } = harness();
      const wake = collector();
      client.setAgentTurnHandler(() => (updates) => wake.take(updates));
      const reply = promptOf(client, 'hello');
      await until(() => written.some((msg) => msg.method === 'session/prompt'));
      const sent = written.find((msg) => msg.method === 'session/prompt');
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      dispatch(chunk('mine'));
      dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      dispatch(settles === 'result'
        ? { jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } }
        : { jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'late failure' } });
      if (settles === 'result') assert.equal(textOf(await reply), 'mine');
      else await assert.rejects(reply, /late failure/);
      dispatch(first === 'tagged chunk'
        ? { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPORT' }, _meta: { kiro: { agentInitiated: true } } } } }
        : { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Shell', kind: 'execute', status: 'pending' } } });
      dispatch({ jsonrpc: '2.0', id: 92, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
      dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
      const updates = await wake.result!;
      assert.ok(updates.some((u) => u.sessionUpdate === 'permission_request'), 'its approval waits on it');
      assert.equal(parent.items().some((item: any) => (item.update?.update?.sessionUpdate ?? item.update?.sessionUpdate) === 'permission_request'), false);
      await until(() => !(client as any).sessionInFlight.has('parent'));
    });
  }

  it('gives a wake that started just before the result way to the next message', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const first = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('mine'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await first;
    // A queued message starts before the wake shows anything.
    const next = promptOf(client, 'next');
    await until(() => written.filter((msg) => msg.method === 'session/prompt').length === 2);
    const second = written.filter((msg) => msg.method === 'session/prompt')[1];
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Shell', kind: 'execute', status: 'pending' } } });
    dispatch({ jsonrpc: '2.0', id: 93, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 93)?.result, { outcome: { outcome: 'cancelled' } });
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('NEXT ANSWER'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch({ jsonrpc: '2.0', id: second.id, result: { stopReason: 'end_turn' } });
    const updates = await next;
    assert.equal(textOf(updates), 'NEXT ANSWER');
    assert.equal(updates.some((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'permission_request'), false, 'nothing of the wake');
    assert.equal(wake.result, undefined, 'never shown');
  });

  it('refuses to compact while a wake holds the session, shown or not', async () => {
    const { client, dispatch } = harness(20);
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const unseen = await client.compact('parent');
    assert.equal(unseen.success, false);
    assert.match(String(unseen.message), /turn of its own/);
    // Shown, stopped, and not ended by Kiro: the chat is idle, the session is not.
    dispatch(chunk('shown'));
    await client.cancelAgentTurn('parent');
    await wake.result;
    const stopping = await client.compact('parent');
    assert.equal(stopping.success, false);
    assert.match(String(stopping.message), /turn of its own/);
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
  });

  it('keeps untagged frames of a second turn within our prompt with the prompt', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('part 1 '));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('part 2'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    assert.equal(textOf(await reply), 'part 1 part 2');
    assert.equal(claims, 0);
    assert.equal(client.hasAgentTurn('parent'), false);
  });

  it('does not cancel natively for a turn stopped before its prompt went out, sparing the wake it overtook', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const release = client.announcePrompt('parent');
    assert.equal(await client.cancel('parent', { spareOvertakenWake: true }), true);
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    release();
    dispatch(chunk('WAKE REPORT'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT', 'shown after all');
    // Releasing the session (no option) still stops what runs natively.
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    client.announcePrompt('parent');
    await client.cancel('parent');
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1);
  });

  it('spares a wake opened when the prompt settled, when Stop comes before the turn ends, and does not hide it', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await reply;
    assert.equal(client.hasAgentTurn('parent'), true);
    // Stop on the finishing turn (no prompt out, nothing announced).
    assert.equal(await client.cancel('parent', { spareOvertakenWake: true }), true);
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'the wake is not this turn\'s to stop');
    assert.equal((client as any).agentTurns.overtakenTurn('parent'), undefined, 'nothing to give way to');
    dispatch(chunk('WAKE REPORT'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT');
  });

  /** Ends a prompt generator a test holds suspended, without waiting on an RPC that never came. */
  async function close(prompt: AsyncIterableIterator<AcpUpdate>): Promise<void> {
    await Promise.race([prompt.return?.(undefined), new Promise((resolve) => setTimeout(resolve, 100).unref())]).catch(() => {});
  }

  it('keeps a wake the next turn overtook when the turn before it settles late', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const first = client.prompt('parent', 'hello');
    try {
      // A slow consumer: it stops pulling after the first frame (the session
      // state every prompt starts with), before the prompt's end.
      assert.equal((await first.next()).done, false);
      await until(() => written.some((msg) => msg.method === 'session/prompt'));
      const sent = written.find((msg) => msg.method === 'session/prompt');
      dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' })); // Kiro ends the wake it overtook.
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
      dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
      await new Promise((resolve) => setImmediate(resolve));
      // A second wake starts, and the next message overtakes it.
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      client.announcePrompt('parent');
      const second = (client as any).agentTurns.overtakenTurn('parent');
      assert.ok(second);
      while (!(await first.next()).done) { /* drain to the generator's end */ }
      assert.equal((client as any).agentTurns.overtakenTurn('parent'), second, 'the next turn ends it, not the first');
    } finally {
      await close(first);
    }
  });

  it('leaves a wake another prompt overtook alone when the rejected prompt before it settles', async () => {
    const { client, written, dispatch } = harness();
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return () => {}; });
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const first = client.prompt('parent', 'hello');
    try {
      assert.equal((await first.next()).done, false);
      await until(() => written.some((msg) => msg.method === 'session/prompt'));
      const sent = written.find((msg) => msg.method === 'session/prompt');
      dispatch({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'rejected' } });
      await new Promise((resolve) => setImmediate(resolve)); // The rejection is handled.
      dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' })); // Kiro ends the first wake.
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      assert.equal(client.hasAgentTurn('parent'), true, 'a second wake');
      (client as any).agentTurns.overtake('parent'); // As another prompt's entry does.
      const second = (client as any).agentTurns.overtakenTurn('parent');
      assert.ok(second);
      await first.next().catch(() => undefined);
      assert.equal((client as any).agentTurns.overtakenTurn('parent'), second);
      dispatch(chunk('second wake text'));
      assert.equal(claims, 0, 'still given way to that prompt');
      assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    } finally {
      await close(first);
    }
  });

  it('leaves a shown wake\'s approval waiting when Stop comes after the prompt settled', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await reply;
    dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'parent', update: { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Shell', kind: 'execute', status: 'pending' } } });
    dispatch({ jsonrpc: '2.0', id: 94, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.ok(wake.result, 'shown');
    await client.cancel('parent', { spareOvertakenWake: true }); // Stop on the finishing turn.
    assert.equal(written.some((msg) => msg.id === 94), false, 'the wake\'s approval still waits for the user');
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    await wake.result;
  });

  it('does not make a wake give way to nobody when Stop finds no announced turn', async () => {
    const { client, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    await client.cancel('parent', { spareOvertakenWake: true });
    assert.equal((client as any).agentTurns.overtakenTurn('parent'), undefined);
  });

  it('spares a wake that started after the turn was announced, when Stop comes before the prompt', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    const release = client.announcePrompt('parent');
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    assert.equal(await client.cancel('parent', { spareOvertakenWake: true }), true);
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    release();
    dispatch(chunk('WAKE REPORT'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT');
  });

  it('leaves a wake that lost frames to an announced turn when the prompt before it is rejected', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello').catch((error) => String(error));
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(chunk('wake text in flight'));
    client.announcePrompt('parent'); // A queued turn will prompt next.
    dispatch({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'rejected' } });
    await reply;
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'the next prompt ends it, keeping its report');
    assert.ok((client as any).agentTurns.overtakenTurn('parent'), 'still given way');
  });

  it('reports a side effect for a wake nobody shows as not shown', async () => {
    const { client, dispatch } = harness();
    client.setAgentTurnHandler(() => null);
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('wake text'));
    assert.equal(client.injectUpdate('parent', { sessionUpdate: 'user_input_request', requestId: 3, questions: [] }), false);
  });

  it('cancels natively once our prompt is out, even with an overtaken wake open', async () => {
    const { client, written, dispatch } = harness();
    client.setAgentTurnHandler(() => () => {});
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const reply = promptOf(client, 'hello');
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    await client.cancel('parent', { spareOvertakenWake: true });
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1);
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'cancelled' } });
    await reply;
  });

  it('starts a prompt uncancelled even when a cancel was recorded while it waited', async () => {
    const { client, written, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('shown'));
    const controller = new AbortController();
    const waiting = (async () => { for await (const update of client.prompt('parent', 'first', [], controller.signal)) void update; })();
    // The user stops the waiting message: the cancel marks the session.
    await client.cancel('parent');
    controller.abort();
    await waiting;
    assert.equal((client as any).cancelledPrompts.has('parent'), true);
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    await wake.result;
    const next = promptOf(client, 'second');
    await until(() => written.filter((msg) => msg.method === 'session/prompt').length === 1);
    assert.equal((client as any).cancelledPrompts.has('parent'), false, 'steering works for the next turn');
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await next;
  });

  it('ends the wake when its session is released', async () => {
    const { client, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('shown'));
    client.destroySession('parent');
    assert.deepEqual((await wake.result!).at(-1), { sessionUpdate: 'turn_end', stopReason: 'cancelled' });
    assert.equal((client as any).sessionInFlight.has('parent'), false);
  });

  it('counts a running workflow as work that a recovery restart would end', async () => {
    const { createKiroWorkflowBridge } = await import('michi-runtime/internal/core/workflows/kiroWorkflowBridge');
    const { WorkflowRunHub } = await import('../src/services/workflowRunHub');
    const store = {
      upsert() {}, get: () => null, list: () => [], listOpen: () => [],
      workspaceOwnedBy: () => true, workspaceOfNode: () => 'ws',
    };
    const hub = new WorkflowRunHub(store as any);
    const { client, dispatch } = harness();
    const bridge = createKiroWorkflowBridge({
      hub: workflowSink(hub), resolve: () => ({ ownerUserId: 'owner-a', workspaceId: 'ws', owner: chatOwner('node-1') }), control: async () => {},
    });
    client.setWorkflowRouter({
      onEvent: (method, params) => bridge.handle(method, params),
      isStepSession: (sid) => bridge.isStepSession(sid),
      hasOpenRuns: () => bridge.hasOpenRuns(),
      requestPermission: (request) => bridge.requestPermission(request),
    });
    assert.equal(client.hasHealthyWork(), false);
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/run_start', params: { workflowId: 'wf_1', workflowName: 'w', nodeTree: [], parentSessionId: 'parent' } });
    assert.equal(client.hasHealthyWork(), true, 'a recovery must not restart the process under it');
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/run_complete', params: { workflowId: 'wf_1', status: 'paused', parentSessionId: 'parent' } });
    assert.equal(client.hasHealthyWork(), true, 'a paused workflow resumes only in this process');
    dispatch({ jsonrpc: '2.0', method: '_kiro/workflow/run_complete', params: { workflowId: 'wf_1', status: 'completed', parentSessionId: 'parent' } });
    assert.equal(client.hasHealthyWork(), false);
  });

  it('routes a permission request during the wake to the wake', async () => {
    const { client, dispatch } = harness();
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Read' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    const updates = await wake.result!;
    assert.equal(updates[0].sessionUpdate, 'permission_request');
    assert.equal(updates[0].toolCall.title, 'Read');
  });
});

function fakeRuntime(client: AcpClient): KiroRuntime {
  return {
    host: michiTestHost(),
    id: 'kiro',
    getCurrentMode: () => undefined,
    getCurrentModel: () => undefined,
    getClient: () => client,
    respondToPermission: () => {},
    cancelPermission: (_sid: string, requestId: number) => client.cancelPermission(requestId),
  } as unknown as KiroRuntime;
}

function hubForTests(begin: () => Promise<void> | void = () => {}): ChatHub {
  return new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    persistence: { begin, checkpoint: () => {}, finalize: () => {} },
  });
}

describe('Kiro agent-initiated turns (session and chat)', () => {
  it('translates the wake into chat events and remembers its answer', async () => {
    const { client } = harness();
    const session = new KiroSession('node-1', 'parent', fakeRuntime(client), os.tmpdir(), { owner: chatOwner('node-1') });
    const updates = (async function* (): AsyncIterableIterator<AcpUpdate> {
      yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Both markers: A, B.' }, _meta: { kiro: { agentInitiated: true } } };
      yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
    })();
    const events: NormalizedEvent[] = [];
    for await (const event of session.agentTurnEvents(updates)) events.push(event);
    assert.deepEqual(events.map((event) => event.kind), ['chunk', 'turn_end']);
    assert.deepEqual(session.getHistory().at(-1), { role: 'assistant', content: 'Both markers: A, B.' });
  });

  it('shows the wake as a self-initiated chat turn that the Stop route ends without marking the next prompt', async () => {
    const { client, written, dispatch } = harness(5_000);
    const session = new KiroSession('node-1', 'parent', fakeRuntime(client), os.tmpdir(), { owner: chatOwner('node-1') });
    const hub = hubForTests();
    const events: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => events.push(event), close: () => {} });
    client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('Reporting back'));
    await until(() => events.some((event) => event.event === 'chunk'));
    assert.deepEqual(events.map((event) => event.event), ['turn_start', 'chunk']);
    assert.equal((events[0].data as { selfInitiated?: boolean }).selfInitiated, true);
    assert.equal(hub.hasPendingSelfTurn('node-1'), true, 'the user\'s next message waits for it');

    // What POST /chats/:id/cancel does for a self-turn.
    assert.equal(hub.cancel('node-1'), true);
    await session.cancel();
    await until(() => events.some((event) => event.event === 'cancel_phase' && (event.data as { phase?: string }).phase === 'acknowledged'));
    assert.equal(written.filter((msg) => msg.method === 'session/cancel').length, 1, 'Stop reaches Kiro once');
    assert.equal((client as any).cancelledPrompts.has('parent'), false, 'the next prompt is not born cancelled');
    dispatch(info({ kind: 'turn_end', turnEnd: { stopReason: 'cancelled' }, stopReason: 'cancelled' }));
    await until(() => events.some((event) => event.event === 'done'));
    assert.equal((events.find((event) => event.event === 'done')!.data as { stopReason?: string }).stopReason, 'cancelled');
    await until(() => !hub.hasPendingSelfTurn('node-1'));
  });

  it('stops the native wake when the chat stops showing it, so it cannot hold the session', async () => {
    const { client, written, dispatch } = harness(5_000);
    const session = new KiroSession('node-1', 'parent', fakeRuntime(client), os.tmpdir(), { owner: chatOwner('node-1') });
    const hub = hubForTests();
    const events: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => events.push(event), close: () => {} });
    client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    // A display error ends the chat turn; Kiro's own turn keeps going.
    dispatch(info({ kind: 'display_error', displayError: { message: 'transient model error' } }));
    await until(() => events.some((event) => event.event === 'error' || event.event === 'done'));
    await until(() => written.some((msg) => msg.method === 'session/cancel'));
    dispatch({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 77)?.result, { outcome: { outcome: 'cancelled' } }, 'no approval waits on a turn nobody sees');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    await until(() => !(client as any).sessionInFlight.has('parent'));
  });

  it('runs a message sent before the wake shows anything, and never shows the wake', async () => {
    const { client, written, dispatch } = harness(5_000);
    const runtime = { ...fakeRuntime(client), ensureClient: async () => client } as unknown as KiroRuntime;
    const session = new KiroSession('node-1', 'parent', runtime, os.tmpdir(), { owner: chatOwner('node-1') });
    const hub = hubForTests();
    const background: ChatStreamEvent[] = [];
    const direct: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    hub.subscribe('node-1', { send: (event) => direct.push(event), close: () => {} });
    client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    assert.equal(hub.hasPendingSelfTurn('node-1'), false, 'the chat accepts a message now');
    const { done } = await hub.startTurn({ chatId: 'node-1', nodeId: 'node-1', text: 'hi', session });
    // The prompt goes out at once; Kiro ends the wake (as recorded) and runs it.
    await until(() => written.some((msg) => msg.method === 'session/prompt'));
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false);
    dispatch(chunk('wake text in flight'));
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(chunk('USER ANSWER'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await done;
    const userText = direct.filter((event) => event.event === 'chunk').map((event) => (event.data as { text?: string }).text).join('');
    assert.equal(userText, 'USER ANSWER');
    assert.equal(background.length, 0, 'no self-turn for the preempted wake');
    assert.deepEqual(session.getHistory().map((message) => message.content), ['hi', 'USER ANSWER']);
  });

  it('Stop on a message whose prompt never went out spares the wake it overtook', async () => {
    const { client, written, dispatch } = harness(5_000);
    let resolveClient!: () => void;
    const clientReady = new Promise<void>((resolve) => { resolveClient = resolve; });
    const runtime = { ...fakeRuntime(client), ensureClient: async () => { await clientReady; return client; } } as unknown as KiroRuntime;
    const session = new KiroSession('node-1', 'parent', runtime, os.tmpdir(), { owner: chatOwner('node-1') });
    const wake = collector();
    client.setAgentTurnHandler(() => (updates) => wake.take(updates));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const releaseClaim = session.claimTurn();
    const turn = (async () => { for await (const event of session.send('hi')) void event; })().catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    await session.cancel();
    assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'only the wake would hear it');
    resolveClient();
    await turn;
    assert.equal(written.some((msg) => msg.method === 'session/prompt'), false);
    releaseClaim();
    dispatch(chunk('WAKE REPORT'));
    dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
    assert.equal(textOf(await wake.result!), 'WAKE REPORT', 'shown after all');
  });

  it('does not show a wake whose first frame arrives while an accepted message is still being saved', async () => {
    const { client, written, dispatch } = harness(5_000);
    const runtime = { ...fakeRuntime(client), ensureClient: async () => client } as unknown as KiroRuntime;
    const session = new KiroSession('node-1', 'parent', runtime, os.tmpdir(), { owner: chatOwner('node-1') });
    let finishBegin!: () => void;
    let begins = 0;
    const hub = hubForTests(() => {
      begins += 1;
      if (begins === 1) return new Promise<void>((resolve) => { finishBegin = resolve; });
    });
    const background: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    const started = hub.startTurn({ chatId: 'node-1', nodeId: 'node-1', text: 'hi', session });
    // The wake's first frame and an approval land during the first durable write.
    dispatch(chunk('wake report'));
    dispatch({ jsonrpc: '2.0', id: 42, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    assert.deepEqual(written.find((msg) => msg.id === 42)?.result, { outcome: { outcome: 'cancelled' } }, 'no approval waits unseen');
    finishBegin();
    const { done } = await started;
    await until(() => written.some((msg) => msg.method === 'session/prompt'), 2_000);
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    dispatch(chunk('USER ANSWER'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await done;
    assert.equal(background.length, 0, 'no self-turn queues behind the message');
    assert.equal(hub.hasPendingSelfTurn('node-1'), false);
  });

  it('does not show a wake that starts while a requested self-turn waits its turn', async () => {
    const { client, written, dispatch } = harness(5_000);
    const runtime = { ...fakeRuntime(client), ensureClient: async () => client } as unknown as KiroRuntime;
    const session = new KiroSession('node-1', 'parent', runtime, os.tmpdir(), { owner: chatOwner('node-1') });
    const hub = hubForTests();
    const background: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    let claims = 0;
    client.setAgentTurnHandler(() => { claims += 1; return (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }); });
    // A parent continuation (Agent Run result, send_to_thread) is queued.
    const requested = hub.startRequestedSelfTurn({ chatId: 'node-1', nodeId: 'node-1', turnId: 'req-1', text: 'continue', session });
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('wake report'));
    assert.equal(claims, 0, 'the wake gives way to the queued turn');
    await until(() => written.some((msg) => msg.method === 'session/prompt'), 2_000);
    const sent = written.find((msg) => msg.method === 'session/prompt');
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    dispatch(chunk('continued'));
    dispatch({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await (await requested).done;
    assert.equal(background.filter((event) => event.event === 'turn_start').length, 1, 'only the requested turn');
  });

  for (const mode of ['stop-during-save', 'save-fails'] as const) {
    it(`shows a wake held back for a message that never prompted (${mode})`, async () => {
      const { client, written, dispatch } = harness(5_000);
      const runtime = { ...fakeRuntime(client), ensureClient: async () => client } as unknown as KiroRuntime;
      const session = new KiroSession('node-1', 'parent', runtime, os.tmpdir(), { owner: chatOwner('node-1') });
      let finishBegin!: (ok: boolean) => void;
      let begins = 0;
      const hub = hubForTests(() => {
        begins += 1;
        if (begins === 1) return new Promise<void>((resolve, reject) => { finishBegin = (ok) => ok ? resolve() : reject(new Error('db down')); });
      });
      const background: ChatStreamEvent[] = [];
      hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
      client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
        chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
      }));
      dispatch(info({ kind: 'turn_start', turnStart: true }));
      const started = hub.startTurn({ chatId: 'node-1', nodeId: 'node-1', text: 'hi', session, turnId: 'u-1' });
      if (mode === 'stop-during-save') { hub.cancel('node-1', 'u-1'); finishBegin(true); } else finishBegin(false);
      try { await (await started).done; } catch { /* the save failed */ }
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(written.some((msg) => msg.method === 'session/prompt'), false);
      assert.equal(written.some((msg) => msg.method === 'session/cancel'), false, 'the wake is not stopped');
      dispatch(chunk('WAKE REPORT'));
      dispatch(info({ kind: 'turn_end', stopReason: 'end_turn' }));
      await until(() => background.some((event) => event.event === 'done'));
      assert.equal(background.filter((event) => event.event === 'chunk').map((event) => (event.data as { text?: string }).text).join(''), 'WAKE REPORT');
      assert.equal((client as any).promptIntents.size, 0, 'no announcement is left behind');
    });
  }

  it('stops the wake when its self-turn cannot be saved, so its approvals do not wait forever', async () => {
    const { client, written, dispatch } = harness(5_000);
    const session = new KiroSession('node-1', 'parent', fakeRuntime(client), os.tmpdir(), { owner: chatOwner('node-1') });
    const hub = hubForTests(() => { throw new Error('SQLITE_BUSY'); });
    client.setAgentTurnHandler(() => (updates) => hub.startSelfTurn({
      chatId: 'node-1', nodeId: 'node-1', events: session.agentTurnEvents(updates), cancel: () => session.cancelAgentTurn(),
    }));
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    dispatch(chunk('reporting'));
    dispatch({ jsonrpc: '2.0', id: 88, method: 'session/request_permission', params: { sessionId: 'parent', toolCall: { title: 'Shell' }, options: [{ optionId: 'allow_once', kind: 'allow_once' }] } });
    await until(() => written.some((msg) => msg.method === 'session/cancel'));
    await until(() => written.some((msg) => msg.id === 88));
    assert.deepEqual(written.find((msg) => msg.id === 88)?.result, { outcome: { outcome: 'cancelled' } });
    dispatch(info({ kind: 'turn_end', stopReason: 'cancelled' }));
    await until(() => !hub.hasPendingSelfTurn('node-1') && !(client as any).sessionInFlight.has('parent'));
  });

  it('makes a wake that starts while a user turn persists its first rows wait for that turn', async () => {
    let finishBegin!: () => void;
    let begins = 0;
    const hub = hubForTests(() => {
      begins += 1;
      if (begins === 1) return new Promise<void>((resolve) => { finishBegin = resolve; });
    });
    const events: ChatStreamEvent[] = [];
    hub.subscribe('race-chat', { send: (event) => events.push(event), close: () => {} });
    const userTurn = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      yield { kind: 'chunk', text: 'user reply' } as NormalizedEvent;
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    })();
    const started = hub.startTurn({
      chatId: 'race-chat', nodeId: 'race-node', text: 'hi',
      session: { id: 'race-chat', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined, send: () => userTurn, cancel: () => {} },
    });
    // The wake arrives while startTurn awaits its first durable write.
    hub.startSelfTurn({
      chatId: 'race-chat', nodeId: 'race-node',
      events: (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'chunk', text: 'wake report' } as NormalizedEvent;
        yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
      })(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    finishBegin();
    const { turnId: userTurnId, done } = await started;
    await done;
    await until(() => events.filter((event) => event.event === 'done').length === 2);
    const turnOf = (event: ChatStreamEvent) => (event.data as { turnId?: string }).turnId === userTurnId ? 'user' : 'wake';
    const order = events.filter((event) => event.event === 'turn_start' || event.event === 'chunk' || event.event === 'done')
      .map((event) => `${event.event}:${turnOf(event)}`);
    assert.deepEqual(order, ['turn_start:user', 'chunk:user', 'done:user', 'turn_start:wake', 'chunk:wake', 'done:wake'], 'serial, and both finish');
  });
});

describe('Kiro recovery with a workflow running', () => {
  it('refuses to restart the process and says how to unblock it', async () => {
    const { KiroRuntime } = await import('michi-runtime/internal/adapters/kiro/KiroRuntime');
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
    const runtime = new KiroRuntime({ bridge, defaultCwd: os.tmpdir(), host: michiTestHost(), engine: 'v3' }) as any;
    const busy = (workflows: boolean) => ({
      needsSessionRecovery: () => true, hasHealthyWork: () => true, hasOpenWorkflowRuns: () => workflows,
    });
    runtime.pool.set('/tmp/cwd', busy(true));
    await assert.rejects(runtime.recoverCancelledSession('sess-1', '/tmp/cwd'), /resume or stop a paused workflow from its card/);
    runtime.pool.set('/tmp/cwd', busy(false));
    await assert.rejects(runtime.recoverCancelledSession('sess-1', '/tmp/cwd'), /Retry after the other task finishes/);
  });
});

describe('Kiro ask_user while its question cannot be shown', () => {
  it('answers "no answer" at once instead of waiting for the timeout', async () => {
    const { KiroRuntime } = await import('michi-runtime/internal/adapters/kiro/KiroRuntime');
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
    const registry = { get: () => ({ parentChatId: 'parent', cwd: '/tmp/cwd' }) } as any;
    // A regression fails fast instead of waiting 300 s.
    const runtime = new KiroRuntime({ bridge, mcpSlots: registry, defaultCwd: os.tmpdir(),
      host: michiTestHost(), engine: 'v3', approveTimeoutMs: () => 1500 }) as any;
    const { client, dispatch } = harness();
    runtime.pool.set('/tmp/cwd', client);
    client.setAgentTurnHandler(() => () => {});
    // A wake that gave way to a turn of ours: its side effects are discarded.
    dispatch(info({ kind: 'turn_start', turnStart: true }));
    client.announcePrompt('parent');
    const answer = await Promise.race([
      runtime.handleAskUser('slot-1', [{ question: 'Proceed?', options: [{ label: 'Yes' }], multiSelect: false }]),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000).unref()),
    ]);
    assert.equal(answer, null);
    assert.equal(runtime.pendingUserInputs.size, 0, 'nothing waits for an answer nobody can give');
  });
});

describe('Kiro agent-initiated turns (runtime claim)', () => {
  async function runtimeWith(bindingOwner: RuntimeSessionOwner | null, registered: 'match' | 'other-native' | 'none') {
    const { KiroRuntime } = await import('michi-runtime/internal/adapters/kiro/KiroRuntime');
    const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any;
    const runtime = new KiroRuntime({ bridge, defaultCwd: os.tmpdir(), host: michiTestHost(), engine: 'v3' }) as any;
    const { client } = harness();
    if (bindingOwner) {
      runtime.bindings.set('node-1', { publicSessionId: 'node-1', nativeSessionId: 'parent', owner: bindingOwner, cwd: os.tmpdir(), workspaceId: 'ws', ownerUserId: 'owner-a' });
      runtime.publicIdByNativeSid.set('parent', 'node-1');
    }
    if (registered !== 'none') {
      const session = new KiroSession('node-1', registered === 'match' ? 'parent' : 'someone-else', fakeRuntime(client), os.tmpdir(), { owner: chatOwner('node-1') });
      sessionRegistry.registerSession(session as any, 'owner-a');
    }
    runtime.attachAgentTurns(client);
    return { client, handler: (client as any).agentTurns.handler as (sid: string) => unknown };
  }

  it('claims a wake only for the chat session that owns it', async () => {
    const chatHubModule = await import('../src/agents/chatHub');
    const original = chatHubModule.chatHub.startSelfTurn;
    const started: Array<{ chatId: string; nodeId: string; ownerUserId?: string | null }> = [];
    chatHubModule.chatHub.startSelfTurn = ((args: any) => { started.push(args); }) as typeof original;
    try {
      const chat = await runtimeWith(chatOwner('node-1'), 'match');
      const consume = chat.handler('parent') as ((updates: AsyncIterableIterator<AcpUpdate>) => void) | null;
      assert.ok(consume, 'the owning chat claims it');
      consume!((async function* () {})());
      assert.deepEqual(started.map((args) => [args.chatId, args.nodeId, args.ownerUserId]), [['node-1', 'node-1', 'owner-a']]);
      sessionRegistry.clearAllSessions();

      assert.equal((await runtimeWith(runOwner('run-1', 'a1'), 'match')).handler('parent'), null, 'not an Agent Run');
      sessionRegistry.clearAllSessions();
      assert.equal((await runtimeWith(null, 'match')).handler('parent'), null, 'not a session Michi cannot place');
      sessionRegistry.clearAllSessions();
      assert.equal((await runtimeWith(chatOwner('node-1'), 'other-native')).handler('parent'), null, 'not a session now bound elsewhere');
      sessionRegistry.clearAllSessions();
      assert.equal((await runtimeWith(chatOwner('node-1'), 'none')).handler('parent'), null, 'not a released chat');
    } finally {
      chatHubModule.chatHub.startSelfTurn = original;
    }
  });
});
