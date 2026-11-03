import './isolatedConfigDir';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { PiSession } from '../src/agents/pi/PiSession';
import { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { CREW_KIRO_FLAVOR } from 'michi-runtime/internal/adapters/crew/crewFlavor';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions, getSession, getSessionForUser } from '../src/agents/sessionRegistry';
import { closeDb, initDb } from '../src/services/db';
import { michiTestHost } from './helpers/michiTestHost';
import { chatOwner } from './helpers/owners';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function setupPi(t: TestContext, nodes = new Map<string, any>()) {
  let reads = 0;
  configureRuntimeDeps({ dataDir: '/tmp', historyStore: {
    getNode: (id) => { reads++; return nodes.get(id) ?? null; },
    listMessages: (id) => [{ role: 'user', content: `history:${id}` }] as any,
    getWorkspace: () => null, getWorkspaceInstructions: () => null,
  }, agentConfig: {
    getAgentConfig: () => ({ runtime: 'pi', provider: 'test', modelByRuntime: {}, reasoningByRuntime: {} }),
    resolveModel: () => '', resolveReasoning: () => undefined,
  } });
  const runtime = new PiRuntime(bridge);
  t.after(async () => { await runtime.shutdown(); clearAllSessions(); __resetRuntimeDeps(); });
  return { runtime, reads: () => reads };
}

test('Pi reads a deep mixed-runtime ancestor chain as finite read-only history', async (t) => {
  const nodes = new Map<string, any>();
  for (let i = 0; i < 400; i++) nodes.set(`ancestor-${i}`, { parent_node_id: i ? `ancestor-${i - 1}` : null,
    workspace_id: 'workspace', runtime_id: ['kiro', 'claude', 'codex', 'pi'][i % 4] });
  const { runtime, reads } = setupPi(t, nodes);
  const session = await runtime.newSession({ sessionId: 'child', parentChatId: 'ancestor-399', cwd: '/tmp', ownerUserId: 'user-a' });
  assert(session instanceof PiSession);
  assert.equal((runtime as any).sessions.size, 1, 'history loading creates no hidden live Pi sessions');
  assert.equal(reads(), 400, 'each ancestor is read once without recursive runtime construction');
  const parent = getSession('ancestor-0');
  assert.equal(parent?.runtimeId, 'stub');
  await assert.rejects(async () => { for await (const event of parent!.send('must never run')) void event; }, /read-only/);
  const previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  try {
    assert.equal(getSessionForUser('child', 'user-a'), session);
    assert.equal(getSessionForUser('child', 'user-b'), null);
    assert.equal(getSessionForUser('ancestor-0', 'user-a'), null, 'internal history stubs never become user-facing live sessions');
  } finally { if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud; }
});

test('Pi ancestor cycles terminate without constructing recursive live sessions', async (t) => {
  const { runtime, reads } = setupPi(t, new Map([
    ['a', { parent_node_id: 'b' }], ['b', { parent_node_id: 'a' }],
  ]));
  await runtime.newSession({ sessionId: 'child', parentChatId: 'a', cwd: '/tmp' });
  assert.equal(reads(), 2);
  assert.equal((runtime as any).sessions.size, 1);
});

test('Pi joins pending acquire, rejects owner/profile reuse, and release waits for creation', async (t) => {
  const { runtime } = setupPi(t);
  const gate = deferred<void>();
  let creates = 0;
  t.mock.method(require('../src/agents/pi/PiSdkSession'), 'createPiSession', async (id: string, deps: any) => {
    creates++; await gate.promise; return new PiSession(id, deps);
  });
  const opts = { sessionId: 'node', cwd: '/tmp', owner: chatOwner('node'), profileHash: 'hash' };
  const a = runtime.newSession(opts);
  const b = runtime.newSession(opts);
  const badOwner = assert.rejects(runtime.newSession({ ...opts, owner: chatOwner('other') }), /different owner/);
  const badProfile = assert.rejects(runtime.newSession({ ...opts, profileHash: 'other' }), /profile hash mismatch/);
  const releasing = runtime.releaseSession('node', opts.owner);
  gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  await Promise.all([badOwner, badProfile, releasing]);
  assert.equal(first, second);
  assert.equal(creates, 1);
  assert.equal(getSession('node'), undefined, 'release during creation removes the eventual session');
  const replacement = await runtime.newSession(opts);
  assert.notEqual(replacement, first);
});

for (const runtimeId of ['kiro', 'crew'] as const) {
  test(`${runtimeId} chat preserves bootstrap and exact branch context in the actual first prompt`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-bootstrap-'));
    const previousDataDir = process.env.MICHI_DATA_DIR;
    process.env.MICHI_DATA_DIR = root; closeDb(); initDb();
    const prompts: string[] = [];
    const runtime = new AcpAgentRuntime({ bridge, defaultCwd: '/tmp',
      host: michiTestHost(), id: runtimeId, engine: 'v2', sidecarTitles: false, ...(runtimeId === 'crew' ? { flavor: CREW_KIRO_FLAVOR } : {}) });
    const client = {
      async *prompt(_sid: string, text: string) { prompts.push(text); yield { type: 'text' as const, text: 'answer' }; },
      getSessionState: () => ({ status: 'idle' }),
      cancel: async () => {}, destroySession() {},
    };
    const rt = runtime as any;
    rt.ensureClient = async () => client;
    rt.getClient = () => client;
    rt.warmNextSession = () => {};
    rt.openSession = async () => ({ sid: `${runtimeId}-native` });
    try {
      const options = { sessionId: `${runtimeId}-child`, cwd: '/tmp', enableFollowUps: false,
        bootstrapInstructions: 'PRIMARY_AGENT_INSTRUCTIONS', parentChatId: 'unavailable-parent',
        branchContext: { parentNodeId: 'unavailable-parent', kind: 'exact' as const, boundaryMessageId: 'cut', messages: [
          { role: 'user' as const, content: 'EXACT_PREFIX_ONLY' },
        ] } };
      const [a, b] = await Promise.all([runtime.newSession(options), runtime.newSession(options)]);
      assert.equal(a, b, 'same-id acquire joins actual Kiro Session creation');
      for await (const event of a.send('QUESTION')) void event;
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /PRIMARY_AGENT_INSTRUCTIONS/);
      assert.match(prompts[0], /EXACT_PREFIX_ONLY/);
      assert.match(prompts[0], /QUESTION/);
      assert.equal(a.getHistory()[0].content, 'QUESTION', 'bootstrap stays model-facing');
      await assert.rejects(runtime.newSession({ ...options, profileHash: 'different' }), /profile hash mismatch/);
    } finally {
      await runtime.shutdown(); closeDb();
      if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a stale release does not poison the real owner release queued behind it', async (t) => {
  const { runtime } = setupPi(t);
  const owner = chatOwner('node');
  await runtime.newSession({ sessionId: 'node', cwd: '/tmp', owner });
  const stale = assert.rejects(runtime.releaseSession('node', chatOwner('different')), /Owner mismatch/);
  const legitimate = runtime.releaseSession('node', owner);
  await Promise.all([stale, legitimate]);
  assert.equal(getSession('node'), undefined);
});

test('Pi release waits for real session MCP retirement before the same id can be acquired', async (t) => {
  const { runtime } = setupPi(t);
  const owner = chatOwner('node');
  const options = { sessionId: 'node', cwd: '/tmp', owner };
  const session = await runtime.newSession(options);
  const cleanup = deferred<void>();
  let disposeStarted = false;
  (session as any).mcpManager = { dispose: async () => { disposeStarted = true; await cleanup.promise; } };
  let releaseSettled = false;
  const release = runtime.releaseSession('node', owner).then(() => { releaseSettled = true; });
  let replacementSettled = false;
  const acquiring = runtime.newSession(options).then((value) => { replacementSettled = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposeStarted, true);
  assert.equal(releaseSettled, false);
  assert.equal(replacementSettled, false);
  assert.equal(getSession('node'), session);
  cleanup.resolve();
  await release;
  assert.notEqual(await acquiring, session);
});

test('a stale owner release cannot erase an earlier native cleanup failure', async () => {
  const { PendingSessionAcquisitions } = require('../src/agents/sessionAcquisition') as typeof import('../src/agents/sessionAcquisition');
  const acquisitions = new PendingSessionAcquisitions<object>();
  const cleanupFailure = new Error('native cleanup failed');
  await assert.rejects(acquisitions.release('id', () => { throw cleanupFailure; }), /native cleanup failed/);
  const staleOwner = Object.assign(new Error('wrong owner'), { code: 'SESSION_OWNER_MISMATCH' });
  await assert.rejects(acquisitions.release('id', () => { throw staleOwner; }), /wrong owner/);
  let created = false;
  await assert.rejects(acquisitions.acquire('id', async () => { created = true; return {}; }, (value) => value), /native cleanup failed/);
  assert.equal(created, false);
  await acquisitions.release('id', () => {});
  await acquisitions.acquire('id', async () => { created = true; return {}; }, (value) => value);
  assert.equal(created, true, 'a confirmed successful cleanup retires the tombstone');
});

test('Pi refuses a retained session whose disposal has started', async (t) => {
  const { runtime } = setupPi(t);
  const session = await runtime.newSession({ sessionId: 'disposed', cwd: '/tmp' }) as PiSession;
  await session.dispose();
  await assert.rejects(runtime.newSession({ sessionId: 'disposed', cwd: '/tmp' }), /disposed/);
});
