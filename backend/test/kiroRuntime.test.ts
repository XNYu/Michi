import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { KiroSession } from '../src/agents/kiro/KiroSession';
import { CursorRuntime } from '../src/agents/cursor/CursorRuntime';
import { GrokRuntime } from '../src/agents/grok/GrokRuntime';
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

describe('ACP runtime capabilities + MCP attach per profile', () => {
  test('Kiro keeps saveContext/spawnBranches/nativeResume/modes', () => {
    const runtime = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    assert.equal(runtime.capabilities.modes, true);
    assert.equal(runtime.capabilities.saveContext, true);
    assert.equal(runtime.capabilities.spawnBranches, true);
    assert.equal(runtime.capabilities.nativeResume, true);
    assert.equal(runtime.shouldSendBranchOverviewReminder(), true);
  });

  test('Cursor/Grok start with confirmed save/spawn/resume; Cursor modes on, Grok modes off', () => {
    const cursor = new CursorRuntime(bridge, undefined, 0, '/tmp/default');
    const grok = new GrokRuntime(bridge, undefined, 0, '/tmp/default');
    for (const runtime of [cursor, grok]) {
      assert.equal(runtime.capabilities.saveContext, true);
      assert.equal(runtime.capabilities.spawnBranches, true);
      assert.equal(runtime.capabilities.nativeResume, true);
      assert.equal(runtime.shouldSendBranchOverviewReminder(), false);
    }
    assert.equal(cursor.capabilities.modes, true);
    assert.equal(grok.capabilities.modes, false);
  });

  test('Kiro openSession still attaches MCP without initialize advertisement', async () => {
    let created = 0;
    const registry = {
      create: () => {
        created += 1;
        return { slotId: 'slot-k' };
      },
      dispose: async () => {},
      get: () => undefined,
    } as any;
    const runtime = new KiroRuntime(bridge, registry, 3000, '/tmp/default');
    const rt = runtime as any;
    let mcpServers: unknown[] | undefined;
    const client = {
      getInitializeResult: () => ({}),
      newSession: async (mcp: unknown[]) => {
        mcpServers = mcp;
        return { sessionId: 'sid-k' };
      },
    };
    const opened = await rt.openSession(client, '/tmp/a', () => ({}));
    assert.equal(created, 1);
    assert.equal(opened.slotId, 'slot-k');
    assert.equal((mcpServers as any[])[0].name, 'michi');
    assert.equal((mcpServers as any[])[0].type, 'http');
  });

  test('Cursor/Grok openSession attach MCP even without initialize advertisement', async () => {
    let created = 0;
    const registry = {
      create: () => {
        created += 1;
        return { slotId: 'slot-c' };
      },
      dispose: async () => {},
      get: () => undefined,
    } as any;
    const runtime = new CursorRuntime(bridge, registry, 3000, '/tmp/default');
    const rt = runtime as any;
    let mcpServers: unknown[] | undefined;
    const silent = {
      getInitializeResult: () => ({ agentCapabilities: {} }),
      newSession: async (mcp: unknown[]) => {
        mcpServers = mcp;
        return { sessionId: 'sid-c' };
      },
    };
    const opened = await rt.openSession(silent, '/tmp/a', () => ({}));
    assert.equal(created, 1);
    assert.equal(opened.slotId, 'slot-c');
    assert.equal((mcpServers as any[])[0].name, 'michi');
    assert.equal((mcpServers as any[])[0].type, 'http');
  });

  test('initialize still stores result but does not hide Cursor spawn/save/resume', () => {
    const runtime = new CursorRuntime(bridge, undefined, 0, '/tmp/default');
    const rt = runtime as any;
    assert.equal(runtime.capabilities.nativeResume, true);
    assert.equal(runtime.capabilities.saveContext, true);
    assert.equal(runtime.capabilities.spawnBranches, true);
    rt.applyInitializeResult({
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true },
      },
    });
    assert.equal(runtime.capabilities.nativeResume, true);
    assert.equal(runtime.capabilities.saveContext, true);
    assert.equal(runtime.capabilities.spawnBranches, true);
    const kiro = new KiroRuntime(bridge, undefined, 0, '/tmp/default');
    (kiro as any).applyInitializeResult({ agentCapabilities: { loadSession: false } });
    assert.equal(kiro.capabilities.nativeResume, true, 'Kiro capabilities stay construction-time');
  });

  test('MCP slot callbacks keep the Kiro sentinel and label; Cursor/Grok omit the sentinel', () => {
    const kiro = new KiroRuntime(bridge, undefined, 0, '/tmp/default') as any;
    const cursor = new CursorRuntime(bridge, undefined, 0, '/tmp/default') as any;
    const grok = new GrokRuntime(bridge, undefined, 0, '/tmp/default') as any;
    const kiroCbs = kiro.makeSlotCallbacks(() => 'slot-k');
    const cursorCbs = cursor.makeSlotCallbacks(() => 'slot-c');
    const grokCbs = grok.makeSlotCallbacks(() => 'slot-g');
    assert.equal(kiroCbs.metadataDoneSentinel, '[MICHI_METADATA_DONE]');
    assert.equal(cursorCbs.metadataDoneSentinel, undefined);
    assert.equal(grokCbs.metadataDoneSentinel, undefined);
    assert.deepEqual(kiroCbs.onShowImage('/tmp/x.png'), {
      error: 'show_image is not supported on the Kiro runtime',
    });
    assert.deepEqual(cursorCbs.onShowImage('/tmp/x.png'), {
      error: 'show_image is not supported on the Cursor runtime',
    });
    assert.deepEqual(grokCbs.onShowImage('/tmp/x.png'), {
      error: 'show_image is not supported on the Grok runtime',
    });
  });

  test('absorbModes upgrades Grok capabilities.modes when session/new returns availableModes', () => {
    const grok = new GrokRuntime(bridge, undefined, 0, '/tmp/default');
    assert.equal(grok.capabilities.modes, false);
    (grok as any).absorbModes({ availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' });
    assert.equal(grok.capabilities.modes, true);
    assert.equal((grok as any).globalAvailableModes[0].id, 'agent');
  });
});

describe('ACP MCP tool-result backfill', () => {
  test('slot callback forwards the real MCP result to the live ACP client', () => {
    let backfilled: { sessionId: string; result: unknown } | null = null;
    const registry = {
      get: (slotId: string) => slotId === 'slot-mcp'
        ? { parentChatId: 'acp-sid-1', cwd: '/tmp/a' }
        : undefined,
    } as any;
    const runtime = new KiroRuntime(bridge, registry, 0, '/tmp/default');
    const rt = runtime as any;
    rt.pool.set('/tmp/a', {
      backfillToolOutput: (sessionId: string, result: unknown) => {
        backfilled = { sessionId, result };
        return true;
      },
    });
    const callbacks = rt.makeSlotCallbacks(() => 'slot-mcp');
    callbacks.onMcpToolResult('list_threads', { content: [{ type: 'text', text: '{"ok":true}' }] });
    assert.deepEqual(backfilled, {
      sessionId: 'acp-sid-1',
      result: { content: [{ type: 'text', text: '{"ok":true}' }] },
    });
  });

  test('does not invent a backfill when the slot is still pending', () => {
    let called = 0;
    const registry = {
      get: () => ({ parentChatId: '__pending__', cwd: '/tmp/a' }),
    } as any;
    const runtime = new KiroRuntime(bridge, registry, 0, '/tmp/default');
    const rt = runtime as any;
    rt.pool.set('/tmp/a', {
      backfillToolOutput: () => { called += 1; return false; },
    });
    const callbacks = rt.makeSlotCallbacks(() => 'slot-pending');
    callbacks.onMcpToolResult('list_threads', { content: [] });
    assert.equal(called, 0);
  });
});
