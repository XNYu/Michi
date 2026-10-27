/**
 * Unit tests for ClaudeRuntime.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * spawnClaude is stubbed so no real claude binary is needed.
 */

import './helpers/claudeSdkFixture';
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { michiTestHost } from './helpers/michiTestHost';
import { EventEmitter, PassThrough } from 'node:stream';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import type { RuntimeHost, SessionRegistryPort } from 'michi-runtime/internal/contract/host';
import type { DurableTurnSnapshot } from 'michi-shared';
import { chatOwner } from './helpers/owners';

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
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
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
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
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
    endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    rebind(slotId: string, patch: object) {
      const slot = slots.get(slotId);
      if (slot) Object.assign(slot, patch);
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
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  mod._origPreflight = mod._origPreflight ?? mod.preflightClaudeAuth;
  mod.preflightClaudeAuth = () => {};
}

function restorePreflightAuth(): void {
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  if (mod._origPreflight) mod.preflightClaudeAuth = mod._origPreflight;
}

// ---- Suite ------------------------------------------------------------------

describe('ClaudeRuntime', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let ClaudeRuntimeMod: typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
  let ClaudeRuntime: typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
  let ClaudeConcurrencyError: typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeConcurrencyError;
  let ClaudeSessionNotResumableError: typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeSessionNotResumableError;

  let mcpRegistry: ReturnType<typeof makeMcpRegistry>;
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    stubPreflightAuth();
    stubSpawnClaude();
    stubSetNodeExternalSessionId();

    // Clear module cache so ClaudeSession picks up the patched spawnClaude
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];

    ClaudeRuntimeMod = require('michi-runtime/internal/adapters/claude/ClaudeRuntime');
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

  test('uses title metadata from the main Claude response without a sidecar model', async () => {
    const rt = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    let snapshot: DurableTurnSnapshot | undefined;
    const hub = new ChatHub({
      retentionMs: 100,
      workspaceIdForNode: () => 'ws-title',
      persistence: {
        begin: () => {},
        checkpoint: () => {},
        finalize: (value) => { snapshot = value; },
      },
    });
    try {
      assert.equal((rt as AgentRuntime).generateTitle, undefined);
      const session = await rt.newSession({ cwd: '/tmp', sessionId: 'main-title' } as any);
      const { done } = await hub.startTurn({
        chatId: 'main-title', nodeId: 'main-title', text: 'How does Claude title generation work?', session,
      });
      mockChild.send({
        type: 'stream_event',
        event: {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: '[TITLE: Claude title generation]\nThe main response supplies the title.' },
        },
      });
      mockChild.emitResult();
      await done;
      assert.equal(snapshot?.status, 'completed');
      assert.equal(snapshot?.nodeMetadata.title, 'Claude title generation');
      assert.equal(snapshot?.assistantMessage.content, 'The main response supplies the title.');
    } finally {
      await rt.shutdown();
    }
  });

  // ── Case 2: warm() with pool disabled is a no-op ────────────────────────────

  test('warm() resolves without side effects when MICHI_CLAUDE_POOL_DISABLED=1', async () => {
    process.env.MICHI_CLAUDE_POOL_DISABLED = '1';
    try {
      // Re-require the runtime so the env var is read at construction time
      delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeWarmPool')];
      delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
      const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
      const rt = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
      await assert.doesNotReject(() => rt.warm('/some/cwd'));
      await rt.shutdown();
    } finally {
      delete process.env.MICHI_CLAUDE_POOL_DISABLED;
    }
  });

  test('a busy foreground send leaves the idle pump gate open after its self-turn completes', async () => {
    const rt = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    const session = await rt.newSession({ cwd: '/tmp', sessionId: 'turn-lock-pump' } as any);
    const concrete = session as any;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseDrain!: () => void;
    const release = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let callbacks = 0;

    concrete.onSelfTurn(({ events }: any) => {
      callbacks += 1;
      if (callbacks === 1) firstStarted();
      void (async () => {
        if (callbacks === 1) await release;
        for await (const _event of events) void _event;
      })();
    });

    concrete.queue.push({ kind: 'chunk', text: 'self turn' });
    await started;
    assert.ok(concrete.turnLock, 'self turn should own the lock before competing send');

    await assert.rejects(
      () => session.send('busy foreground').next(),
      (err: any) => err?.code === 'ESESSION_BUSY',
    );

    releaseDrain();
    concrete.queue.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(concrete.idleGate.isOpen, true, 'losing send must not strand the idle pump gate closed');

    concrete.queue.push({ kind: 'turn_end', stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(callbacks, 2, 'idle pump should recover and accept a subsequent self turn');
    await rt.shutdown();
  });

  // ── Case 4: concurrency cap enforced ─────────────────────────────────────────

  test('newSession() reclaims oldest idle session when cap is reached', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';

    // We need a fresh mock child for each spawn
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-${spawnCount}`), 20);
      return child;
    };

    // Re-require ClaudeSession after patching to pick up updated spawnClaude
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

    const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'c1' } as any);
    await rt2.newSession({ cwd: '/tmp', sessionId: 'c2' } as any);
    const s3 = await rt2.newSession({ cwd: '/tmp', sessionId: 'c3' } as any);

    assert.equal(s3.id, 'c3');
    assert.equal((s1 as any).getState(), 'disposed');
    assert.equal(sessionRegistry.getSession('c1'), undefined);

    delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
    await rt2.shutdown();
  });

  test('newSession() does not reclaim an idle session that still runs a workflow', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';

    let spawnCount = 0;
    const children: MockClaudeChild[] = [];
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => child.emitInit(`ext-wf-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

    const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'wf-1', nodeId: 'wf-node-1' } as any);
    const s2 = await rt2.newSession({ cwd: '/tmp', sessionId: 'wf-2', nodeId: 'wf-node-2' } as any);
    // The oldest idle session starts a background workflow.
    children[0].send({ type: 'system', subtype: 'task_started', task_id: 'wf-task-1', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'probe' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((s1 as any).hasBackgroundWork(), true);

    await rt2.newSession({ cwd: '/tmp', sessionId: 'wf-3', nodeId: 'wf-node-3' } as any);
    assert.notEqual((s1 as any).getState(), 'disposed', 'the workflow session survives');
    assert.equal((s2 as any).getState(), 'disposed', 'the next idle session is reclaimed instead');

    delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
    await rt2.shutdown();
  });

  /**
   * ClaudeRuntime builds sessions on the process-wide background registry,
   * which looks a node's workspace up in the real data directory. Swap in a
   * recording one for the test; returns its reports and a restore.
   */
  function swapBackgroundRegistry() {
    const mod = require('../src/services/backgroundSubagentRegistry') as typeof import('../src/services/backgroundSubagentRegistry');
    const original = mod.backgroundSubagentRegistry;
    const registry = new mod.BackgroundSubagentRegistry({ graceMs: 10, resolveWorkspace: () => 'ws-test' });
    const reports: Array<{ nodeId: string; ids: string[] }> = [];
    const report = registry.report.bind(registry);
    registry.report = (context, source, ids) => { reports.push({ nodeId: context.nodeId, ids: [...ids] }); report(context, source, ids); };
    (mod as { backgroundSubagentRegistry: unknown }).backgroundSubagentRegistry = registry;
    assert.equal(mod.backgroundSubagentRegistry, registry, 'the export is swappable');
    return { reports, restore: () => { (mod as { backgroundSubagentRegistry: unknown }).backgroundSubagentRegistry = original; } };
  }

  /** One turn on `session` that launches a run_in_background agent and ends while it runs. */
  async function launchBackgroundAgent(session: any, child: MockClaudeChild): Promise<void> {
    const turn = (async () => { for await (const _event of session.send('launch')) void _event; })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.send({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'toolu_bg', name: 'Agent',
      input: { subagent_type: 'explore', description: 'Audit docs', prompt: 'Audit docs', run_in_background: true },
    }] } });
    child.send({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_bg', task_type: 'local_agent', is_backgrounded: true, description: 'Audit docs' });
    child.send({
      type: 'user',
      tool_use_result: { status: 'async_launched' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'running in the background' }] },
    });
    child.emitResult('success');
    await turn;
  }

  test('newSession() reclaims a background session idle past the protect window, after plain idle ones', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';
    const background = swapBackgroundRegistry();

    let spawnCount = 0;
    const children: MockClaudeChild[] = [];
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => child.emitInit(`ext-stale-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSessionManager')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const { BACKGROUND_RECLAIM_PROTECT_MS } = require('michi-runtime/internal/adapters/claude/ClaudeSessionManager');
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

    let busyTurn: Promise<void> | undefined;
    try {
      const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'stale-1', nodeId: 'stale-node-1' } as any);
      await launchBackgroundAgent(s1, children[0]);
      assert.equal((s1 as any).hasBackgroundWork(), true);
      assert.deepEqual(background.reports, [{ nodeId: 'stale-1', ids: ['toolu_bg'] }]);
      // Last used beyond the window: a completion that never arrived.
      (s1 as any).lastUsedAt = Date.now() - BACKGROUND_RECLAIM_PROTECT_MS - 60_000;

      const s2 = await rt2.newSession({ cwd: '/tmp', sessionId: 'stale-2', nodeId: 'stale-node-2' } as any);
      assert.ok((s1 as any).getLastUsedAt() < (s2 as any).getLastUsedAt());
      const s3 = await rt2.newSession({ cwd: '/tmp', sessionId: 'stale-3', nodeId: 'stale-node-3' } as any);
      assert.equal((s2 as any).getState(), 'disposed', 'the plain idle session goes first, though newer');
      assert.notEqual((s1 as any).getState(), 'disposed');

      // With the only other session busy, the stale background session is next.
      busyTurn = (async () => { for await (const _event of s3.send('busy')) void _event; })();
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal((s3 as any).getState(), 'in_turn');
      await rt2.newSession({ cwd: '/tmp', sessionId: 'stale-4', nodeId: 'stale-node-4' } as any);
      assert.equal((s1 as any).getState(), 'disposed');
      assert.equal(children[0].killed, true);
      assert.deepEqual(background.reports.at(-1), { nodeId: 'stale-1', ids: [] }, 'its agents are withdrawn, so they read as interrupted');
    } finally {
      children[2]?.emitResult('success');
      await busyTurn;
      delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
      await rt2.shutdown();
      background.restore();
    }
  });

  test('newSession() does not reclaim an idle session whose background subagent still runs', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';
    const background = swapBackgroundRegistry();

    let spawnCount = 0;
    const children: MockClaudeChild[] = [];
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => child.emitInit(`ext-bg-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

    try {
      const s1 = await rt2.newSession({ cwd: '/tmp', sessionId: 'bg-1', nodeId: 'bg-node-1' } as any);
      // s1's turn launches a run_in_background agent and ends while it runs.
      const turn = (async () => { for await (const _event of s1.send('launch')) void _event; })();
      await new Promise((resolve) => setTimeout(resolve, 5));
      children[0].send({ type: 'assistant', message: { content: [{
        type: 'tool_use', id: 'toolu_bg', name: 'Agent',
        input: { subagent_type: 'explore', description: 'Audit docs', prompt: 'Audit docs', run_in_background: true },
      }] } });
      children[0].send({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'toolu_bg', task_type: 'local_agent', is_backgrounded: true, description: 'Audit docs' });
      children[0].send({
        type: 'user',
        tool_use_result: { status: 'async_launched' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'running in the background' }] },
      });
      children[0].emitResult('success');
      await turn;
      assert.equal((s1 as any).getState(), 'idle');
      assert.equal((s1 as any).hasBackgroundWork(), true);

      // s2 is used later, so without the guard s1 is the reclaim candidate.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const s2 = await rt2.newSession({ cwd: '/tmp', sessionId: 'bg-2', nodeId: 'bg-node-2' } as any);
      assert.ok((s1 as any).getLastUsedAt() < (s2 as any).getLastUsedAt());

      await rt2.newSession({ cwd: '/tmp', sessionId: 'bg-3', nodeId: 'bg-node-3' } as any);
      assert.notEqual((s1 as any).getState(), 'disposed', 'the background agent keeps its process');
      assert.equal(children[0].killed, false);
      assert.equal((s2 as any).getState(), 'disposed', 'the next idle session is reclaimed instead');
    } finally {
      delete process.env.MICHI_CLAUDE_MAX_CONCURRENT;
      await rt2.shutdown();
      background.restore();
    }
  });

  test('newSession() throws ClaudeConcurrencyError when cap is full of active turns', async () => {
    process.env.MICHI_CLAUDE_MAX_CONCURRENT = '2';

    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-active-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const FreshConcurrencyError = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeConcurrencyError;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

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
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
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

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

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
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
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

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

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

  test('a session with a tool profile never takes over an unrestricted warm process', async () => {
    const children: MockClaudeChild[] = [];
    const spawnedArgs: any[] = [];
    const mod = require(require.resolve('michi-runtime/internal/adapters/claude/claudeBinary'));
    mod.spawnClaude = (args: unknown) => {
      spawnedArgs.push(args);
      const child = new MockClaudeChild();
      children.push(child);
      setTimeout(() => { child.emitInit(`ext-warm-profile-${children.length}`); child.emitResult('success'); }, 20);
      return child;
    };
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;
    const rt2 = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      await rt2.warm('/tmp/warm-profile');
      const warmed = children.length;
      assert.ok(warmed > 0, 'warm processes are ready');
      const restricted = await rt2.newSession({
        cwd: '/tmp/warm-profile', sessionId: 'node-warm-profile', toolProfile: { allowedToolNames: ['read'] },
      } as any);
      assert.equal(restricted.id, 'node-warm-profile');
      assert.equal(children.length, warmed + 1, 'the restricted session spawned its own process');
      assert.deepEqual(spawnedArgs[warmed].tools, ['ToolSearch', 'Read']);
      assert.ok(children.slice(0, warmed).every((child) => !child.killed), 'the warm processes stay in the pool');
      assert.ok(![...mcpRegistry.slots.values()].some((slot) => slot.parentChatId === 'node-warm-profile' && slot.slotId !== (restricted as any).slotId),
        'no warm slot was rebound to it');

      const { ClaudeSession } = require('michi-runtime/internal/adapters/claude/ClaudeSession');
      const warm = new ClaudeSession('warm-x', { options: claudeTestOptions(), nodeId: 'warm-x', cwd: '/tmp', workspaceId: null, mcpRegistry, bridge } as any);
      assert.throws(() => warm.rebindIdentity('n-x', 'n-x', { toolProfile: { allowedToolNames: ['read'] } }), /cannot take a tool profile/);
      assert.throws(() => warm.rebindIdentity('n-x', 'n-x', { permissionBroker: { requestPermission: async () => 'deny' } as any }), /cannot take a tool profile/);
    } finally {
      await rt2.shutdown();
    }
  });

  test('loadSession() refuses a session whose transcript is in no project directory, so Michi rebuilds it from history', async () => {
    let spawns = 0;
    const mod = require(require.resolve('michi-runtime/internal/adapters/claude/claudeBinary'));
    mod.spawnClaude = () => { spawns++; return new MockClaudeChild(); };
    stubGetNode({ external_session_id: 'ext-moved-away' });
    const seen: unknown[][] = [];
    mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'claudeTranscriptFindable', async (...args: unknown[]) => {
      seen.push(args);
      return false;
    });
    const { NativeResumeUnavailableError, loadNativeSession } = require('../src/services/nativeResume');
    const rt = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });

    const opts = { sessionId: 'moved-node', nodeId: 'moved-node', cwd: '/data/assistant/.michi', ownerUserId: null } as any;
    await assert.rejects(() => rt.loadSession(opts), (err: unknown) => {
      assert.ok(err instanceof ClaudeSessionNotResumableError);
      assert.ok(err instanceof NativeResumeUnavailableError);
      return true;
    });
    assert.deepEqual(seen[0].slice(1), ['/data/assistant/.michi', 'ext-moved-away', null]);
    // The shared loader turns it into "no native session": the callers' history rebuild.
    assert.equal(await loadNativeSession(rt, opts, 'ext-moved-away'), null);
    assert.equal(spawns, 0, 'no --resume that can only fail');
    await rt.shutdown();
  });

  // ── Case 6: loadSession() double-load guard ───────────────────────────────────

  test('loadSession() double-load returns same instance without double-spawning', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      // Also stub checkAndRepairJsonl path — no real JSONL file exists
      setTimeout(() => child.emitInit('ext-double-load'), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;

    stubGetNode({ external_session_id: 'ext-double-load' });
    mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'claudeTranscriptFindable', async () => true);

    const rt = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    const s1 = await rt.loadSession({ sessionId: 'dl-session', cwd: '/tmp' } as any);
    const s2 = await rt.loadSession({ sessionId: 'dl-session', cwd: '/tmp' } as any);

    assert.strictEqual(s1, s2, 'double-load must return the same instance');
    assert.equal(spawnCount, 1, 'spawn should only be called once');

    await rt.shutdown();
  });

  test('fresh and resumed sessions preserve disabled follow-ups, including same-id reacquisition', async () => {
    stubGetNode({ external_session_id: 'ext-follow-up-options' });
    mock.method(require('michi-runtime/internal/adapters/claude/claudeProjectsPath'), 'claudeTranscriptFindable', async () => true);
    const rt = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      const fresh = await rt.newSession({ sessionId: 'fresh-no-follow-ups', cwd: '/tmp', enableFollowUps: false });
      const resumed = await rt.loadSession({ sessionId: 'resumed-no-follow-ups', cwd: '/tmp', enableFollowUps: false });
      for (const session of [fresh, resumed]) {
        assert.equal((session as any).enableFollowUps, false);
        assert.equal(await rt.loadSession({ sessionId: session.id, cwd: '/tmp', enableFollowUps: true }), session);
        assert.equal((session as any).enableFollowUps, false, 'acquisition must not reconfigure a live session');
      }
      const defaultResumed = await rt.loadSession({ sessionId: 'resumed-default-follow-ups', cwd: '/tmp' });
      assert.equal((defaultResumed as any).enableFollowUps, true);
    } finally {
      await rt.shutdown();
    }
  });

  // ── Case 8b: live catalog (cache + CLI probe) ──────────────────────────────

  function memoryCache(initial: any[] | null = null) {
    const saved: any[][] = [];
    return {
      saved,
      load: () => initial,
      save: (_id: string, models: any[]) => { saved.push(models); },
    };
  }
  const probed = [
    { id: 'claude-fable-5', label: 'Fable', supportsReasoning: true, supportedReasoningLevels: ['low', 'high'], defaultReasoning: 'high' },
    { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)', supportsReasoning: true, supportedReasoningLevels: ['low', 'max'], defaultReasoning: 'max' },
  ];

  test('refreshModels() probes, persists, and updates listModels()', async () => {
    const { getClaudeReasoningCapabilities, setDiscoveredClaudeModels } = require('michi-runtime/internal/adapters/claude/claudeModelCatalog');
    const cache = memoryCache([{ id: 'claude-sonnet-5-5' }]);
    const rt = new ClaudeRuntime({ ...claudeTestOptions({ modelCatalog: {
      cache: cache as any,
      probe: async () => probed as any,
    } }), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      assert.deepEqual(await rt.refreshModels(), probed);
      assert.deepEqual(cache.saved, [probed]);
      assert.deepEqual(await rt.listModels(), probed);
      // The probed capabilities drive effort resolution, including for the
      // legacy alias that canonicalises onto a probed id.
      assert.deepEqual(getClaudeReasoningCapabilities('opus').supportedReasoningLevels, ['low', 'max']);
    } finally {
      setDiscoveredClaudeModels([]);
      await rt.shutdown();
    }
  });

  test('listModels() without a snapshot probes once, else falls back to the static catalog', async () => {
    const { CLAUDE_MODEL_CATALOG } = require('michi-runtime/internal/adapters/claude/claudeModelCatalog');
    let probes = 0;
    const rt = new ClaudeRuntime({ ...claudeTestOptions({ modelCatalog: {
      cache: memoryCache() as any,
      probe: async () => { probes++; throw new Error('no claude'); },
    } }), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    const models = await rt.listModels();
    assert.deepEqual(models.map((m) => m.id), Object.keys(CLAUDE_MODEL_CATALOG));
    await rt.listModels();
    assert.equal(probes, 1, 'a failing probe is not retried on every listModels call');
    await rt.shutdown();
  });

  test('concurrent first picker reads join the same Claude probe', async () => {
    let probes = 0;
    let resolveProbe!: (models: any[]) => void;
    const rt = new ClaudeRuntime({ ...claudeTestOptions({ modelCatalog: {
      probe: () => { probes++; return new Promise((resolve) => { resolveProbe = resolve; }); },
    } }), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      const first = rt.listModels();
      const second = rt.listModels();
      assert.equal(probes, 1);
      resolveProbe(probed);
      assert.deepEqual(await first, probed);
      assert.deepEqual(await second, probed);
      await rt.listModels();
      assert.equal(probes, 1, 'cached picker reads keep the explicit-only refresh policy');
    } finally {
      const { setDiscoveredClaudeModels } = require('michi-runtime/internal/adapters/claude/claudeModelCatalog');
      setDiscoveredClaudeModels([]);
      await rt.shutdown();
    }
  });

  test('empty Claude probe is attempted once per picker lifecycle and explicit refresh can retry', async () => {
    let probes = 0;
    const cache = memoryCache();
    const rt = new ClaudeRuntime({ ...claudeTestOptions({ modelCatalog: {
      cache: cache as any,
      probe: async () => { probes++; return probes === 1 ? [] : probed as any; },
    } }), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      assert.ok((await rt.listModels()).length > 0, 'empty probe uses static fallback');
      await rt.listModels();
      assert.equal(probes, 1, 'empty results must not spawn the CLI each time the picker opens');
      assert.deepEqual(cache.saved, []);
      assert.deepEqual(await rt.refreshModels(), probed);
      await rt.listModels();
      assert.equal(probes, 2, 'snapshot picker reads do not run another expensive probe');
    } finally {
      const { setDiscoveredClaudeModels } = require('michi-runtime/internal/adapters/claude/claudeModelCatalog');
      setDiscoveredClaudeModels([]);
      await rt.shutdown();
    }
  });

  test('canonicalModelId() maps legacy aliases onto concrete ids', async () => {
    const rt = new ClaudeRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    assert.equal(rt.canonicalModelId('opus'), 'claude-opus-5[1m]');
    assert.equal(rt.canonicalModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    await rt.shutdown();
  });

  // ── Case 10: newSession() double-load guard ───────────────────────────────────

  test('newSession() double-load with same sessionId returns same instance', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-new-dl-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;

    const rt = new FreshRuntime({ ...claudeTestOptions(), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    const s1 = await rt.newSession({ cwd: '/tmp', sessionId: 'new-dl-session' } as any);

    // Manually insert into sessions to simulate double-load scenario
    // (second call would find existing)
    const s2 = await rt.newSession({ cwd: '/tmp', sessionId: 'new-dl-session' } as any);

    assert.strictEqual(s1, s2, 'double-load newSession must return same instance');

    await rt.shutdown();
  });

  test('new, child and released sessions reach the host sessions port, not the process registry', async () => {
    let spawnCount = 0;
    const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
    const mod = require(claudeBinaryPath);
    mod.spawnClaude = () => {
      spawnCount++;
      const child = new MockClaudeChild();
      setTimeout(() => child.emitInit(`ext-port-${spawnCount}`), 20);
      return child;
    };

    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeRuntime')];
    const FreshRuntime = require('michi-runtime/internal/adapters/claude/ClaudeRuntime').ClaudeRuntime;

    const calls: string[] = [];
    const live = new Map<string, AgentSession>();
    const sessions: SessionRegistryPort = {
      ensureAncestorChainLoaded: (chatId) => { calls.push(`ensureAncestorChainLoaded ${chatId}`); },
      getSession: (chatId) => { calls.push(`getSession ${chatId}`); return live.get(chatId); },
      getAncestors: (chatId) => { calls.push(`getAncestors ${chatId}`); return []; },
      registerSession: (session) => { calls.push(`registerSession ${session.id}`); live.set(session.id, session); },
      dropSession: (chatId) => { calls.push(`dropSession ${chatId}`); live.delete(chatId); },
    };
    const rt = new FreshRuntime({ ...claudeTestOptions({ host: { ...michiTestHost(), sessions } }), bridge: bridge as any, mcpSlots: mcpRegistry as any });
    try {
      await rt.newSession({ cwd: '/tmp', sessionId: 'port-parent' } as any);
      await rt.newSession({ cwd: '/tmp', sessionId: 'port-child', parentChatId: 'port-parent' } as any);
      for (const id of ['port-parent', 'port-child']) assert.equal(sessionRegistry.getSession(id), undefined, id);
      for (const id of ['port-child', 'port-parent']) await rt.releaseSession(id);
      // Releasing an id that is no longer active still drops it through the port.
      await rt.releaseSession('port-child');
      assert.deepEqual(calls, [
        'registerSession port-parent',
        'ensureAncestorChainLoaded port-parent',
        'getSession port-parent',
        'getAncestors port-parent',
        'registerSession port-child',
        'dropSession port-child',
        'dropSession port-parent',
        'dropSession port-child',
      ]);
      assert.equal(live.size, 0);
    } finally {
      await rt.shutdown();
    }
  });
});

test('ClaudeRuntime requires the host ports its self-turns, fork guard, workflows and subagents use', () => {
  const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
  const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
  // A JS host can still leave the required ports out; the runtime's own check catches it.
  const host = { ...michiTestHost(), backgroundTurns: undefined, workflows: undefined, backgroundSubagents: undefined } as unknown as RuntimeHost;
  assert.throws(
    () => new ClaudeRuntime({ ...claudeTestOptions({ host }), bridge: makeBridge() as any, mcpSlots: makeMcpRegistry() as any }),
    { name: 'RuntimeHostConfigError', message: 'ClaudeRuntime requires host ports that are missing: backgroundTurns, workflows, backgroundSubagents' },
  );
});

test('ClaudeRuntime refuses the old positional arguments with a TypeError', () => {
  const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
  const Untyped = ClaudeRuntime as unknown as new (...args: unknown[]) => unknown;
  const expected = { name: 'TypeError', message: 'ClaudeRuntime takes one options object { host, bridge, mcpSlots, … } (runtime contract v1)' };
  assert.throws(() => new Untyped(makeBridge(), makeMcpRegistry(), claudeTestOptions()), expected);
  assert.throws(() => new Untyped(undefined), expected);
  assert.throws(() => new Untyped({ ...claudeTestOptions(), mcpSlots: makeMcpRegistry() }), expected);
  assert.throws(() => new Untyped({ ...claudeTestOptions(), bridge: makeBridge() }), expected);
  // Present but undefined counts as missing, as a factory's `deps.mcpRegistry!` can be.
  assert.throws(() => new Untyped({ ...claudeTestOptions(), bridge: undefined, mcpSlots: undefined }), expected);
  assert.throws(() => new Untyped({ ...claudeTestOptions(), host: undefined, bridge: makeBridge(), mcpSlots: makeMcpRegistry() }), expected);
});

test("self-turns go to the host's backgroundTurns, and the native fork guard asks it about the parent", async () => {
  const { ClaudeRuntime } = require('michi-runtime/internal/adapters/claude/ClaudeRuntime') as typeof import('michi-runtime/internal/adapters/claude/ClaudeRuntime');
  const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
  const { NativeResumeUnavailableError } = require('../src/services/nativeResume');
  const base = michiTestHost();
  const consumed: unknown[] = [];
  const asked: string[] = [];
  const rows: Record<string, any> = {
    parent: { id: 'parent', workspace_id: 'ws', tree_id: 't', kind: 'chat', status: 'idle', runtime_id: 'claude', external_session_id: 'native-parent' },
    child: { id: 'child', workspace_id: 'ws', tree_id: 't', parent_node_id: 'parent', kind: 'chat', status: 'idle', runtime_id: 'claude' },
  };
  const host = {
    ...base,
    bindings: { ...base.bindings, nodeBinding: (id: string) => rows[id] ?? null, workspace: () => ({ id: 'ws', cwd: '/tmp', owner_user_id: null }) },
    backgroundTurns: {
      consume: (turn: unknown) => { consumed.push(turn); },
      isActive: (id: string) => { asked.push(`isActive ${id}`); return false; },
      isOwnerTurnActive: (id: string) => { asked.push(`isOwnerTurnActive ${id}`); return false; },
      hasPendingSelfTurn: (id: string) => { asked.push(`hasPendingSelfTurn ${id}`); return true; },
    },
  };
  const rt = new ClaudeRuntime({ ...claudeTestOptions({ host }), bridge: makeBridge() as any, mcpSlots: makeMcpRegistry() as any });
  try {
    const turn = { chatId: 'child', owner: chatOwner('child'), ownerUserId: null, events: (async function* () {})(), session: {} };
    (rt as any).manager.deps.onSelfTurn(turn);
    assert.deepEqual(consumed, [turn]);
    await assert.rejects(rt.forkSession({
      sessionId: 'child', parentChatId: 'parent', owner: chatOwner('child'),
      cwd: '/tmp', workspaceId: 'ws', sourceNativeSessionId: 'native-parent',
    }), NativeResumeUnavailableError);
    assert.deepEqual(asked, ['isActive parent', 'isOwnerTurnActive parent', 'hasPendingSelfTurn parent']);
  } finally {
    await rt.shutdown();
  }
});
