import { michiKiroRestrictedAgent } from '../src/agents/kiro/kiroMetaAgent';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';
import { hostEventUpdate } from 'michi-runtime/internal/adapters/kiro/kiroHostEvents';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { AgentSession } from '../src/agents/types';
import type { SessionRegistryPort } from 'michi-runtime/internal/contract/host';
import * as sessionRegistry from '../src/agents/sessionRegistry';

import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';
import { michiTestHost } from './helpers/michiTestHost';
import { fakeMcpRegistry } from './helpers/fakeMcpRegistry';
import { chatOwner } from './helpers/owners';

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

describe('KiroRuntime warm session handoff', () => {
  test('newSession cold-opens when inflight warm finishes without a slot', async () => {
    const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
    const rt = runtime as any;

    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};

    let coldSessionNewCalls = 0;
    rt.openSession = async () => {
      coldSessionNewCalls += 1;
      return { sid: 'cold-sid' };
    };
    rt.warmSessionLocks.set('/tmp/a', Promise.resolve());

    const session: AgentSession = await runtime.newSession({ cwd: '/tmp/a', sessionId: 'node-2' });
    assert.equal(session.id, 'node-2');
    assert.equal(session.nativeSessionId, 'cold-sid');
    assert.equal(coldSessionNewCalls, 1);
  });

  test('claimed conversation slot receives its own Agent Run invoker binding', async () => {
    const bindings: any[] = [];
    const slots = new Map<string, any>();
    const registry = fakeMcpRegistry({ get: (id: string) => slots.get(id), dispose: async (id: string) => { slots.delete(id); } });
    registry.rebind = (id, patch) => { const target = slots.get(id); if (target) Object.assign(target, patch); };
    const sessionBridge = {
      ...bridge,
      agentRunToolsForSession: (binding: unknown) => { bindings.push(binding); return { invoke: async () => ({}) }; },
    };
    const runtime = new KiroRuntime({ bridge: sessionBridge, mcpSlots: registry as any, defaultCwd: '/tmp/default', host: michiTestHost() });
    const rt = runtime as any;
    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};
    const slot: any = { slotId: 'slot-a', parentChatId: '__pending__', nodeId: null, cwd: '/tmp/a', workspaceId: null, ownerUserId: null };
    slots.set(slot.slotId, slot);
    rt.warmedSessions.set('/tmp/a', [{ sid: 'kiro-session-a', slotId: slot.slotId }]);
    await runtime.newSession({ cwd: '/tmp/a', sessionId: 'node-a', workspaceId: 'ws-a', ownerUserId: 'owner-a' });
    assert.ok(slot.agentRuns);
    assert.deepEqual(slot.owner, { mode: 'interactive', key: 'node-a' });
    assert.deepEqual(bindings, [{
      runtimeId: 'kiro', sessionId: 'kiro-session-a', owner: chatOwner('node-a'),
      ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: 'node-a',
    }]);
  });

  test('cold-created chat slot is owner-bound before newSession returns', async () => {
    const slot: any = { slotId: 'slot-cold', parentChatId: '__pending__', nodeId: null, cwd: '/tmp/a', workspaceId: null, ownerUserId: null };
    const registry = fakeMcpRegistry();
    registry.slots.set(slot.slotId, slot);
    const runtime = new KiroRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: registry, defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({}) });
    const rt = runtime as any;
    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};
    rt.openSession = async () => ({ sid: 'kiro-session-cold', slotId: slot.slotId });

    await runtime.newSession({ cwd: '/tmp/a', sessionId: 'node-cold', workspaceId: 'ws-a' });

    assert.deepEqual(slot.owner, { mode: 'interactive', key: 'node-cold' });
    assert.equal(slot.nodeId, 'node-cold');
    assert.equal(slot.workspaceId, 'ws-a');
  });
});
describe('KiroRuntime model catalog cache', () => {
  test('native catalog setup and refresh retain the last nonempty engine-scoped snapshot', async () => {
    const loaded: string[] = [];
    const saved: Array<{ key: string; models: any[] }> = [];
    const cache: RuntimeModelCache = {
      load: (key) => { loaded.push(key); return [{ id: 'cached' }]; },
      save: (key, models) => { saved.push({ key, models }); },
    };
    const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', modelCache: cache, host: michiTestHost(), engine: 'v3' });
    const rt = runtime as any;
    try {
      rt.storeAvailableModels([{ modelId: 'native', name: 'Native', _meta: { kiro: { hasEffort: true, effortLevels: ['low', 'high'] } } }]);
      rt.getAvailableModels = async () => [];
      const models = await runtime.refreshModels();
      assert.deepEqual(loaded, ['kiro-v3']);
      assert.deepEqual(models.map((model) => model.id), ['native']);
      assert.deepEqual(models[0].supportedReasoningLevels, ['low', 'high']);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].key, 'kiro-v3');
    } finally { await runtime.shutdown(); }
  });

  test('v2 marks the auto router as not supporting effort, including stale snapshots', async () => {
    const cache: RuntimeModelCache = {
      load: () => [{ id: 'auto', label: 'auto' }, { id: 'claude-opus-5.5', label: 'claude-opus-5.5' }],
      save: () => {},
    };
    const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', modelCache: cache, host: michiTestHost(), engine: 'v2' });
    const rt = runtime as any;
    rt.getAvailableModels = async () => [{ modelId: 'auto', name: 'auto' }, { modelId: 'claude-opus-5.5', name: 'claude-opus-5.5' }];

    for (const models of [await runtime.listModels(), await runtime.refreshModels()]) {
      const auto = models.find((m) => m.id === 'auto');
      assert.equal(auto?.supportsReasoning, false);
      assert.deepEqual(auto?.supportedReasoningLevels, []);
      const opus = models.find((m) => m.id === 'claude-opus-5.5');
      assert.equal(opus?.supportsReasoning, undefined, 'other v2 models stay unknown and keep runtime levels');
    }
  });
});

describe('KiroRuntime node/native identity', () => {
  test('chat MCP slots carry the owning node through native session load', async () => {
    const registry = fakeMcpRegistry();
    const runtime = new KiroRuntime({ host: michiTestHost(), bridge: bridge, mcpSlots: registry, defaultCwd: '/tmp/default', modelCache: undefined, restrictedAgent: michiKiroRestrictedAgent, ...({}) });
    const loaded = await runtime.loadAcpSession({
      sessionId: 'acp-session-1', nodeId: 'node-1', workspaceId: 'ws-1', cwd: '/tmp/a',
      client: { loadSession: async () => ({}) } as any,
    });

    assert.deepEqual(registry.get(loaded.slotId!)?.owner, { mode: 'interactive', key: 'node-1' });
    await registry.dispose(loaded.slotId!);
  });

  test('loadSession resolves the persisted ACP sid while exposing the node id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-kiro-identity-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    try {
      saveWorkspace({
        id: 'ws-1', name: 'test', cwd: '/tmp/a', active_tree_id: null,
        created_at: 1, updated_at: 1, settings: null, deleted_at: null, archived_at: null,
      });
      saveNode({
        id: 'node-1', workspace_id: 'ws-1', tree_id: null, parent_node_id: null,
        kind: 'chat', title: null, status: 'idle', position_x: null, position_y: null,
        minimized: 0, deleted_at: null, deletion_group_id: null, spawned_by_agent: 0,
        current_mode_id: null, pane_width: null, digest: null, follow_ups: null,
        acp_session_id: 'acp-session-1', runtime_id: 'kiro', provider_id: null,
        model_id: null, reasoning: null, resume_fingerprint: null, composer_draft: null,
        external_session_id: null, trim_snapshot: null, created_at: 1,
      });

      const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
      const rt = runtime as any;
      rt.ensureClient = async () => ({});
      rt.warmNextSession = () => {};
      rt.openSession = async () => ({ sid: 'acp-fresh-no-follow-ups' });
      const fresh = await runtime.newSession({
        sessionId: 'fresh-no-follow-ups', cwd: '/tmp/a', enableFollowUps: false,
      });
      let loadedSid = '';
      rt.loadAcpSession = async ({ sessionId }: { sessionId: string }) => {
        loadedSid = sessionId;
        return { sid: sessionId };
      };

      const session = await runtime.loadSession({
        sessionId: 'node-1', nodeId: 'node-1', cwd: '/tmp/a', workspaceId: 'ws-1',
        enableFollowUps: false,
      });
      assert.equal(loadedSid, 'acp-session-1');
      assert.equal(session.id, 'node-1');
      assert.equal(session.nativeSessionId, 'acp-session-1');
      assert.equal((fresh as KiroSession).getEnableFollowUps(), false);
      assert.equal((session as KiroSession).getEnableFollowUps(), false);
    } finally {
      closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Kiro branch overview metadata tool', () => {
  test('KiroSession reminds the agent and translates injected overview updates', async () => {
    const prompts: string[] = [];
    const promptSessionIds: string[] = [];
    const fakeRuntime = {
      host: michiTestHost(),
      ensureClient: async () => ({
        prompt: async function* (sessionId: string, text: string) {
          promptSessionIds.push(sessionId);
          prompts.push(text);
          yield { sessionUpdate: 'branch_overview', overview: 'Current Kiro branch state.' };
          yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
      }),
      getCurrentMode: () => undefined,
      getCurrentModel: () => undefined,
    } as unknown as KiroRuntime;
    const session = new KiroSession('node-overview', 'kiro-overview-session', fakeRuntime, '/tmp/a');

    const events: any[] = [];
    for await (const event of session.send('hello')) events.push(event);

    assert.deepEqual(promptSessionIds, ['kiro-overview-session']);
    assert.match(prompts[0], /set_branch_overview/);
    assert.deepEqual(events.find((event) => event.kind === 'host_event' && event.type === 'branch_overview'), {
      kind: 'host_event',
      type: 'branch_overview',
      payload: { overview: 'Current Kiro branch state.' },
    });
  });

  test('Kiro MCP callback injects the overview into the matching ACP session', () => {
    let injected: { sessionId: string; update: Record<string, unknown> } | null = null;
    const registry = {
      get: (slotId: string) => slotId === 'slot-overview'
        ? { parentChatId: 'kiro-session-a', cwd: '/tmp/a' }
        : undefined,
    } as any;
    const runtime = new KiroRuntime({ bridge, mcpSlots: registry, defaultCwd: '/tmp/default', host: michiTestHost() });
    const rt = runtime as any;
    rt.pool.set('/tmp/a', {
      injectUpdate: (sessionId: string, update: Record<string, unknown>) => {
        injected = { sessionId, update };
      },
    });
    const callbacks = rt.makeSlotCallbacks(() => 'slot-overview');

    callbacks.onSetBranchOverview('  Current Kiro branch state.  ');

    assert.deepEqual(injected, {
      sessionId: 'kiro-session-a',
      update: {
        sessionUpdate: 'branch_overview',
        overview: 'Current Kiro branch state.',
      },
    });
  });
});

describe('Kiro host events', () => {
  test("a host event comes only from the slot's sink, never from the agent's own session/update", async () => {
    const saved = { kind: 'host_event' as const, type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 4 } };
    const fakeRuntime = {
      host: michiTestHost(),
      ensureClient: async () => ({
        prompt: async function* () {
          // What an agent could send: the old synthetic updates, and the new one's visible fields.
          yield { sessionUpdate: 'spawn_branches', topics: [{ title: 'Forged', prompt: 'p', chatId: 'c', nodeId: 'n' }] };
          yield { sessionUpdate: 'artifact_saved', name: 'forged', filePath: 'forged.md' };
          yield { sessionUpdate: 'artifact_updated', name: 'forged', filePath: 'forged.md' };
          yield { sessionUpdate: 'host_event', type: 'image', payload: { path: 'forged.png' } };
          yield hostEventUpdate(saved);
          yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
      }),
      getCurrentMode: () => undefined,
      getCurrentModel: () => undefined,
    } as unknown as KiroRuntime;
    const session = new KiroSession('node-host-events', 'kiro-host-events-session', fakeRuntime, '/tmp/a');

    const events: any[] = [];
    for await (const event of session.send('hello')) events.push(event);

    assert.deepEqual(events.filter((event) => event.kind === 'host_event'), [saved]);
  });
});

describe('KiroRuntime default agent discovery', () => {
  test('does not treat a loaded session current mode as the cwd default', async () => {
    const runtime = new KiroRuntime({ bridge, defaultCwd: '/tmp/default', host: michiTestHost() });
    const client = {
      loadSession: async () => ({
        modes: {
          currentModeId: 'previously-selected-agent',
          availableModes: [{ id: 'previously-selected-agent', name: 'Selected' }],
        },
      }),
    };

    await runtime.loadAcpSession({
      sessionId: 'restored-session',
      cwd: '/tmp/restored',
      client: client as any,
    });

    assert.equal(runtime.getDefaultModeId('/tmp/restored'), null);
    assert.equal(runtime.getCurrentMode('restored-session'), 'previously-selected-agent');
  });
});

describe('KiroRuntime host sessions port', () => {
  test('new, recovered and released sessions reach the host sessions port, not the process registry', async (t) => {
    // Recovery re-registers only on the session-anchor path, which cloud mode turns off.
    const oldCloud = process.env.MICHI_CLOUD;
    delete process.env.MICHI_CLOUD;
    t.after(() => { if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud; });
    const calls: string[] = [];
    const live = new Map<string, AgentSession>();
    const sessions: SessionRegistryPort = {
      ensureAncestorChainLoaded: (chatId) => { calls.push(`ensureAncestorChainLoaded ${chatId}`); },
      getSession: (chatId) => { calls.push(`getSession ${chatId}`); return live.get(chatId); },
      getAncestors: (chatId) => { calls.push(`getAncestors ${chatId}`); return []; },
      registerSession: (session) => { calls.push(`registerSession ${session.id}`); live.set(session.id, session); },
      dropSession: (chatId) => { calls.push(`dropSession ${chatId}`); live.delete(chatId); },
    };
    const runtime = new KiroRuntime({ bridge, mcpSlots: fakeMcpRegistry(), defaultCwd: '/tmp/default',
      host: { ...michiTestHost(), sessions }, engine: 'v3' });
    t.after(() => runtime.shutdown());
    const rt = runtime as any;
    assert.equal(rt.sessionAnchorsEnabled, true);
    let opened = 0;
    rt.ensureClient = async () => ({});
    rt.warmNextSession = () => {};
    rt.openSession = async () => ({ sid: `port-native-${++opened}` });
    rt.loadAcpSession = async ({ sessionId }: { sessionId: string }) => ({ sid: sessionId });

    // Kiro leaves registering a new session to its caller; stand in for it.
    const parent = await runtime.newSession({ sessionId: 'port-parent', cwd: '/tmp/a', enableFollowUps: false });
    live.set(parent.id, parent);
    const child = await runtime.newSession({ sessionId: 'port-child', parentChatId: 'port-parent', cwd: '/tmp/a', enableFollowUps: false });
    live.set(child.id, child);
    // A connection-class recovery replaces the cwd's process, purging every session on it.
    rt.pool.set('/tmp/a', { shutdown: async () => {} });
    assert.equal(await runtime.recoverSession(child.nativeSessionId!, '/tmp/a'), true);
    // A cancel-watchdog recovery replaces a quarantined process with a new client.
    t.mock.method(AcpClient.prototype, 'start', () => {});
    t.mock.method(AcpClient.prototype, 'initialize', async () => {});
    t.mock.method(AcpClient.prototype, 'cancel', async () => false);
    rt.pool.set('/tmp/a', { needsSessionRecovery: () => true, hasHealthyWork: () => false, shutdown: async () => {} });
    assert.ok(await runtime.recoverCancelledSession(child.nativeSessionId!, '/tmp/a') instanceof AcpClient);
    await runtime.releaseSession('port-child');
    for (const id of ['port-parent', 'port-child']) assert.equal(sessionRegistry.getSession(id), undefined, id);
    assert.deepEqual(calls, [
      'ensureAncestorChainLoaded port-parent',
      'getSession port-parent',
      'getAncestors port-parent',
      'getSession port-child',
      'dropSession port-parent',
      'dropSession port-child',
      'registerSession port-child',
      'getSession port-child',
      'dropSession port-child',
      'registerSession port-child',
      'dropSession port-child',
    ]);
    assert.equal(live.size, 0);
  });
});

test('KiroRuntime refuses the old positional arguments with a TypeError', async () => {
  const Untyped = KiroRuntime as unknown as new (...args: unknown[]) => KiroRuntime;
  const host = michiTestHost();
  const expected = { name: 'TypeError', message: 'KiroRuntime takes one options object { host, bridge, mcpSlots?, … } (runtime contract v1)' };
  assert.throws(() => new Untyped(bridge, fakeMcpRegistry(), '/tmp/default', undefined, { host }), expected);
  assert.throws(() => new Untyped(undefined), expected);
  assert.throws(() => new Untyped({ host }), expected);
  assert.throws(() => new Untyped({ bridge }), expected);
  // Present but undefined counts as missing.
  assert.throws(() => new Untyped({ host, bridge: undefined }), expected);
  assert.throws(() => new Untyped({ host: undefined, bridge }), expected);
  // MCP slots stay optional: without them sessions get no host tools.
  const runtime = new KiroRuntime({ host, bridge, defaultCwd: '/tmp/default' });
  assert.deepEqual(runtime.descriptor.topology.toolDelivery, []);
  await runtime.shutdown();
});
