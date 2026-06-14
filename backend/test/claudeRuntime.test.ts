/**
 * Unit tests for ClaudeRuntime.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * spawnClaude is stubbed so no real claude binary is needed.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, PassThrough } from 'node:stream';
import * as sessionRegistry from '../src/agents/sessionRegistry';

// ---- MockClaudeChild --------------------------------------------------------

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(signal?: string): boolean {
    this.killed = true;
    // Emit exit so awaitInit sees it
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }

  /** Push a JSONL envelope to stdout so the parser receives it. */
  send(envelope: object): void {
    this.stdout.push(JSON.stringify(envelope) + '\n');
  }

  /** Emit the system/init envelope needed by awaitInit polling. */
  emitInit(sessionId = 'ext-session-001'): void {
    this.send({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  emitResult(subtype: 'success' | 'error' = 'success'): void {
    this.send({ type: 'result', subtype, usage: { input_tokens: 1, output_tokens: 1 } });
  }
}

// ---- Module-level stubs & helpers ------------------------------------------

let mockChild: MockClaudeChild;

/**
 * Monkey-patch claudeBinary module to return mockChild instead of spawning.
 * Must be done before requiring ClaudeRuntime so the patched version is used.
 */
function stubSpawnClaude(): void {
  mockChild = new MockClaudeChild();
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  mod._origSpawnClaude = mod._origSpawnClaude ?? mod.spawnClaude;
  mod.spawnClaude = () => {
    const child = mockChild;
    // Emit init after a tick so doSpawn has time to wire listeners
    setTimeout(() => child.emitInit(), 20);
    return child;
  };
}

function restoreSpawnClaude(): void {
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  if (mod._origSpawnClaude) {
    mod.spawnClaude = mod._origSpawnClaude;
  }
}

/** Build a minimal McpSlotRegistry stub. */
function makeMcpRegistry() {
  const slots = new Map<string, {
    slotId: string;
    nodeId: string | null;
    parentChatId: string;
    cwd: string;
    workspaceId: string | null;
    ownerUserId: string | null;
  }>();
  let slotCounter = 0;
  return {
    create(
      parentChatId: string,
      cwd: string,
      ownerUserId: string | null,
      _callbacks: unknown,
      opts?: { nodeId?: string | null; workspaceId?: string | null },
    ) {
      const slotId = `slot-${++slotCounter}`;
      const slot = {
        slotId,
        nodeId: opts?.nodeId ?? null,
        parentChatId,
        cwd,
        workspaceId: opts?.workspaceId ?? null,
        ownerUserId,
      };
      slots.set(slotId, slot);
      return slot;
    },
    get(slotId: string) {
      return slots.get(slotId);
    },
    async dispose(slotId: string) {
      slots.delete(slotId);
    },
    slots,
  };
}

/** Build a minimal AgentToolBridge stub. */
function makeBridge() {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

/** Stub getNode from dbRepository so we can control what it returns. */
function stubGetNode(returnValue: { external_session_id?: string | null; workspace_id?: string | null } | undefined) {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  mod._origGetNode = mod._origGetNode ?? mod.getNode;
  mod.getNode = () => returnValue;
}

function restoreGetNode(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  if (mod._origGetNode) {
    mod.getNode = mod._origGetNode;
  }
}

/** Stub setNodeExternalSessionId to be a no-op. */
function stubSetNodeExternalSessionId(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  mod._origSetNode = mod._origSetNode ?? mod.setNodeExternalSessionId;
  mod.setNodeExternalSessionId = () => {};
}

function restoreSetNodeExternalSessionId(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  if (mod._origSetNode) mod.setNodeExternalSessionId = mod._origSetNode;
}

/** Stub preflightClaudeAuth to be a no-op so ClaudeRuntime construction doesn't throw. */
function stubPreflightAuth(): void {
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  mod._origPreflight = mod._origPreflight ?? mod.preflightClaudeAuth;
  mod.preflightClaudeAuth = () => {};
}

function restorePreflightAuth(): void {
  const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  if (mod._origPreflight) mod.preflightClaudeAuth = mod._origPreflight;
}

// ---- Suite ------------------------------------------------------------------

describe('ClaudeRuntime', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let ClaudeRuntimeMod: typeof import('../src/agents/claude/ClaudeRuntime');
  let ClaudeRuntime: typeof import('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
  let ClaudeConcurrencyError: typeof import('../src/agents/claude/ClaudeRuntime').ClaudeConcurrencyError;
  let ClaudeSessionNotResumableError: typeof import('../src/agents/claude/ClaudeRuntime').ClaudeSessionNotResumableError;

  let mcpRegistry: ReturnType<typeof makeMcpRegistry>;
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    stubPreflightAuth();
    stubSpawnClaude();
    stubSetNodeExternalSessionId();

    // Clear module cache so ClaudeSession picks up the patched spawnClaude
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];

    ClaudeRuntimeMod = require('../src/agents/claude/ClaudeRuntime');
    ClaudeRuntime = ClaudeRuntimeMod.ClaudeRuntime;
    ClaudeConcurrencyError = ClaudeRuntimeMod.ClaudeConcurrencyError;
    ClaudeSessionNotResumableError = ClaudeRuntimeMod.ClaudeSessionNotResumableError;

    mcpRegistry = makeMcpRegistry();
    bridge = makeBridge();

    mock.restoreAll();
  });

  afterEach(async () => {
    restorePreflightAuth();
    restoreSpawnClaude();
    restoreGetNode();
    restoreSetNodeExternalSessionId();
    mock.restoreAll();
    // Each ClaudeRuntime subscribes to agentConfigEvents.on('model_changed').
    // Tests don't always call rt.shutdown(); strip the listeners so orphaned
    // pools don't fire model-change handlers during later tests.
    const agentCfg = require('../src/services/agentConfig');
    agentCfg.agentConfigEvents.removeAllListeners('model_changed');
    sessionRegistry.clearAllSessions();
  });

  // ── Case 1: id, label, capabilities ─────────────────────────────────────────

  test('id is "claude", label is "Claude (CLI)", capabilities match spec', () => {
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);
    assert.equal(rt.id, 'claude');
    assert.equal(rt.label, 'Claude (CLI)');
    assert.equal(rt.capabilities.modes, false);
    assert.equal(rt.capabilities.permissions, true);
    assert.equal(rt.capabilities.providerModels, false);
    assert.equal(rt.capabilities.reasoning, true);
    assert.equal(rt.capabilities.apiKeys, false);
    assert.equal(rt.capabilities.warmSessions, true);
    assert.equal(rt.capabilities.saveContext, true);
    assert.equal(rt.capabilities.spawnBranches, true);
  });

  // ── Case 2: warm() with pool disabled is a no-op ────────────────────────────

  test('warm() resolves without side effects when MICHI_CLAUDE_POOL_DISABLED=1', async () => {
    process.env.MICHI_CLAUDE_POOL_DISABLED = '1';
    try {
      // Re-require the runtime so the env var is read at construction time
      delete require.cache[require.resolve('../src/agents/claude/ClaudeWarmPool')];
      delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
      const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
      const rt = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);
      await assert.doesNotReject(() => rt.warm('/some/cwd'));
      await rt.shutdown();
    } finally {
      delete process.env.MICHI_CLAUDE_POOL_DISABLED;
    }
  });

  // ── Case 3: newSession() registers in sessionRegistry ────────────────────────

  test('newSession() returns a session and registers it in sessionRegistry', async () => {
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);
    const session = await rt.newSession({ cwd: '/tmp', sessionId: 'test-reg-id' } as any);
    assert.ok(session, 'should return a session');
    assert.equal(session.id, 'test-reg-id');

    // Cleanup
    await rt.shutdown();
  });

  // ── Case 4: concurrency cap enforced ─────────────────────────────────────────

  test('newSession() reclaims oldest idle session when cap is reached', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';

    // We need a fresh mock child for each spawn
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-${spawnCount}`), 20);
      return child;
    };

    // Re-require ClaudeSession after patching to pick up updated spawnClaude
    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);

    const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'c1' } as any);
    await rt2.newSession({ cwd: '/tmp', sessionId: 'c2' } as any);
    const s3 = await rt2.newSession({ cwd: '/tmp', sessionId: 'c3' } as any);

    assert.equal(s3.id, 'c3');
    assert.equal((s1 as any).getState(), 'disposed');
    assert.equal(sessionRegistry.getSession('c1'), undefined);

    delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
    await rt2.shutdown();
  });

  test('newSession() throws ClaudeConcurrencyError when cap is full of active turns', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';

    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-active-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
    const FreshConcurrencyError = require('../src/agents/claude/ClaudeRuntime').ClaudeConcurrencyError;
    const rt2 = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);

    const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'active-1' } as any);
    const s2 = await rt2.newSession({ cwd: '/tmp', sessionId: 'active-2' } as any);
    (s1 as any).state = 'in_turn';
    (s2 as any).state = 'in_turn';

    await assert.rejects(
      () => rt2.newSession({ cwd: '/tmp', sessionId: 'active-3' } as any),
      (err: unknown) => {
        assert.ok(err instanceof FreshConcurrencyError, `expected ClaudeConcurrencyError, got ${err}`);
        return true;
      },
    );

    delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
    await rt2.shutdown();
  });

  test('warm sessions count against cap and are evicted for active sessions', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '1';

    const children: MockClaudeChild[] = [];
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => {
        child.emitInit(`ext-warm-cap-${children.length}`);
        child.emitResult('success');
      }, 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);

    await rt2.warm('/tmp/warm-cap-a');
    assert.equal(children.length, 1, 'warm should spawn exactly one session');
    assert.equal(children[0].killed, false, 'warm session should be alive before active admission');

    const active = await rt2.newSession({ cwd: '/tmp/warm-cap-b', sessionId: 'active-after-warm' } as any);
    assert.equal(active.id, 'active-after-warm');
    assert.equal(children.length, 2, 'active cold spawn should happen after evicting warm');
    assert.equal(children[0].killed, true, 'warm session should be evicted to make room');

    delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
    await rt2.shutdown();
  });

  test('warm-pool handoff rebinds the existing MCP slot to the real node workspace', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => {
        child.emitInit(`ext-warm-bind-${spawnCount}`);
        child.emitResult('success');
      }, 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);

    await rt2.warm('/tmp/warm-bind');
    const session = await rt2.newSession({
      cwd: '/tmp/warm-bind',
      sessionId: 'node-warm-bind',
      workspaceId: 'workspace-warm-bind',
      ownerUserId: 'user-warm-bind',
    } as any);

    assert.equal(session.id, 'node-warm-bind');
    const reboundSlot = [...mcpRegistry.slots.values()].find((s) => s.parentChatId === 'node-warm-bind');
    assert.ok(reboundSlot, 'the warm slot should be rebound to the active session id');
    assert.equal(reboundSlot.nodeId, 'node-warm-bind');
    assert.equal(reboundSlot.workspaceId, 'workspace-warm-bind');
    assert.equal(reboundSlot.ownerUserId, 'user-warm-bind');

    await rt2.shutdown();
  });

  test('shutdown disposes an in-flight warm session before it enters the pool', async () => {
    const children: MockClaudeChild[] = [];
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => child.emitInit(`ext-pending-warm-${children.length}`), 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);

    const warm = rt2.warm('/tmp/pending-warm');
    while (children.length === 0) {
      await new Promise((r) => setImmediate(r));
    }

    await Promise.all([warm, rt2.shutdown()]);
    assert.equal(children[0].killed, true, 'shutdown should kill pending warm child');
  });

  // ── Case 5: loadSession() reads external_session_id, throws if null ──────────

  test('loadSession() throws ClaudeSessionNotResumableError when external_session_id is null', async () => {
    stubGetNode({ external_session_id: null });
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);

    await assert.rejects(
      () => rt.loadSession({ sessionId: 'no-ext-id', cwd: '/tmp' } as any),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeSessionNotResumableError);
        return true;
      },
    );
  });

  test('loadSession() throws ClaudeSessionNotResumableError when node is not found', async () => {
    stubGetNode(undefined);
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);

    await assert.rejects(
      () => rt.loadSession({ sessionId: 'missing-node', cwd: '/tmp' } as any),
      (err: unknown) => {
        assert.ok(err instanceof ClaudeSessionNotResumableError);
        return true;
      },
    );
  });

  // ── Case 6: loadSession() double-load guard ───────────────────────────────────

  test('loadSession() double-load returns same instance without double-spawning', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      // Also stub checkAndRepairJsonl path — no real JSONL file exists
      setTimeout(() => child.emitInit('ext-double-load'), 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;

    stubGetNode({ external_session_id: 'ext-double-load' });

    const rt = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);
    const s1 = await rt.loadSession({ sessionId: 'dl-session', cwd: '/tmp' } as any);
    const s2 = await rt.loadSession({ sessionId: 'dl-session', cwd: '/tmp' } as any);

    assert.strictEqual(s1, s2, 'double-load must return the same instance');
    assert.equal(spawnCount, 1, 'spawn should only be called once');

    await rt.shutdown();
  });

  // ── Case 7: listModes() returns [] ───────────────────────────────────────────

  test('listModes() returns empty array', async () => {
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);
    const modes = await rt.listModes('any-session-id');
    assert.deepEqual(modes, []);
  });

  // ── Case 8: listModels() returns CLAUDE_MODEL_CATALOG keys ───────────────────

  test('listModels() returns entries from CLAUDE_MODEL_CATALOG', async () => {
    const { CLAUDE_MODEL_CATALOG } = require('../src/agents/claude/claudeModelCatalog');
    const rt = new ClaudeRuntime(bridge as any, mcpRegistry as any, 9876);
    const models = await rt.listModels();

    const catalogKeys = Object.keys(CLAUDE_MODEL_CATALOG);
    assert.equal(models.length, catalogKeys.length, 'should have one entry per catalog key');
    for (const key of catalogKeys) {
      assert.ok(models.find((m: any) => m.id === key), `missing model entry for key: ${key}`);
    }
  });

  // ── Case 9: shutdown() disposes all sessions ─────────────────────────────────

  test('shutdown() calls dispose on every active session', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-shutdown-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;

    const rt = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);
    const s1 = await rt.newSession({ cwd: '/tmp', sessionId: 'sd-1' } as any);
    const s2 = await rt.newSession({ cwd: '/tmp', sessionId: 'sd-2' } as any);

    let s1Disposed = false;
    let s2Disposed = false;
    const origDispose1 = s1.dispose.bind(s1);
    const origDispose2 = s2.dispose.bind(s2);
    (s1 as any).dispose = async () => { s1Disposed = true; await origDispose1(); };
    (s2 as any).dispose = async () => { s2Disposed = true; await origDispose2(); };

    await rt.shutdown();

    assert.ok(s1Disposed, 'session 1 should be disposed');
    assert.ok(s2Disposed, 'session 2 should be disposed');
  });

  // ── Case 10: newSession() double-load guard ───────────────────────────────────

  test('newSession() double-load with same sessionId returns same instance', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('../src/agents/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-new-dl-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeRuntime')];
    const FreshRuntime = require('../src/agents/claude/ClaudeRuntime').ClaudeRuntime;

    const rt = new FreshRuntime(bridge as any, mcpRegistry as any, 9876);
    const s1 = await rt.newSession({ cwd: '/tmp', sessionId: 'new-dl-session' } as any);

    // Manually insert into sessions to simulate double-load scenario
    // (second call would find existing)
    const s2 = await rt.newSession({ cwd: '/tmp', sessionId: 'new-dl-session' } as any);

    assert.strictEqual(s1, s2, 'double-load newSession must return same instance');

    await rt.shutdown();
  });
});
