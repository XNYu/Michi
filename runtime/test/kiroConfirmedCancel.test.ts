/**
 * Confirmed cancel and metering on Kiro (probed against kiro-cli 2.35.1,
 * both engines): after `session/cancel` the pending `session/prompt` settles
 * with stopReason "cancelled" (v2 0-1 ms, v3 22-30 ms), and the next prompt
 * runs on the same session. The ACP core reports that settlement; the Kiro
 * descriptor claims a native ack and native metering only for a flavor that
 * confirms them (kiro-cli), never for an agent that merely speaks Kiro's
 * protocol (Kiro Crew).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import { KIRO_HARNESS, KIRO_STATIC_DESCRIPTOR, kiroDescriptor } from '../src/adapters/kiro/kiroDescriptor';
import { KIRO_FLAVOR } from '../src/adapters/kiro/acpAgentFlavor';
import { CREW_KIRO_FLAVOR } from '../src/adapters/crew/crewFlavor';
import { CREW_STATIC_DESCRIPTOR } from '../src/adapters/crew/crewDescriptor';

function fixture(engine: 'v2' | 'v3', cancelTimeoutMs = 200) {
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
    const promptId = () => wire.find((m) => m.method === 'session/prompt')?.id;
    return { client, wire, promptId };
}

async function startPrompt(client: any) {
    const turn = client.prompt('sid', 'count to 400');
    const drained = (async () => { const out: any[] = []; for await (const u of turn) out.push(u); return out; })();
    await delay(0);
    return drained;
}

describe('AcpClient.cancelAndSettle', () => {
    for (const engine of ['v2', 'v3'] as const) {
        it(`${engine}: reports the stopReason the cancelled prompt settles with, before the consumer sees the end`, async () => {
            const { client, wire, promptId } = fixture(engine);
            await client.newSession();
            let consumerEnded = false;
            const drained = startPrompt(client).then((updates) => { consumerEnded = true; return updates; });
            await delay(0);
            const settling = client.cancelAndSettle('sid');
            await delay(0);
            assert.ok(wire.some((m) => m.method === 'session/cancel'), 'session/cancel goes out at once');
            client.dispatch({ id: promptId(), result: { stopReason: 'cancelled' } });
            const settled = await settling;
            assert.equal(consumerEnded, false, 'the settlement is known before the consumer reads the end');
            assert.deepEqual(settled, { dispatched: true, stopReason: 'cancelled' });
            assert.equal((await drained).at(-1)?.stopReason, 'cancelled');
            assert.equal(client.needsSessionRecovery('sid'), false);
            assert.equal(client.cancelTimers.size, 0);
            client.proc = null;
        });
    }

    it('reports no stopReason when no prompt is out', async () => {
        const { client, wire } = fixture('v2');
        await client.newSession();
        assert.deepEqual(await client.cancelAndSettle('sid'), { dispatched: true });
        assert.ok(wire.some((m) => m.method === 'session/cancel'));
        assert.deepEqual(await client.cancelAndSettle('unknown-session'), { dispatched: false });
        client.proc = null;
    });

    it('reports another stopReason as is: the turn ended, the agent did not say it stopped', async () => {
        const { client, promptId } = fixture('v2');
        await client.newSession();
        const drained = startPrompt(client);
        const settling = client.cancelAndSettle('sid');
        await delay(0);
        client.dispatch({ id: promptId(), result: { stopReason: 'end_turn' } });
        assert.deepEqual(await settling, { dispatched: true, stopReason: 'end_turn' });
        await drained;
        client.proc = null;
    });

    it('a prompt that never settles reports nothing by the cancel deadline, and the watchdog quarantines it', async () => {
        const { client, promptId } = fixture('v3', 25);
        await client.newSession();
        const drained = startPrompt(client).catch((error: Error) => error);
        const started = Date.now();
        assert.deepEqual(await client.cancelAndSettle('sid'), { dispatched: true });
        assert.ok(Date.now() - started < 1_000, 'bounded by the cancel deadline');
        assert.match(String(await drained), /did not finish cancellation/);
        assert.equal(client.needsSessionRecovery('sid'), true);
        // A late answer changes nothing.
        client.dispatch({ id: promptId(), result: { stopReason: 'cancelled' } });
        assert.equal(client.needsSessionRecovery('sid'), true);
        client.proc = null;
    });
});

describe('Kiro descriptor: confirmed cancel and metering', () => {
    it('kiro-cli claims a native cancel ack and native metering on both engines', () => {
        for (const engine of ['v2', 'v3'] as const) {
            const descriptor = kiroDescriptor({ engine, clients: [], mcpSlots: 'per-session', sidecarTitles: true, flavor: KIRO_FLAVOR });
            assert.equal(descriptor.harness.interruptAck.availability, 'native', engine);
            assert.equal(descriptor.harness.interruptAck.confidence, 'native', engine);
            assert.equal(descriptor.harness.usage.availability, 'native', engine);
            assert.match(descriptor.harness.usage.notes ?? '', /credits.*no token counts or cost/);
            assert.equal(descriptor.topology.cancel, 'native-ack', engine);
        }
        assert.deepEqual(KIRO_STATIC_DESCRIPTOR.harness, KIRO_HARNESS, 'the static kiro-cli harness is KIRO_HARNESS');
        assert.equal(KIRO_STATIC_DESCRIPTOR.topology.cancel, 'native-ack');
    });

    it('an agent that confirms nothing keeps the dispatch-only ack and no usage', () => {
        const descriptor = kiroDescriptor({ engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false });
        assert.deepEqual(descriptor.harness.interruptAck, { availability: 'inferred', confidence: 'unknown', notes: 'session/cancel notify — dispatch, not an agent ack' });
        assert.deepEqual(descriptor.harness.usage, { availability: 'invisible', confidence: 'unverifiable' });
        assert.equal(descriptor.topology.cancel, 'inferred-keep-session');
    });

    it('an agent-record flavor (Kiro Crew) claims a native ack from its stop record, not the prompt; usage stays its own', () => {
        const descriptor = kiroDescriptor({ engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false, flavor: CREW_KIRO_FLAVOR });
        assert.equal(descriptor.harness.interruptAck.availability, 'native');
        assert.match(descriptor.harness.interruptAck.notes ?? '', /record of the stop/);
        assert.equal(descriptor.topology.cancel, 'native-ack');
        // Crew meters nothing as a flavor; its override describes Gateway credits.
        assert.deepEqual(descriptor.harness.usage, { availability: 'invisible', confidence: 'unverifiable' });
        assert.match(CREW_STATIC_DESCRIPTOR.harness.interruptAck.notes ?? '', /stop_event/);
        assert.equal(CREW_STATIC_DESCRIPTOR.harness.usage.availability, 'native');
        assert.equal(CREW_STATIC_DESCRIPTOR.topology.cancel, 'native-ack');
    });

    it('keeps the slot order of the harness', () => {
        const crew = kiroDescriptor({ engine: 'v2', clients: [], mcpSlots: 'per-session', sidecarTitles: false });
        assert.deepEqual(Object.keys(crew.harness), Object.keys(KIRO_HARNESS));
    });
});
