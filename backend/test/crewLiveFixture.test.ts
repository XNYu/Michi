/**
 * The shared fixture behind the opt-in Crew live scripts (backend/scripts/
 * crew-live.cjs, crew-bridge-live.cjs). The scripts need a real Gateway, so
 * these checks drive the fixture with a fake ACP client and Gateway.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

const { createCrewLiveFixture } = require('../scripts/crew-live-fixture.cjs');

type Event = { sessionUpdate?: string; stopReason?: string };

function harness(t: TestContext, options: { prompt?: (signal: AbortSignal) => AsyncGenerator<Event>; failDelete?: string } = {}) {
  const saved = { live: process.env.MICHI_CREW_LIVE_TEST, memory: process.env.MICHI_CREW_MEMORY_MODE, exitCode: process.exitCode };
  process.env.MICHI_CREW_LIVE_TEST = '1';
  process.env.MICHI_CREW_MEMORY_MODE = 'caller-mode';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-fixture-test-'));
  const adapter = path.join(scratch, 'crewAcp.js');
  fs.writeFileSync(adapter, '');
  const calls: string[] = [];
  let sessions = 0;
  class FakeAcpClient {
    startedWith?: string;
    start() { this.startedWith = process.env.MICHI_CREW_MEMORY_MODE; calls.push(`start:${this.startedWith}`); }
    async initialize() { calls.push('initialize'); }
    async newSession() {
      sessions += 1;
      return { sessionId: `slot-${sessions}`, modes: { availableModes: [{ id: 'template:kirocrew' }] } };
    }
    async setMode(sid: string, mode: string) { calls.push(`setMode:${sid}:${mode}`); }
    async cancel(sid: string) { calls.push(`cancel:${sid}`); return true; }
    async shutdown() { calls.push('shutdown'); }
    async *prompt(_sid: string, _message: string, _attachments: unknown[], signal: AbortSignal) {
      yield* (options.prompt ?? (async function* () { yield { stopReason: 'end_turn' }; }))(signal);
    }
  }
  const gateway = {
    async stop(sid: string) { calls.push(`stop:${sid}`); },
    async waitUntilIdle(sid: string) { calls.push(`idle:${sid}`); },
    async deleteSlot(sid: string) {
      if (sid === options.failDelete) throw new Error('delete refused');
      calls.push(`delete:${sid}`);
    },
    close() { calls.push('gateway-close'); },
  };
  const fixture = createCrewLiveFixture(
    { prefix: 'michi-crew-fixture-run-', resultName: 'unused.json' },
    { AcpClient: FakeAcpClient, gateway, observability: {}, adapter },
  );
  t.after(() => {
    process.env.MICHI_CREW_LIVE_TEST = saved.live;
    if (saved.live === undefined) delete process.env.MICHI_CREW_LIVE_TEST;
    process.env.MICHI_CREW_MEMORY_MODE = saved.memory;
    if (saved.memory === undefined) delete process.env.MICHI_CREW_MEMORY_MODE;
    process.exitCode = saved.exitCode;
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(fixture.cwd, { recursive: true, force: true });
  });
  return { fixture, calls };
}

test('a client starts in the requested memory mode and restores the caller value', async (t) => {
  const { fixture, calls } = harness(t);
  await fixture.client('persistent');
  assert.deepEqual(calls, ['start:persistent', 'initialize']);
  assert.equal(process.env.MICHI_CREW_MEMORY_MODE, 'caller-mode');
});

test('a session selects the configured template and is registered for cleanup', async (t) => {
  const { fixture, calls } = harness(t);
  const { sid } = await fixture.session('temporary');
  assert.ok(calls.includes(`setMode:${sid}:template:kirocrew`));
  assert.deepEqual(fixture.slots, [sid]);
});

test('a turn that runs past its budget is cancelled and fails', async (t) => {
  const { fixture, calls } = harness(t, {
    prompt: async function* (signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  const { c, sid } = await fixture.session('temporary');
  await assert.rejects(fixture.turn(c, sid, 'hello', { timeoutMs: 20 }), /exceeded/);
  assert.ok(calls.includes(`cancel:${sid}`));
});

test('cleanup stops, waits for and deletes every slot, then removes the fixture directory', async (t) => {
  const { fixture, calls } = harness(t);
  const a = await fixture.session('temporary');
  const b = await fixture.session('temporary');
  assert.equal(await fixture.cleanup(), true);
  const slotCalls = calls.filter((call) => /^(stop|idle|delete):/.test(call));
  assert.deepEqual(slotCalls, [`stop:${a.sid}`, `idle:${a.sid}`, `delete:${a.sid}`, `stop:${b.sid}`, `idle:${b.sid}`, `delete:${b.sid}`]);
  assert.ok(calls.includes('gateway-close'));
  assert.equal(fs.existsSync(fixture.cwd), false);
});

test('a slot that cannot be removed keeps the fixture directory and fails the run', async (t) => {
  const { fixture } = harness(t, { failDelete: 'slot-1' });
  await fixture.session('temporary');
  await fixture.session('temporary');
  assert.equal(await fixture.cleanup(), false);
  assert.equal(fs.existsSync(fixture.cwd), true);
  assert.equal(fixture.report.retainedFixtureDirectory, fixture.cwd);
  assert.equal(process.exitCode, 1);
  assert.ok(fixture.report.checks.some((row: { name: string; slot?: string }) => row.name === 'removed diagnostic slot' && row.slot === 'slot-2'));
});
