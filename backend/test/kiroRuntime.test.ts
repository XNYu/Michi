import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { AgentToolBridge } from '../src/agents/toolBridge';
import type { AgentSession } from '../src/agents/types';
import type { ModelInfo } from '../src/agents/types';
import type { RuntimeModelCache } from '../src/agents/runtimeModelCache';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace } from '../src/services/dbRepository';

const bridge: AgentToolBridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('KiroRuntime warm session handoff', () => {
  test('newSession waits for matching inflight warm slot and consumes it', async () => {
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    const rt = runtime as any;

    rt.ensureClient = async () => ({});
    let coldSessionNewCalls = 0;
    rt.openSession = async () => {
      coldSessionNewCalls += 1;
      return { sid: `cold-${coldSessionNewCalls}` };
    };

    let replenishCalls = 0;
    rt.warmNextSession = () => {
      replenishCalls += 1;
    };

    let releaseWarm!: () => void;
    const warmLock = new Promise<void>((resolve) => {
      releaseWarm = () => {
        rt.warmedSessions.set('/tmp/a', {
          sid: 'warm-sid',
          currentModeId: 'mode-warm',
        });
        resolve();
      };
    });
    rt.warmSessionLocks.set('/tmp/a', warmLock);

    let resolved = false;
    const pending = runtime.newSession({ cwd: '/tmp/a', sessionId: 'node-1' }).then((session) => {
      resolved = true;
      return session;
    });
    await tick();
    assert.equal(resolved, false, 'newSession should wait for the inflight warm slot');

    releaseWarm();
    const session = await pending;
    assert.equal(session.id, 'node-1');
    assert.equal(session.nativeSessionId, 'warm-sid');
    assert.equal(session.currentModeId, 'mode-warm');
    assert.equal(coldSessionNewCalls, 0, 'warm handoff should avoid cold session/new');
    assert.equal(replenishCalls, 1, 'consuming a warm slot should schedule replenish');
  });

  test('newSession cold-opens when inflight warm finishes without a slot', async () => {
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
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
});
describe('KiroRuntime model catalog cache', () => {
  test('returns the disk snapshot immediately and replaces it after a live refresh', async () => {
    const cached: ModelInfo[] = [{ id: 'cached-kiro', label: 'Cached Kiro' }];
    let saved: ModelInfo[] | null = null;
    const cache: RuntimeModelCache = {
      load: () => cached,
      save: (_runtimeId, models) => { saved = models; },
    };
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default', cache);
    const rt = runtime as any;

    let resolveLive!: (value: any[]) => void;
    let liveCalls = 0;
    rt.getAvailableModels = async () => {
      liveCalls += 1;
      return new Promise<any[]>((resolve) => { resolveLive = resolve; });
    };

    const first = await runtime.listModels();
    assert.deepEqual(first, cached, 'cached models should not wait for session/new');
    assert.equal(liveCalls, 1, 'returning the snapshot should still start one refresh');

    resolveLive([{ modelId: 'fresh-kiro', name: 'Fresh Kiro', description: 'updated' }]);
  const fresh = await runtime.refreshModels();

  assert.deepEqual(fresh.map((m) => m.id), ['fresh-kiro']);
  assert.deepEqual(saved, fresh);
  });
});

describe('KiroRuntime node/native identity', () => {
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

      const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
      const rt = runtime as any;
      let loadedSid = '';
      rt.loadAcpSession = async ({ sessionId }: { sessionId: string }) => {
        loadedSid = sessionId;
        return { sid: sessionId };
      };

      const session = await runtime.loadSession({
        sessionId: 'node-1', nodeId: 'node-1', cwd: '/tmp/a', workspaceId: 'ws-1',
      });
      assert.equal(loadedSid, 'acp-session-1');
      assert.equal(session.id, 'node-1');
      assert.equal(session.nativeSessionId, 'acp-session-1');
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
    assert.deepEqual(events.find((event) => event.kind === 'branch_overview'), {
      kind: 'branch_overview',
      overview: 'Current Kiro branch state.',
    });
  });

  test('Kiro MCP callback injects the overview into the matching ACP session', () => {
    let injected: { sessionId: string; update: Record<string, unknown> } | null = null;
    const registry = {
      get: (slotId: string) => slotId === 'slot-overview'
        ? { parentChatId: 'kiro-session-a', cwd: '/tmp/a' }
        : undefined,
    } as any;
    const runtime = new KiroRuntime(bridge, registry, 0, '/tmp/default');
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
