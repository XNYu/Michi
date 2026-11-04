import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PiSession, type PiSessionDeps } from '../src/agents/pi/PiSession';
import { PiSdkSession, createPiSession } from '../src/agents/pi/PiSdkSession';
import { piSdkSessionDirectory } from '../src/agents/pi/piSdkHarness';
import { PI_CORE_RUNTIME_DESCRIPTOR, PI_RUNTIME_DESCRIPTOR } from '../src/agents/pi/piDescriptor';
import { rowsToAgentMessages } from '../src/agents/pi/historyAdapter';
import { loadPiAi } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner } from './helpers/owners';

type Mode = 'answer' | 'summary' | 'fail';
const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function drain(iterator: AsyncIterable<NormalizedEvent>) {
  const events: NormalizedEvent[] = [];
  for await (const event of iterator) events.push(event);
  return events;
}

/** Large enough that the SDK keeps only the recent tail and summarizes the rest. */
function longHistory(): PiSessionDeps['initialMessages'] {
  const rows = [];
  for (let index = 0; index < 20; index++) {
    rows.push({ role: 'user', content: `Synthetic ${index}: ` + 'harmless context '.repeat(800), created_at: index * 2 });
    rows.push({ role: 'assistant', content: `Recorded synthetic context ${index}.`, created_at: index * 2 + 1 });
  }
  return rowsToAgentMessages(rows);
}

/** The real Pi SDK harness against a synthetic provider stream. */
async function fixture(t: TestContext, id: string, initialMessages?: PiSessionDeps['initialMessages']) {
  const ai: any = await loadPiAi();
  const model = ai.getModel('openai', 'gpt-4.1-mini');
  const control = { mode: 'answer' as Mode, gate: undefined as Promise<void> | undefined };
  const requests: Array<{ mode: Mode; context: any; apiKey: unknown }> = [];
  configureRuntimeDeps({
    dataDir: process.env.MICHI_DATA_DIR,
    historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null },
    providerKeys: { getProviderApiKey: () => 'synthetic-host-key' },
    agentConfig: { getAgentConfig: () => ({ provider: 'openai' } as any), resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
  });
  t.after(__resetRuntimeDeps);
  t.mock.method(require('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
  t.mock.method(require('../src/agents/pi/piTools'), 'buildPiTools', () => []);
  t.mock.method(require('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...ai, streamSimple: (m: any, context: any, options: any) => {
    const mode = control.mode;
    requests.push({ mode, context, apiKey: options?.apiKey });
    const stream = ai.createAssistantMessageEventStream();
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const message = (text: string, stopReason = 'stop') => ({ role: 'assistant', api: m.api, provider: m.provider, model: m.id,
      content: [{ type: 'text', text }], usage, stopReason, timestamp: Date.now() });
    void (async () => {
      const gate = control.gate;
      if (gate) {
        const aborted = new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        await Promise.race([gate, aborted]);
      }
      if (options?.signal?.aborted) {
        stream.push({ type: 'error', reason: 'aborted', error: { ...message('', 'aborted'), errorMessage: 'aborted' } });
      } else if (mode === 'fail') {
        stream.push({ type: 'error', reason: 'error', error: { ...message('', 'error'), errorMessage: 'synthetic provider outage' } });
      } else {
        const done = message(mode === 'summary' ? 'SYNTHETIC SUMMARY: decisions kept.' : 'DONE');
        stream.push({ type: 'start', partial: done });
        stream.push({ type: 'done', reason: 'stop', message: done });
      }
    })();
    return stream;
  } }));
  t.mock.method(require('../src/agents/pi/piProviders'), 'resolvePiModel', async () => model);
  const deps: PiSessionDeps = {
    bridge, preamble: 'Host prompt.', cwd: '/tmp', workspaceId: 'workspace', ownerUserId: null, enableFollowUps: false,
    requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', owner: chatOwner(id), profileHash: null,
    ...(initialMessages ? { initialMessages } : {}),
  };
  const session = new PiSdkSession(id, deps);
  t.after(() => session.dispose().catch(() => {}));
  return { session, deps, control, requests };
}

test('Pi compacts an idle session through the SDK and the next turn continues from the summary', async (t) => {
  const { session, deps, control, requests } = await fixture(t, 'pi-compact-idle', longHistory());
  control.mode = 'summary';
  // No turn has run in this process yet: compaction builds the harness first.
  const result = await session.compact('  Keep the decisions  ');
  assert.equal(result.started, true);
  assert.equal(result.completed, true, 'Pi compaction resolves on completion');
  assert.match(result.detail ?? '', /^Compacted the conversation from about [\d,]+ to about [\d,]+ tokens\.$/);
  assert.equal(requests.length, 1);
  assert(JSON.stringify(requests[0].context).includes('Keep the decisions'), 'custom instructions reach the summary request');
  assert.equal(requests[0].apiKey, 'synthetic-host-key', 'Michi credentials, not the SDK placeholder');
  const transcript = fs.readFileSync(path.join(piSdkSessionDirectory('pi-compact-idle', deps), 'session.jsonl'), 'utf8');
  assert(transcript.includes('"type":"compaction"') && transcript.includes('SYNTHETIC SUMMARY'));
  assert.equal(session.describeNativeState().status, 'idle');

  control.mode = 'answer';
  const events = await drain(session.send('Continue'));
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });
  const context = JSON.stringify(requests.at(-1)!.context.messages);
  assert(context.includes('SYNTHETIC SUMMARY'), 'the next request starts from the summary');
  assert.equal(context.includes('Synthetic 0:'), false, 'summarized messages left the model context');
  assert(context.includes('Synthetic 19:'), 'the recent tail is kept');
});

test('Pi declines compaction while a turn runs and leaves the turn untouched', async (t) => {
  const { session, control } = await fixture(t, 'pi-compact-busy', longHistory());
  const gate = deferred();
  control.gate = gate.promise;
  const turn = drain(session.send('Long task'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await session.compact();
  assert.deepEqual(result, { started: false, detail: 'Pi is still working on this conversation. Run /compact again after the current turn finishes.' });
  control.gate = undefined;
  gate.resolve();
  const events = await turn;
  assert(events.some((event) => event.kind === 'chunk' || event.kind === 'turn_end'));
  assert.deepEqual(events.at(-1), { kind: 'turn_end' });
});

test('Pi compaction failures report started:false and keep the session usable', async (t) => {
  const { session, control } = await fixture(t, 'pi-compact-fail', longHistory());
  control.mode = 'fail';
  const failed = await session.compact();
  assert.equal(failed.started, false);
  assert.match(failed.detail ?? '', /^Compaction failed: .*synthetic provider outage/);
  control.mode = 'answer';
  assert.deepEqual((await drain(session.send('Still works'))).at(-1), { kind: 'turn_end' });

  const small = await fixture(t, 'pi-compact-small');
  assert.deepEqual(await small.session.compact(), { started: false, detail: 'Compaction failed: Nothing to compact (session too small)' });
});

test('Pi compaction blocks turns, rejects a second compaction and can be cancelled', async (t) => {
  const { session, control } = await fixture(t, 'pi-compact-cancel', longHistory());
  control.mode = 'summary';
  const gate = deferred();
  control.gate = gate.promise;
  const running = session.compact();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.describeNativeState().status, 'compacting');
  await assert.rejects(drain(session.send('Too early')), /Pi is compacting this conversation/);
  assert.deepEqual(await session.compact(), { started: false, detail: 'Pi is already compacting this conversation.' });
  assert.equal((await session.cancel()).acknowledged, true);
  assert.deepEqual(await running, { started: false, detail: 'Compaction was cancelled.' });
  assert.equal(session.getHistory().some((message) => message.content === 'Too early'), false, 'the rejected send left no history');
  control.gate = undefined;
  const retried = await session.compact();
  assert.equal(retried.started, true);
  gate.resolve();
});

test('only the SDK engine offers manual compaction', async (t) => {
  assert.equal(PI_RUNTIME_DESCRIPTOR.harness.compact.availability, 'native');
  assert.equal(PI_CORE_RUNTIME_DESCRIPTOR.harness.compact.availability, 'invisible');
  const previous = process.env.MICHI_PI_SESSION_SDK;
  process.env.MICHI_PI_SESSION_SDK = '0';
  t.after(() => { if (previous === undefined) delete process.env.MICHI_PI_SESSION_SDK; else process.env.MICHI_PI_SESSION_SDK = previous; });
  const rollback = await createPiSession('pi-compact-rollback', {
    bridge, preamble: '', cwd: '/tmp', workspaceId: null, ownerUserId: null, enableFollowUps: false, owner: chatOwner('pi-compact-rollback'),
  });
  assert(rollback instanceof PiSession && !(rollback instanceof PiSdkSession));
  assert.equal((rollback as { compact?: unknown }).compact, undefined, 'ChatHub reports the agent-core rollback as unsupported');
  await (rollback as PiSession).dispose();
});
