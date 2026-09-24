import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as sessionRegistry from '../src/agents/sessionRegistry';

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
    slots,
  };
}

describe('ClaudeSessionManager Agent Run ownership', () => {
  let originalSpawn: any;
  let originalKillProcessTree: typeof import('../src/agents/processTree').killProcessTree;
  let children: MockClaudeChild[];
  let Manager: typeof import('../src/agents/claude/ClaudeSessionManager').ClaudeSessionManager;

  beforeEach(() => {
    children = [];
    const binary = require('../src/agents/claude/claudeBinary');
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
    delete require.cache[require.resolve('../src/agents/claude/ClaudeSession')];
    delete require.cache[require.resolve('../src/agents/claude/ClaudeSessionManager')];
    Manager = require('../src/agents/claude/ClaudeSessionManager').ClaudeSessionManager;
  });

  afterEach(() => {
    require('../src/agents/claude/claudeBinary').spawnClaude = originalSpawn;
    require('../src/agents/processTree').killProcessTree = originalKillProcessTree;
    sessionRegistry.clearAllSessions();
  });

  function createManager(onSelfTurn?: (...args: any[]) => void, bridge?: any) {
    return new Manager({
      bridge: bridge ?? { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpRegistry: makeMcpRegistry() as any,
      mcpPort: 9876,
      concurrencyCap: 4,
      currentModel: 'claude-sonnet-4-5',
      poolDisabled: true,
      onSelfTurn,
    });
  }

  test('native forks bypass both available and inflight warm sessions', async (t) => {
    const manager = new Manager({
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpRegistry: makeMcpRegistry() as any,
      mcpPort: 9876,
      concurrencyCap: 4,
      currentModel: 'claude-sonnet-4-5',
      poolDisabled: false,
      waitForWarm: true,
    });
    const pool = (manager as any).pool;
    t.mock.method(pool, 'take', () => assert.fail('native fork must not take a blank warm session'));
    t.mock.method(pool, 'waitForInflight', () => assert.fail('native fork must not wait for a blank warm session'));
    const binary = require('../src/agents/claude/claudeBinary');
    const spawnFixture = binary.spawnClaude;
    const spawns: import('../src/agents/claude/claudeBinary').SpawnClaudeArgs[] = [];
    t.mock.method(binary, 'spawnClaude', (args: import('../src/agents/claude/claudeBinary').SpawnClaudeArgs) => {
      spawns.push(args);
      return spawnFixture(args);
    });
    try {
      const session = await manager.createSession({
        id: 'fork-child', cwd: process.cwd(), forkFromNativeSessionId: 'native-parent',
      });
      assert.equal(spawns.length, 1);
      assert.equal(spawns[0].forkSession, true);
      assert.equal(spawns[0].resumeSessionId, 'native-parent');
      assert.equal(session.nativeSessionId, spawns[0].sessionId);
      assert.notEqual(session.nativeSessionId, 'native-parent');
    } finally {
      await manager.shutdown();
    }
  });

  test('Run attempts bind owner/profile without a node-backed MCP slot', async () => {
    const selfTurns: unknown[] = [];
    const manager = createManager((info) => selfTurns.push(info));
    const owner = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-1' };
    const session = await manager.createSession({
      id: owner.attemptId,
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
    assert.equal(sessionRegistry.getSessionForOwner(owner.attemptId, owner, 'user-1'), session);
    const slot = [...(manager as any).deps.mcpRegistry.slots.values()][0];
    assert.equal(slot.nodeId, null);
    assert.equal(selfTurns.length, 0, 'Run attempts must not attach the chat self-turn sink');
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
    const owner = { kind: 'agent_run' as const, runId: 'run-a', attemptId: 'attempt-a' };
    const profile = {
      allowedToolNames: ['submit_agent_result', 'spawn_agent'],
      runWorkerTools: { submitAgentResult: (actualOwner: unknown, payload: unknown) => {
        submissions.push([actualOwner, payload]); return payload;
      } },
    };
    await manager.createSession({ id: owner.attemptId, owner, cwd: process.cwd(), workspaceId: 'ws-a', ownerUserId: 'owner-a', toolProfile: profile });
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
      id: 'node-chat', owner: { kind: 'chat_node', nodeId: 'node-chat' }, cwd: process.cwd(),
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
    const owner = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-1' };
    await manager.createSession({ id: owner.attemptId, owner, cwd: process.cwd(), profileHash: 'profile-a' });

    await assert.rejects(
      () => manager.createSession({ id: owner.attemptId, owner, cwd: process.cwd(), profileHash: 'profile-b' }),
      /profile hash mismatch/,
    );
    await manager.shutdown();
  });

  test('Run resume binds explicit native token and replay without a node lookup seam', async () => {
    const manager = createManager();
    const owner = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-resume' };
    const session = await manager.loadSession({
      id: owner.attemptId,
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

  test('late release for an old Attempt cannot dispose the replacement owner', async () => {
    const manager = createManager();
    const current = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-2' };
    const stale = { kind: 'agent_run' as const, runId: 'run-1', attemptId: 'attempt-1' };
    const session = await manager.createSession({ id: current.attemptId, owner: current, cwd: process.cwd(), profileHash: 'profile-a' });

    await manager.releaseSession(current.attemptId, stale);
    assert.equal(manager.get(current.attemptId), session);
    assert.equal(children[0].killed, false);
    assert.deepEqual(children[0].signals, []);

    await manager.releaseSession(current.attemptId, current);
    assert.equal(manager.get(current.attemptId), undefined);
    assert.equal(children[0].killed, true);
    assert.deepEqual(children[0].signals, ['SIGINT', 'SIGKILL']);
    await manager.shutdown();
  });
});
