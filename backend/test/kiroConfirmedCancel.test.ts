/**
 * Stop on a Kiro chat turn, through ChatHub, AcpAgentSession and the real
 * AcpClient (fake stdio). kiro-cli 2.35.1 settles a cancelled session/prompt
 * with stopReason "cancelled" on both engines (.probe/kiro, probe-cancel.mjs),
 * so that answer is reported as the agent's own acknowledgement, ahead of the
 * turn's settled phase. Anything less stays an inferred, dispatch-only ack.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { CREW_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/crew/crewFlavor';
import type { ChatStreamEvent } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner } from './helpers/owners';

function fixture(engine: 'v2' | 'v3', cancelTimeoutMs = 2_000) {
  const client = new AcpClient('/bin/false', '/tmp', undefined, engine) as any;
  client.cancelTimeoutMs = cancelTimeoutMs;
  const wire: any[] = [];
  client.proc = { stdin: { destroyed: false, write(text: string, cb?: () => void) {
    const message = JSON.parse(text);
    wire.push(message);
    cb?.();
    if (message.method === 'session/new') {
      queueMicrotask(() => client.dispatch({ id: message.id, result: { sessionId: 'sid' } }));
    }
  } } };
  const runtime = {
    host: michiTestHost(),
    id: 'kiro',
    getCurrentMode: () => undefined,
    getCurrentModel: () => undefined,
    getClient: () => client,
    ensureClient: async () => client,
    respondToPermission: () => {},
    cancelPermission: (_sid: string, requestId: number) => client.cancelPermission(requestId),
  } as unknown as AcpAgentRuntime;
  const promptIds = () => wire.filter((m) => m.method === 'session/prompt').map((m) => m.id);
  return { client: client as any, wire, runtime, promptIds };
}

function hub(): ChatHub {
  return new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
  });
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await delay(2);
  }
}

const phases = (events: ChatStreamEvent[]) => events.filter((e) => e.event === 'cancel_phase')
  .map((e) => e.data as { phase: string; source?: string; confidence?: string; nativeMethod?: string });

async function cancelledTurn(engine: 'v2' | 'v3', answer: (client: any, id: number) => void, options: { cancelTimeoutMs?: number; crew?: boolean } = {}) {
  const { client, wire, runtime, promptIds } = fixture(engine, options.cancelTimeoutMs);
  await client.newSession();
  const session = new AcpAgentSession('node-1', 'sid', runtime, '/tmp', {
    owner: chatOwner('node-1'), ...(options.crew ? { flavor: CREW_KIRO_FLAVOR, runtimeId: 'crew' } : {}),
  });
  const chat = hub();
  const events: ChatStreamEvent[] = [];
  chat.subscribe('node-1', { send: (event: ChatStreamEvent) => events.push(event), close: () => {} } as never);
  const { done } = await chat.startTurn({ chatId: 'node-1', nodeId: 'node-1', text: 'count to 400', session, turnId: 't-1' });
  await until(() => promptIds().length === 1);
  client.dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sid', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one two ' } } } });
  assert.equal(chat.cancel('node-1', 't-1'), true);
  await until(() => wire.some((m) => m.method === 'session/cancel'));
  answer(client, promptIds()[0]);
  await done;
  return { client, wire, session, events, promptIds };
}

afterEach(() => sessionRegistry.clearAllSessions());

describe('Kiro confirmed cancel through ChatHub', () => {
  for (const engine of ['v2', 'v3'] as const) {
    it(`${engine}: the cancelled prompt's answer is a native ack, before settled, and the session takes the next prompt`, async () => {
      const { client, events, session, promptIds } = await cancelledTurn(engine,
        (c, id) => c.dispatch({ id, result: { stopReason: 'cancelled' } }));
      const seen = phases(events);
      assert.deepEqual(seen.map((p) => p.phase), ['requested', 'acknowledged', 'settled']);
      const { phase, source, confidence, nativeMethod } = seen[1];
      assert.deepEqual({ phase, source, confidence, nativeMethod }, {
        phase: 'acknowledged', source: 'native', confidence: 'native',
        nativeMethod: 'session/cancel + stopReason cancelled',
      });
      const done = events.find((e) => e.event === 'done')!.data as { stopReason?: string };
      assert.equal(done.stopReason, 'cancelled');
      assert.equal(client.needsSessionRecovery('sid'), false);
      // The next prompt runs on the same session, with nothing left over.
      const next = (async () => { const out: any[] = []; for await (const ev of session.send('again')) out.push(ev); return out; })();
      await until(() => promptIds().length === 2);
      client.dispatch({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sid', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
      client.dispatch({ id: promptIds()[1], result: { stopReason: 'end_turn' } });
      const nextEvents = await next;
      assert.deepEqual(nextEvents.filter((e) => e.kind === 'chunk').map((e) => e.text), ['OK']);
      assert.equal(nextEvents.at(-1)?.stopReason, 'end_turn');
      client.proc = null;
    });
  }

  it('a prompt that ends some other way after the cancel is only an inferred ack', async () => {
    const { events } = await cancelledTurn('v2', (c, id) => c.dispatch({ id, result: { stopReason: 'end_turn' } }));
    const ack = phases(events).find((p) => p.phase === 'acknowledged');
    assert.equal(ack?.source, 'inferred');
    assert.equal(ack?.confidence, 'unknown');
  });

  it('an agent that never answers: inferred ack at the cancel deadline, session quarantined for recovery', async () => {
    const { client, events, promptIds } = await cancelledTurn('v3', () => {}, { cancelTimeoutMs: 30 });
    const seen = phases(events);
    assert.deepEqual(seen.map((p) => p.phase), ['requested', 'acknowledged', 'settled']);
    assert.equal(seen[1].source, 'inferred');
    assert.equal(client.needsSessionRecovery('sid'), true);
    client.dispatch({ id: promptIds()[0], result: { stopReason: 'cancelled' } });
    assert.equal(client.needsSessionRecovery('sid'), true, 'a late answer does not clear the quarantine');
    client.proc = null;
  });

  it("Kiro Crew's ack comes from the Gateway's stop record, not the prompt's answer: without a record it stays dispatch-only", async () => {
    const { events } = await cancelledTurn('v2', (c, id) => c.dispatch({ id, result: { stopReason: 'cancelled' } }), { crew: true });
    const ack = phases(events).find((p) => p.phase === 'acknowledged');
    assert.equal(ack?.source, 'inferred');
    assert.equal(ack?.nativeMethod, 'session/cancel');
  });

  for (const slowAck of [false, true]) {
    it(`the caller of cancel() hears the ack before the session yields the turn end${slowAck ? ', even when the ack is slower' : ''}`, async () => {
      const { client, runtime, promptIds } = fixture('v2');
      await client.newSession();
      if (slowAck) {
        const settle = client.cancelAndSettle.bind(client);
        client.cancelAndSettle = async (...args: unknown[]) => { const settled = await settle(...args); await delay(20); return settled; };
      }
      const session = new AcpAgentSession('node-1', 'sid', runtime, '/tmp', { owner: chatOwner('node-1') });
      const stream = session.send('count to 400');
      const first = stream.next();
      await until(() => promptIds().length === 1);
      let ackSettled = false;
      const ack = session.cancel();
      void ack.then(() => { ackSettled = true; });
      client.dispatch({ id: promptIds()[0], result: { stopReason: 'cancelled' } });
      let end: any;
      for (let step = await first; !step.done; step = await stream.next()) {
        if (step.value.kind === 'turn_end') { end = { ...step.value, ackSettled }; break; }
      }
      await stream.return?.(undefined);
      assert.deepEqual(end, { kind: 'turn_end', stopReason: 'cancelled', ackSettled: true });
      assert.equal((await ack).source, 'native');
      client.proc = null;
    });
  }

  it("Kiro Crew's turn end waits for the Gateway's stop record, so the host hears the native ack first", async () => {
    const { client, runtime, promptIds } = fixture('v2');
    await client.newSession();
    let release: (() => void) | undefined;
    client.executeCommand = () => new Promise((resolve) => {
      release = () => resolve({ success: true, data: { confirmed: true, state: 'stopped' } });
    });
    const session = new AcpAgentSession('node-1', 'sid', runtime, '/tmp', { owner: chatOwner('node-1'), flavor: CREW_KIRO_FLAVOR, runtimeId: 'crew' });
    const stream = session.send('count to 400');
    const first = stream.next();
    await until(() => promptIds().length === 1);
    let ackSettled = false;
    const ack = session.cancel();
    void ack.then(() => { ackSettled = true; });
    client.dispatch({ id: promptIds()[0], result: { stopReason: 'cancelled' } });
    await until(() => release !== undefined);
    setTimeout(() => release!(), 20);
    let end: any;
    for (let step = await first; !step.done; step = await stream.next()) {
      if (step.value.kind === 'turn_end') { end = { ...step.value, ackSettled }; break; }
    }
    await stream.return?.(undefined);
    assert.deepEqual(end, { kind: 'turn_end', stopReason: 'cancelled', ackSettled: true });
    assert.deepEqual(await ack, { acknowledged: true, source: 'native', confidence: 'native', nativeMethod: 'Crew stop_event stopped' });
    client.proc = null;
  });

  it('cancel without a running prompt dispatches, and claims nothing more', async () => {
    const { client, runtime } = fixture('v2');
    await client.newSession();
    const session = new AcpAgentSession('node-1', 'sid', runtime, '/tmp', { owner: chatOwner('node-1') });
    assert.deepEqual(await session.cancel(), { acknowledged: true, source: 'inferred', confidence: 'unknown', nativeMethod: 'session/cancel' });
    client.proc = null;
  });
});
