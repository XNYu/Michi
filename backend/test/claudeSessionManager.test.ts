import './helpers/claudeSdkFixture';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { chatOwner, runOwner } from './helpers/owners';

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  signals: NodeJS.Signals[] = [];

  constructor(public pid: number) { super(); }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (!this.killed) {
      this.killed = true;
      queueMicrotask(() => this.emit('exit', 0, null));
    }
    return true;
  }
}

function makeMcpRegistry() {
  const slots = new Map<string, any>();
  let next = 0;
  return {
    create(parentChatId: string, cwd: string, ownerUserId: string | null, callbacks: unknown, opts?: unknown) {
      const slot = { slotId: `slot-${++next}`, parentChatId, cwd, ownerUserId, ...(opts as object), ...(callbacks as object) };
      slots.set(slot.slotId, slot);
      return slot;
    },
    get(id: string) { return slots.get(id); },
    async dispose(id: string) { slots.delete(id); },
    endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    // In place: the tests read the slot objects of this map.
    rebind(id: string, patch: object) { const slot = slots.get(id); if (slot) Object.assign(slot, patch); },
    slots,
  };
}

describe('ClaudeSessionManager Agent Run ownership', () => {
  let originalSpawn: any;
  let originalKillProcessTree: typeof import('../src/agents/processTree').killProcessTree;
  let children: MockClaudeChild[];
  let Manager: typeof import('michi-runtime/internal/adapters/claude/ClaudeSessionManager').ClaudeSessionManager;

  beforeEach(() => {
    children = [];
    const binary = require('michi-runtime/internal/adapters/claude/claudeBinary');
    originalSpawn = binary.spawnClaude;
    binary.spawnClaude = () => {
      const child = new MockClaudeChild(10_000 + children.length);
      children.push(child);
      return child;
    };
    const processTree = require('../src/agents/processTree');
    originalKillProcessTree = processTree.killProcessTree;
    processTree.killProcessTree = (pid: number, signal: NodeJS.Signals) => {
      const child = children.find((candidate) => candidate.pid === pid);
      assert.ok(child, 'only fixture processes may be signaled');
      child.kill(signal);
    };
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
    delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSessionManager')];
    Manager = require('michi-runtime/internal/adapters/claude/ClaudeSessionManager').ClaudeSessionManager;
  });

  afterEach(() => {
    require('michi-runtime/internal/adapters/claude/claudeBinary').spawnClaude = originalSpawn;
    require('../src/agents/processTree').killProcessTree = originalKillProcessTree;
    sessionRegistry.clearAllSessions();
  });

  function createManager(onSelfTurn?: (...args: any[]) => void, bridge?: any) {
    return new Manager({
      options: claudeTestOptions(),
      bridge: bridge ?? { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpRegistry: makeMcpRegistry() as any,
      concurrencyCap: 4,
      currentModel: 'claude-sonnet-4-5',
      poolDisabled: true,
      onSelfTurn,
    });
  }

  test('Run attempts bind owner/profile without a node-backed MCP slot', async () => {
    const selfTurns: unknown[] = [];
    const manager = createManager((info) => selfTurns.push(info));
    const owner = runOwner('run-1', 'attempt-1');
    const session = await manager.createSession({
      id: 'attempt-1',
      owner,
      cwd: process.cwd(),
      workspaceId: 'workspace-1',
      ownerUserId: 'user-1',
      profileHash: 'profile-a',
      replayHistory: [{ role: 'user', content: 'prior input' }],
    });

    assert.deepEqual(session.owner, owner);
    assert.equal(session.runtimeProfileHash, 'profile-a');
    assert.deepEqual(session.getHistory(), [{ role: 'user', content: 'prior input' }]);
    assert.equal(sessionRegistry.getSessionForOwner('attempt-1', owner, 'user-1'), session);
    const slot = [...(manager as any).deps.mcpRegistry.slots.values()][0];
    assert.equal(slot.nodeId, null);
    assert.equal(selfTurns.length, 0, 'Run attempts must not attach the chat self-turn sink');
    await manager.shutdown();
  });

  test('chat self-turns carry their exact registered Session and reject stale owner callbacks', async () => {
    const selfTurns: any[] = [];
    const manager = createManager((info) => selfTurns.push(info));
    const session = await manager.createSession({
      id: 'node-chat', owner: chatOwner('node-chat'),
      cwd: process.cwd(), ownerUserId: 'owner-a',
    });
    const events = (async function* () {})();
    const callback = (session as any).selfTurnCallback;
    const info = { chatId: 'node-chat', owner: session.owner, ownerUserId: 'owner-a', events };
    callback(info);
    assert.equal(selfTurns.length, 1);
    assert.equal(selfTurns[0].session, session);
    assert.equal(selfTurns[0].events, events);
    assert.throws(() => callback({ ...info, owner: chatOwner('other-node') }), /registered owner/);
    assert.throws(() => callback({ ...info, ownerUserId: 'other-user' }), /registered owner/);
    (manager as any).active.delete('node-chat');
    assert.throws(() => callback(info), /registered owner/);
    assert.equal(selfTurns.length, 1);
    await session.dispose();
    await manager.shutdown();
  });

  test('Run MCP slot receives exact-Attempt result submission while chat slots do not', async () => {
    const bindings: any[] = [];
    const submissions: any[] = [];
    const bridge = {
      spawnBranches: async () => [], saveContext: () => null, updateContext: () => null,
      agentRunToolsForSession: (binding: unknown) => { bindings.push(binding); return { invoke: async () => ({}) }; },
    };
    const manager = createManager(undefined, bridge);
    const owner = runOwner('run-a', 'attempt-a');
    const profile = {
      allowedToolNames: ['submit_agent_result', 'spawn_agent'],
      runWorkerTools: { submitAgentResult: (actualOwner: unknown, payload: unknown) => {
        submissions.push([actualOwner, payload]); return payload;
      } },
    };
    await manager.createSession({ id: 'attempt-a', owner, cwd: process.cwd(), workspaceId: 'ws-a', ownerUserId: 'owner-a', toolProfile: profile });
    const runSlot = [...(manager as any).deps.mcpRegistry.slots.values()][0];
    assert.ok(runSlot.agentRuns);
    assert.deepEqual(runSlot.agentRunToolNames, ['spawn_agent']);
    assert.ok(runSlot.onSubmitAgentResult);
    runSlot.onSubmitAgentResult({ version: 1, status: 'completed' });
    assert.deepEqual(submissions, [[owner, { version: 1, status: 'completed' }]]);
    assert.deepEqual(bindings[0], {
      runtimeId: 'claude', sessionId: 'attempt-a', owner, ownerUserId: 'owner-a', workspaceId: 'ws-a', nodeId: null,
    });
    await manager.createSession({
      id: 'node-chat', owner: chatOwner('node-chat'), cwd: process.cwd(),
      workspaceId: 'ws-a', ownerUserId: 'owner-a', toolProfile: profile,
    });
    const chatSlot = [...(manager as any).deps.mcpRegistry.slots.values()]
      .find((slot: any) => slot.parentChatId === 'node-chat');
    assert.ok(chatSlot.agentRuns, 'chat receives its own generic Agent invoker');
    assert.equal(chatSlot.onSubmitAgentResult, undefined, 'chat must never receive the Run-only result tool');
    await manager.shutdown();
  });

  test('profile mismatch rejects reuse of the same public session id', async () => {
    const manager = createManager();
    const owner = runOwner('run-1', 'attempt-1');
    await manager.createSession({ id: 'attempt-1', owner, cwd: process.cwd(), profileHash: 'profile-a' });

    await assert.rejects(
      () => manager.createSession({ id: 'attempt-1', owner, cwd: process.cwd(), profileHash: 'profile-b' }),
      /profile hash mismatch/,
    );
    await manager.shutdown();
  });

  test('owner reuse and release reject another Attempt and a chat under the same session id', async () => {
    const manager = createManager();
    const owner = runOwner('run-1', 'attempt-shared');
    const session = await manager.createSession({ id: 'attempt-shared', owner, cwd: process.cwd() });
    try {
      for (const wrongOwner of [
        runOwner('run-1', 'attempt-other'),
        chatOwner('attempt-shared'),
      ]) {
        assert.throws(() => manager.getCompatible(session.id, wrongOwner, null), /different owner/);
        await assert.rejects(manager.releaseSession(session.id, wrongOwner), /Owner mismatch/);
        assert.equal(manager.get(session.id), session);
      }
      assert.equal(manager.getCompatible(session.id, { ...owner }, null), session);
      await manager.releaseSession(session.id, { ...owner });
      assert.equal(manager.get(session.id), undefined);
    } finally {
      await manager.shutdown();
    }
  });

  test('Run resume binds explicit native token and replay without a node lookup seam', async () => {
    const manager = createManager();
    const owner = runOwner('run-1', 'attempt-resume');
    const session = await manager.loadSession({
      id: 'attempt-resume',
      owner,
      cwd: process.cwd(),
      externalSessionId: 'native-resume-token',
      profileHash: 'profile-a',
      bootstrapInstructions: 'Resume only the outstanding work.',
      replayHistory: [{ role: 'assistant', content: 'checkpointed progress' }],
    });

    assert.equal(session.nativeSessionId, 'native-resume-token');
    assert.deepEqual(session.getHistory(), [{ role: 'assistant', content: 'checkpointed progress' }]);
    assert.equal((session as any).firstTurnPrefix, 'Resume only the outstanding work.');
    await manager.shutdown();
  });

  test('Michi assistant fresh and restored sessions use the dedicated prompt without turn metadata', async () => {
    const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
    const manager = createManager();
    try {
      const fresh = await manager.createSession({
        id: 'michi-fresh', cwd: process.cwd(), toolProfile: assistantToolProfile(), enableFollowUps: true,
      });
      const restored = await manager.loadSession({
        id: 'michi-restored', cwd: process.cwd(), toolProfile: assistantToolProfile(),
        externalSessionId: 'michi-native', enableFollowUps: true,
      });
      for (const session of [fresh, restored]) {
        const prompt = (session as any).systemPromptAppend as string;
        assert.match(prompt, /You are Michi/);
        assert.doesNotMatch(prompt, /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|validate_turn_metadata/);
      }
    } finally {
      await manager.shutdown();
    }
  });
});

describe('ClaudeSessionManager capacity reclaim with background work', () => {
  const { ClaudeSessionManager, BACKGROUND_RECLAIM_PROTECT_MS } =
    require('michi-runtime/internal/adapters/claude/ClaudeSessionManager') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSessionManager');

  afterEach(() => sessionRegistry.clearAllSessions());

  test('protects an idle session holding background work for six hours after its last use', () => {
    assert.equal(BACKGROUND_RECLAIM_PROTECT_MS, 6 * 60 * 60_000);
  });

  /** A manager whose active map holds fake sessions; reclaim() returns the id it disposed. */
  function managerWith(sessions: Array<{ id: string; state: string; background: boolean; idleFor: number }>) {
    const manager = new ClaudeSessionManager({
      options: claudeTestOptions(),
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpRegistry: makeMcpRegistry() as any,
      concurrencyCap: 4,
      currentModel: 'claude-sonnet-4-5',
      poolDisabled: true,
    });
    const now = Date.now();
    const disposed: string[] = [];
    const active: Map<string, unknown> = (manager as any).active;
    for (const spec of sessions) {
      active.set(spec.id, {
        id: spec.id,
        getState: () => spec.state,
        hasBackgroundWork: () => spec.background,
        getLastUsedAt: () => now - spec.idleFor,
        dispose: async () => { disposed.push(spec.id); },
      });
    }
    const reclaim = async (): Promise<string | null> => {
      const before = disposed.length;
      const reclaimed: boolean = await (manager as any).reclaimActiveSession();
      assert.equal(reclaimed, disposed.length > before);
      return reclaimed ? disposed.at(-1)! : null;
    };
    return { manager, reclaim, active };
  }

  const HOUR = 60 * 60_000;

  test('within the window an idle session with background work is never reclaimed', async () => {
    const { reclaim, active } = managerWith([
      { id: 'background', state: 'idle', background: true, idleFor: BACKGROUND_RECLAIM_PROTECT_MS - HOUR },
      { id: 'plain', state: 'idle', background: false, idleFor: 1_000 },
      { id: 'busy', state: 'in_turn', background: false, idleFor: 10 * HOUR },
    ]);
    assert.equal(await reclaim(), 'plain', 'the newer plain idle session goes, though the background one is older');
    assert.equal(active.has('plain'), false);
    assert.equal(await reclaim(), null, 'nothing else is reclaimable');
    assert.equal(active.has('background'), true);
  });

  test('past the window it is reclaimable, but only after every other idle or dead session', async () => {
    const { reclaim } = managerWith([
      { id: 'stale-background', state: 'idle', background: true, idleFor: BACKGROUND_RECLAIM_PROTECT_MS + HOUR },
      { id: 'older-stale-background', state: 'idle', background: true, idleFor: BACKGROUND_RECLAIM_PROTECT_MS + 2 * HOUR },
      { id: 'plain', state: 'idle', background: false, idleFor: 1_000 },
      { id: 'crashed', state: 'crashed', background: false, idleFor: 0 },
      { id: 'fresh-background', state: 'idle', background: true, idleFor: HOUR },
      { id: 'busy', state: 'in_turn', background: true, idleFor: BACKGROUND_RECLAIM_PROTECT_MS + 3 * HOUR },
    ]);
    const order: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) order.push(await reclaim());
    assert.deepEqual(order, ['crashed', 'plain', 'older-stale-background', 'stale-background', null]);
  });

  test('a session in a turn is never reclaimed, background work or not', async () => {
    const { reclaim } = managerWith([
      { id: 'busy-background', state: 'in_turn', background: true, idleFor: BACKGROUND_RECLAIM_PROTECT_MS * 2 },
      { id: 'spawning', state: 'spawning', background: false, idleFor: HOUR },
    ]);
    assert.equal(await reclaim(), null);
  });
});
