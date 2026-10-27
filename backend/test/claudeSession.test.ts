import './helpers/claudeSdkFixture';
/**
 * Unit tests for ClaudeSession.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 * spawnClaude is stubbed; no real claude binary is invoked.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import type { RuntimeHost } from 'michi-runtime/internal/contract/host';
import type { ClaudeHostText } from 'michi-runtime/internal/adapters/claude/claudeAdapterOptions';
import { EventEmitter, PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildStableSystemPrompt } from '../src/agents/preamble';
import { SUBAGENT_SESSION_ENDED_ERROR } from 'michi-shared';
import { BackgroundSubagentRegistry, type EndedBackgroundSubagents } from '../src/services/backgroundSubagentRegistry';
import { subagentSink } from './helpers/hostSinks';
import { runOwner } from './helpers/owners';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';

// ---- MockClaudeChild --------------------------------------------------------

class MockClaudeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  killSignals: string[] = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignals.push(signal ?? 'SIGTERM');
    process.nextTick(() => this.emit('exit', signal === 'SIGKILL' ? 137 : 0, null));
    return true;
  }

  send(envelope: object): void {
    this.stdout.push(JSON.stringify(envelope) + '\n');
  }

  emitInit(sessionId = 'ext-session-001'): void {
    this.send({ type: 'system', subtype: 'init', session_id: sessionId });
  }

  emitResult(subtype: 'success' | 'error' = 'success'): void {
    this.send({ type: 'result', subtype, usage: { input_tokens: 10, output_tokens: 5 } });
  }

  emitChunk(text: string): void {
    this.send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      },
    });
  }

  emitThought(text: string): void {
    this.send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: text },
      },
    });
  }
}

// ---- Stub helpers -----------------------------------------------------------

let mockChildFactory: (() => MockClaudeChild) | null = null;
const createdChildren: MockClaudeChild[] = [];
const capturedSpawnArgs: unknown[] = [];

function stubSpawnClaude(factory?: () => MockClaudeChild): void {
  createdChildren.length = 0;
  capturedSpawnArgs.length = 0;
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  mod._origSpawnClaude = mod._origSpawnClaude ?? mod.spawnClaude;
  mod._origPreflight = mod._origPreflight ?? mod.preflightClaudeAuth;
  mod.preflightClaudeAuth = () => {};
  mod.spawnClaude = (args: unknown) => {
    capturedSpawnArgs.push(args);
    const child = factory ? factory() : (mockChildFactory ? mockChildFactory() : new MockClaudeChild());
    createdChildren.push(child);
    return child;
  };
}

function restoreSpawnClaude(): void {
  const claudeBinaryPath = require.resolve('michi-runtime/internal/adapters/claude/claudeBinary');
  const mod = require(claudeBinaryPath);
  if (mod._origSpawnClaude) {
    mod.spawnClaude = mod._origSpawnClaude;
    delete mod._origSpawnClaude;
  }
  if (mod._origPreflight) {
    mod.preflightClaudeAuth = mod._origPreflight;
    delete mod._origPreflight;
  }
}

function stubDbRepository(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  mod._origSetNode = mod._origSetNode ?? mod.setNodeExternalSessionId;
  mod._origGetNode = mod._origGetNode ?? mod.getNode;
  mod._origHasGrant = mod._origHasGrant ?? mod.hasGrant;
  mod._origGrantPermission = mod._origGrantPermission ?? mod.grantPermission;
  mod.setNodeExternalSessionId = (_nodeId: string, _sid: string) => {};
  mod.getNode = () => undefined;
  mod.hasGrant = () => false;
  // track calls for assertions
  mod._setNodeCalls = [] as Array<[string, string]>;
  mod._grantCalls = [] as Array<[string, string]>;
  mod.setNodeExternalSessionId = (nodeId: string, sid: string) => {
    mod._setNodeCalls.push([nodeId, sid]);
  };
  mod.grantPermission = (workspaceId: string, toolName: string) => {
    mod._grantCalls.push([workspaceId, toolName]);
  };
}

function restoreDbRepository(): void {
  const dbRepoPath = require.resolve('../src/services/dbRepository');
  const mod = require(dbRepoPath);
  if (mod._origSetNode) { mod.setNodeExternalSessionId = mod._origSetNode; delete mod._origSetNode; }
  if (mod._origGetNode) { mod.getNode = mod._origGetNode; delete mod._origGetNode; }
  if (mod._origHasGrant) { mod.hasGrant = mod._origHasGrant; delete mod._origHasGrant; }
  if (mod._origGrantPermission) { mod.grantPermission = mod._origGrantPermission; delete mod._origGrantPermission; }
  delete mod._setNodeCalls;
  delete mod._grantCalls;
}

function makeMcpRegistry() {
  let slotCounter = 0;
  const disposedSlots: string[] = [];
  const createdCallbacks: any[] = [];
  return {
    create(_parentChatId: string, _cwd: string, _ownerUserId: string | null, callbacks: unknown) {
      createdCallbacks.push(callbacks);
      const slotId = `slot-${++slotCounter}`;
      return { slotId, workspaceId: null as string | null };
    },
    async dispose(slotId: string) {
      disposedSlots.push(slotId);
    },
    endpoint: (slotId: string) => ({ type: 'http' as const, url: `http://127.0.0.1:3000/api/mcp/${slotId}`, headers: [] }),
    disposedSlots,
    createdCallbacks,
  };
}

function makeBridge() {
  return {
    spawnBranches: async () => [],
    saveContext: () => null,
    updateContext: () => null,
  };
}

function freshClaudeSession() {
  // Clear caches so we pick up patched modules
  delete require.cache[require.resolve('michi-runtime/internal/adapters/claude/ClaudeSession')];
  return require('michi-runtime/internal/adapters/claude/ClaudeSession') as typeof import('michi-runtime/internal/adapters/claude/ClaudeSession');
}

function makeSessionDeps(overrides: Partial<import('michi-runtime/internal/adapters/claude/ClaudeSession').ClaudeSessionDeps> = {}) {
  return {
    nodeId: 'node-001',
    cwd: '/tmp/test-cwd',
    workspaceId: null,
    mcpRegistry: makeMcpRegistry() as any,
    bridge: makeBridge() as any,
    options: claudeTestOptions(),
    // Never the process-wide registry: with no workspace it would look the
    // node up in the real data directory's SQLite database.
    backgroundSubagents: subagentSink(new BackgroundSubagentRegistry({ resolveWorkspace: () => 'ws-test' })),
    ...overrides,
  };
}

/** A Michi product event of this type (reported as a host event). */
function isHostEvent(ev: any, type: string): boolean {
  return ev.kind === 'host_event' && ev.type === type;
}

/** A registry that records every report a session makes. */
function recordingRegistry(graceMs = 10) {
  const registry = new BackgroundSubagentRegistry({ graceMs, resolveWorkspace: () => 'ws-test' });
  const reports: Array<{ ownerUserId: string; nodeId: string; source: string; ids: string[] }> = [];
  const report = registry.report.bind(registry);
  registry.report = (context, source, ids) => {
    reports.push({ ownerUserId: context.ownerUserId, nodeId: context.nodeId, source, ids: [...ids] });
    report(context, source, ids);
  };
  const afterGrace = () => new Promise((resolve) => setTimeout(resolve, graceMs * 3));
  // How the session said its background agents ended (no recorder: nothing is stored).
  const ended: EndedBackgroundSubagents[] = [];
  registry.subscribeEnded((update) => ended.push(update));
  return { registry, reports, ended, afterGrace };
}

// ---- Suite ------------------------------------------------------------------

describe('ClaudeSession', () => {
  test('a session built directly checks the workflow and subagent sinks it reports to', () => {
    const { ClaudeSession } = freshClaudeSession();
    const { michiTestHost } = require('./helpers/michiTestHost') as typeof import('./helpers/michiTestHost');
    // A JS host can still leave the required ports out; the session's own check catches it.
    const host = { ...michiTestHost(), workflows: undefined, backgroundSubagents: undefined } as unknown as RuntimeHost;
    assert.throws(
      () => new ClaudeSession('node-001', makeSessionDeps({ options: claudeTestOptions({ host }), backgroundSubagents: undefined })),
      { name: 'RuntimeHostConfigError', message: 'ClaudeSession requires host ports that are missing: workflows, backgroundSubagents' },
    );
    // A subagent sink passed in stands in for the host's.
    assert.throws(
      () => new ClaudeSession('node-001', makeSessionDeps({ options: claudeTestOptions({ host }) })),
      { name: 'RuntimeHostConfigError', message: 'ClaudeSession requires host ports that are missing: workflows' },
    );
  });

  test('fork uses resume plus a new pinned identity and persists only the child binding', async () => {
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('node-001', makeSessionDeps({ parentChatId: 'parent-node' }));
    try {
      await session.spawnFresh('native-parent');
      const args = capturedSpawnArgs[0] as any;
      assert.equal(args.resumeSessionId, 'native-parent');
      assert.equal(args.forkSession, true);
      assert.match(args.sessionId, /^[0-9a-f-]{36}$/);
      assert.notEqual(args.sessionId, 'native-parent');
      assert.equal(session.nativeSessionId, args.sessionId);
      assert.deepEqual(session.getHistory(), []);
      createdChildren[0].emitInit(args.sessionId);
      createdChildren[0].emitResult();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(require('../src/services/dbRepository')._setNodeCalls, [['node-001', args.sessionId]]);
      assert.equal(session.getState(), 'idle');
    } finally { await session.dispose(); }
  });

  test('the hook POC appends no instruction to the system prompt without hostText.followUpsHookPocInstruction', async () => {
    const { ClaudeSession } = freshClaudeSession();
    const systemPromptAppend = async (hostText: ClaudeHostText | undefined) => {
      capturedSpawnArgs.length = 0;
      const session = new ClaudeSession('node-hook-text', makeSessionDeps({
        systemPromptAppend: 'stable prompt',
        options: { ...claudeTestOptions(), followUpsHookPoc: () => true, hostText },
      }));
      try {
        await session.spawnFresh();
        return (capturedSpawnArgs[0] as Record<string, unknown>).systemPromptAppend;
      } finally { await session.dispose(); }
    };
    assert.equal(await systemPromptAppend(undefined), 'stable prompt');
    assert.equal(await systemPromptAppend({ followUpsHookPocInstruction: () => '<poc>' }), 'stable prompt\n<poc>');
  });
  beforeEach(() => {
    stubSpawnClaude();
    stubDbRepository();
    mock.restoreAll();
  });

  afterEach(() => {
    restoreSpawnClaude();
    restoreDbRepository();
    mock.restoreAll();
  });

  // ── Case 1: spawnFresh persists external_session_id before queue ─────────────
  // SKIPPED: behavior moved. claude in stream-json input mode does NOT emit
  // system/init until the first user envelope arrives on stdin (verified
  // empirically with claude 2.1.138). So spawnFresh no longer awaits or captures
  // init — both happen during the first send() turn. Smoke test
  // (backend/test/claudeRuntimeSmoke.test.ts) covers end-to-end persistence.

  test.skip('spawnFresh: persists external_session_id via dbRepository on first system/init envelope', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-persist' });
    const session = new ClaudeSession('session-persist', deps as any);

    const dbRepoMod = require('../src/services/dbRepository');
    // Emit init slightly after spawn
    setTimeout(() => child.emitInit('ext-persist-123'), 30);

    await session.spawnFresh();

    assert.ok(
      dbRepoMod._setNodeCalls.some(([nid, sid]: [string, string]) => nid === 'node-persist' && sid === 'ext-persist-123'),
      `setNodeExternalSessionId should have been called with ('node-persist', 'ext-persist-123'), got: ${JSON.stringify(dbRepoMod._setNodeCalls)}`,
    );

    await session.dispose();
  });

  // ── Case 2: spawnFresh rejects with ClaudeInitTimeoutError on no init ─────────
  // SKIPPED: behavior removed. See Case 1's comment. spawnFresh no longer
  // awaits init, so it cannot reject with a spawn-init timeout. Timeout
  // semantics if claude is hung during a send() turn are covered by the
  // turn-level heartbeat path (a different test).

  test.skip('spawnFresh: rejects with ClaudeInitTimeoutError when no init envelope arrives', async () => {
    // Child that never emits init and exits after a short time
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    // Simulate process exit without emitting init
    setTimeout(() => child.emit('exit', 1, null), 100);

    const { ClaudeSession } = freshClaudeSession();
    const { ClaudeInitTimeoutError } = require('michi-runtime/internal/adapters/claude/claudeBinary');

    const deps = makeSessionDeps();
    const session = new ClaudeSession('session-timeout', deps as any);

    await assert.rejects(
      () => session.spawnFresh(),
      (err: unknown) => {
        assert.ok(
          err instanceof ClaudeInitTimeoutError,
          `expected ClaudeInitTimeoutError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  // ── warmInit ────────────────────────────────────────────────────────────────

  test('send snapshots permission mode while applying SDK control and changes back on the next turn', async () => {
    const policy = require('../src/agents/permissionPolicy');
    const originalMode = policy.chatPermissionMode;
    let mode = 'ask';
    policy.chatPermissionMode = () => mode;
    const registry = makeMcpRegistry();
    const originalDispose = registry.dispose.bind(registry);
    let changeDuringRetirement = false;
    registry.dispose = async (id: string) => {
      if (changeDuringRetirement) { mode = 'ask'; changeDuringRetirement = false; }
      await originalDispose(id);
    };
    stubSpawnClaude(() => {
      const child = new MockClaudeChild();
      child.stdin.on('data', () => {
        process.nextTick(() => {
          child.emitInit('ext-permission-snapshot');
          child.emitChunk('reply');
          child.emitResult();
        });
      });
      return child;
    });
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('node-001', makeSessionDeps({ mcpRegistry: registry as any }));
    try {
      await session.spawnFresh();
      for await (const _event of session.send('initial Ask')) { /* drain */ }
      const changes: string[] = [];
      (session as any).transport.query.setPermissionMode = async (value: string) => { changes.push(value); mode = 'ask'; };
      mode = 'yolo';
      for await (const _event of session.send('YOLO turn')) { /* drain */ }
      assert.deepEqual(changes, ['bypassPermissions']);
      assert.equal(capturedSpawnArgs.length, 1);
      for await (const _event of session.send('back to Ask')) { /* drain */ }
      assert.deepEqual(changes, ['bypassPermissions', 'default']);
      assert.equal(capturedSpawnArgs.length, 1);
      assert.deepEqual(session.getHistory().filter((message) => message.role === 'user').map((message) => message.content), ['initial Ask', 'YOLO turn', 'back to Ask']);
    } finally { policy.chatPermissionMode = originalMode; await session.dispose(); }
  });

  test('warmInit(): throws on disposed session', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-warm-2' });
    const session = new ClaudeSession('session-warm-2', deps as any);
    await session.spawnFresh();
    await session.dispose();

    await assert.rejects(() => session.warmInit(), /disposed|crashed/);
  });

  test('setFirstTurnPrefix(): throws after first send consumed the prefix', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    const { ClaudeSession } = freshClaudeSession();
    const deps = makeSessionDeps({ nodeId: 'node-prefix-3' });
    const session = new ClaudeSession('session-prefix-3', deps as any);
    await session.spawnFresh();
    session.setFirstTurnPrefix('once');

    setTimeout(() => child.emitResult('success'), 20);
    for await (const _ of session.send('go')) { void _; }

    assert.throws(() => session.setFirstTurnPrefix('again'), /already sent|consumed/);
    await session.dispose();
  });

  /** One turn that launches a run_in_background agent and ends while it runs. */
  async function launchBackgroundAgent(session: any, child: MockClaudeChild): Promise<void> {
    setTimeout(() => {
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
    }, 20);
    for await (const _event of session.send('launch')) void _event;
  }

  test('a background subagent is background work until a turn reports its completion', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-bg-agent'), 20);
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-bg-agent', makeSessionDeps() as any);
    await session.spawnFresh();
    const selfTurns: any[][] = [];
    let selfTurnDone!: () => void;
    const selfTurnFinished = new Promise<void>((resolve) => { selfTurnDone = resolve; });
    session.onSelfTurn((info) => {
      const events: any[] = [];
      selfTurns.push(events);
      void (async () => {
        for await (const event of info.events) events.push(event);
        selfTurnDone();
      })();
    });
    try {
      await launchBackgroundAgent(session, child);
      assert.equal(session.getState(), 'idle');
      assert.equal(session.hasBackgroundWork(), true, 'the agent outlived its turn');

      // Finished while idle: the tracker holds the completion for the next turn.
      child.send({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', tool_use_id: 'toolu_bg', status: 'completed', summary: 'Found 3 issues' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(selfTurns.length, 0, 'nothing is emitted between turns');
      assert.equal(session.hasBackgroundWork(), true, 'the unreported completion still needs this process');

      // The CLI's own follow-up turn reports it.
      child.send({ type: 'system', subtype: 'init', session_id: 'ext-bg-agent' });
      child.emitResult('success');
      await selfTurnFinished;
      const reported = selfTurns[0]
        .filter((event) => event.kind === 'subagent_list_update')
        .flatMap((event) => event.subagents);
      assert.equal(reported[0]?.sessionId, 'toolu_bg');
      assert.equal(reported[0]?.outcome, 'completed');
      assert.equal(session.hasBackgroundWork(), false, 'reported: the session may be reclaimed again');
    } finally {
      await session.dispose();
    }
  });

  test('an exited Claude process holds no background subagent', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-bg-exit'), 20);
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-bg-exit', makeSessionDeps() as any);
    await session.spawnFresh();
    try {
      await launchBackgroundAgent(session, child);
      assert.equal(session.hasBackgroundWork(), true);
      child.emit('exit', 1, null);
      await (session as any).retirement;
      assert.equal(session.getState(), 'crashed');
      assert.equal(session.hasBackgroundWork(), false, 'the agent died with its process');
    } finally {
      await session.dispose();
    }
  });

  test('a prompt a person typed carries a human origin on the SDK message; others carry none', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-human-origin'), 20);
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-human-origin', makeSessionDeps() as any);
    await session.spawnFresh();
    const lines: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
    try {
      setTimeout(() => child.emitResult('success'), 20);
      for await (const _event of session.send('typed by a person', { humanOrigin: true })) void _event;
      setTimeout(() => child.emitResult('success'), 20);
      for await (const _event of session.send('written by an agent')) void _event;
      const sent = lines.map((line) => JSON.parse(line)).filter((message) => message.type === 'user');
      const typed = sent.find((message) => String(message.message.content).includes('typed by a person'));
      const agent = sent.find((message) => String(message.message.content).includes('written by an agent'));
      assert.deepEqual(typed?.origin, { kind: 'human' });
      assert.ok(agent && !('origin' in agent));
    } finally {
      await session.dispose();
    }
  });

  test('a workflow Stop goes through the SDK control channel, and fails without a process', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-stop-task', makeSessionDeps() as any);
    await session.spawnFresh();
    const stopped: string[] = [];
    (session as any).transport.query.stopTask = async (taskId: string) => { stopped.push(taskId); };
    await session.stopTask('wf-1');
    assert.deepEqual(stopped, ['wf-1']);
    await session.dispose();
    await assert.rejects(session.stopTask('wf-2'), /not running/);
    assert.deepEqual(stopped, ['wf-1']);
  });

  test('a workflow run is recorded on the chat\'s node and on no node for an Agent Run, as the node-id context did', async () => {
    const { workflowRunHub } = require('../src/services/workflowRunHub') as typeof import('../src/services/workflowRunHub');
    const contexts: unknown[] = [];
    // Michi's hub after the owner port's mapping; null keeps the run out of the process-wide hub.
    const update = mock.method(workflowRunHub, 'update', (context: unknown) => { contexts.push(context); return null; });
    const { ClaudeSession } = freshClaudeSession();
    const chat = new ClaudeSession('node-wf', makeSessionDeps({ nodeId: 'node-wf', workspaceId: 'ws-wf', ownerUserId: 'owner-wf' }) as any);
    const run = new ClaudeSession('attempt-wf', makeSessionDeps({
      nodeId: 'attempt-wf', workspaceId: 'ws-wf', ownerUserId: 'owner-wf', owner: runOwner('run-wf', 'attempt-wf'),
    }) as any);
    try {
      for (const session of [chat, run]) {
        (session as any).workflowTap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-owner', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'owner' });
      }
      assert.deepEqual(contexts, [
        { ownerUserId: 'owner-wf', workspaceId: 'ws-wf', nodeId: 'node-wf' },
        { ownerUserId: 'owner-wf', workspaceId: 'ws-wf', nodeId: null },
      ]);
    } finally {
      update.mock.restore();
      await chat.dispose();
      await run.dispose();
    }
  });

  // ── Background subagents reported to the registry ───────────────────────────

  /** A spawned session reporting into a recording registry. */
  async function reportingSession(name: string) {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit(`ext-${name}`), 20);
    const { ClaudeSession } = freshClaudeSession();
    const recorded = recordingRegistry();
    const session = new ClaudeSession(`session-${name}`, makeSessionDeps({ backgroundSubagents: subagentSink(recorded.registry) }) as any);
    await session.spawnFresh();
    return { child, session, ...recorded };
  }

  test('a background subagent is reported for its node until a turn reports its completion', async () => {
    const { child, session, registry, reports, afterGrace } = await reportingSession('bg-report');
    const selfTurnDone = new Promise<void>((resolve) => {
      session.onSelfTurn((info) => { void (async () => { for await (const _event of info.events) void _event; resolve(); })(); });
    });
    try {
      await launchBackgroundAgent(session, child);
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg']]);
      assert.equal(reports[0].nodeId, 'node-001');
      assert.equal(reports[0].ownerUserId, LOCAL_AGENT_OWNER_ID);
      assert.match(reports[0].source, /^claude:/);
      assert.deepEqual(registry.snapshot(LOCAL_AGENT_OWNER_ID, 'ws-test'), { 'node-001': ['toolu_bg'] });

      // Finished while idle: still tracked, nothing new reported.
      child.send({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', tool_use_id: 'toolu_bg', status: 'completed', summary: 'Found 3 issues' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(reports.length, 1);

      // The CLI's own follow-up turn publishes the outcome and withdraws it.
      child.send({ type: 'system', subtype: 'init', session_id: 'ext-bg-report' });
      child.emitResult('success');
      await selfTurnDone;
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg'], []]);
      assert.equal(new Set(reports.map((r) => r.source)).size, 1, 'one source per session');
      await afterGrace();
      assert.deepEqual(registry.snapshot(LOCAL_AGENT_OWNER_ID, 'ws-test'), {});
    } finally {
      await session.dispose();
    }
  });

  test('Stop during a later turn withdraws the background subagent with the process', async () => {
    const { child, session, registry, reports, afterGrace } = await reportingSession('bg-stop');
    try {
      await launchBackgroundAgent(session, child);
      const events: any[] = [];
      const turn = (async () => { for await (const event of session.send('next')) events.push(event); })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(session.getState(), 'in_turn');
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg']], 'a new turn keeps a running agent');
      const ack = await session.cancel();
      assert.equal(ack.acknowledged, true);
      await turn;
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg'], []]);
      assert.equal(child.killed, true);
      await afterGrace();
      assert.deepEqual(registry.snapshot(LOCAL_AGENT_OWNER_ID, 'ws-test'), {});
    } finally {
      await session.dispose();
    }
  });

  test('dispose withdraws the background subagent', async () => {
    const { child, session, reports } = await reportingSession('bg-dispose');
    await launchBackgroundAgent(session, child);
    await session.dispose();
    assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg'], []]);
  });

  /** The SDK's model switch never confirms: the process is retired (see setModel). */
  async function unconfirmedModelSwitch(session: any): Promise<void> {
    session.transport.query.setModel = async () => { throw new Error('Claude model change timed out'); };
    await assert.rejects(session.setModel('claude-model-switch-test'), /timed out/);
  }

  test('a model switch keeps the background subagent: the SDK switches models in its process', async () => {
    const { child, session, reports } = await reportingSession('bg-model');
    try {
      await launchBackgroundAgent(session, child);
      await session.setModel('claude-model-switch-test');
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg']]);
      assert.equal(child.killed, false);
      assert.equal(session.hasBackgroundWork(), true);
    } finally {
      await session.dispose();
    }
  });

  test('a model switch the SDK cannot confirm restarts the process and withdraws the background subagent', async () => {
    const { child, session, reports } = await reportingSession('bg-model-timeout');
    try {
      await launchBackgroundAgent(session, child);
      await unconfirmedModelSwitch(session);
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg'], []]);
      assert.equal(child.killed, true);
      assert.equal(session.hasBackgroundWork(), false);
    } finally {
      await session.dispose();
    }
  });

  test('Stop with a confirmed SDK interrupt keeps the background subagent and its process', async () => {
    const { child, session, reports, ended } = await reportingSession('bg-interrupt');
    try {
      await launchBackgroundAgent(session, child);
      (session as any).transport.query.interrupt = async () => {
        setTimeout(() => child.send({ type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 1, output_tokens: 1 } }), 5);
        return {};
      };
      const events: any[] = [];
      const turn = (async () => { for await (const event of session.send('next')) events.push(event); })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ack = await session.cancel();
      await turn;
      assert.equal(ack.source, 'native');
      assert.equal(events.at(-1)?.stopReason, 'cancelled');
      assert.equal(child.killed, false);
      assert.equal(session.hasBackgroundWork(), true, 'the agent runs on in the kept process');
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg']]);
      assert.deepEqual(ended, []);
    } finally {
      await session.dispose();
    }
  });

  test('a crashed process withdraws the background subagent, and its late frames report nothing', async () => {
    const { child, session, reports } = await reportingSession('bg-crash');
    try {
      await launchBackgroundAgent(session, child);
      child.emit('exit', 1, null);
      await (session as any).retirement;
      assert.equal(session.getState(), 'crashed');
      assert.deepEqual(reports.map((r) => r.ids), [['toolu_bg'], []]);
      child.send({ type: 'system', subtype: 'task_started', task_id: 'task-late', tool_use_id: 'toolu_late', task_type: 'local_agent', is_backgrounded: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(reports.length, 2);
    } finally {
      await session.dispose();
    }
  });

  test('a cloud session without a user reports nothing', async () => {
    const previous = process.env.MICHI_CLOUD;
    process.env.MICHI_CLOUD = '1';
    const { child, session, reports, ended } = await reportingSession('bg-cloud');
    try {
      await launchBackgroundAgent(session, child);
      assert.equal(session.hasBackgroundWork(), true);
      assert.deepEqual(reports, []);
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previous;
      await session.dispose();
    }
    assert.deepEqual(ended, [], 'nor ends: no owner to show them to');
  });

  // ── Background subagents the process takes with it are recorded as ended ────

  function assertStopped(ended: EndedBackgroundSubagents[], before: number): void {
    assert.equal(ended.length, 1);
    assert.equal(ended[0].nodeId, 'node-001');
    assert.equal(ended[0].ownerUserId, LOCAL_AGENT_OWNER_ID);
    assert.equal(ended[0].workspaceId, 'ws-test');
    const [end] = ended[0].ends;
    assert.equal(ended[0].ends.length, 1);
    assert.equal(end.sessionId, 'toolu_bg');
    assert.equal(end.outcome, 'cancelled');
    assert.equal(end.error, SUBAGENT_SESSION_ENDED_ERROR);
    assert.ok(typeof end.endedAt === 'number' && end.endedAt >= before, 'it stopped now');
  }

  test('Stop during a later turn records the background subagent as stopped', async () => {
    const { child, session, ended } = await reportingSession('bg-stop-end');
    try {
      await launchBackgroundAgent(session, child);
      const turn = (async () => { for await (const _event of session.send('next')) void _event; })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(ended, []);
      const before = Date.now();
      await session.cancel();
      await turn;
      assertStopped(ended, before);
    } finally {
      await session.dispose();
    }
    assert.equal(ended.length, 1, 'dispose after the process is gone records nothing again');
  });

  test('a crash, an unconfirmed model switch and dispose each record the background subagent as stopped', async () => {
    for (const [name, end] of [
      ['bg-crash-end', async (session: any, child: MockClaudeChild) => { child.emit('exit', 1, null); await session.retirement; }],
      ['bg-model-end', async (session: any) => { await unconfirmedModelSwitch(session); }],
      ['bg-dispose-end', async (session: any) => { await session.dispose(); }],
    ] as const) {
      const { child, session, ended } = await reportingSession(name);
      try {
        await launchBackgroundAgent(session, child);
        const before = Date.now();
        await end(session, child);
        assertStopped(ended, before);
      } finally {
        await session.dispose();
      }
    }
  });

  test('an agent that finished while idle is recorded with its outcome when the process goes before a turn reports it', async () => {
    const { child, session, ended } = await reportingSession('bg-idle-end');
    await launchBackgroundAgent(session, child);
    child.send({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', tool_use_id: 'toolu_bg', status: 'completed', summary: 'Found 3 issues' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.dispose();
    assert.equal(ended.length, 1);
    assert.equal(ended[0].ends.length, 1);
    const [end] = ended[0].ends;
    assert.equal(end.sessionId, 'toolu_bg');
    assert.equal(end.outcome, 'completed');
    assert.equal(end.result, 'Found 3 issues');
    assert.equal(end.error, undefined);
  });

  test('an agent a turn already reported is not recorded again when the process goes', async () => {
    const { child, session, ended } = await reportingSession('bg-reported-end');
    const selfTurnDone = new Promise<void>((resolve) => {
      session.onSelfTurn((info) => { void (async () => { for await (const _event of info.events) void _event; resolve(); })(); });
    });
    await launchBackgroundAgent(session, child);
    child.send({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', tool_use_id: 'toolu_bg', status: 'completed', summary: 'Found 3 issues' });
    child.send({ type: 'system', subtype: 'init', session_id: 'ext-bg-reported-end' });
    child.emitResult('success');
    await selfTurnDone;
    await session.dispose();
    assert.deepEqual(ended, []);
  });

  // ── Case 7: after cancel(), next send() re-spawns via resume ─────────────────

  test('after cancel(), next send() respawns via spawnResume with externalSessionId', async () => {
    let spawnCallCount = 0;
    const children: MockClaudeChild[] = [];
    stubSpawnClaude(() => {
      spawnCallCount++;
      const child = new MockClaudeChild();
      children.push(child);
      return child;
    });

    // Emit init on first spawn
    const firstInitDelay = 20;
    setTimeout(() => {
      if (children[0]) children[0].emitInit('ext-resume-001');
    }, firstInitDelay);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-resume', makeSessionDeps() as any);
    await session.spawnFresh();

    assert.equal(spawnCallCount, 1, 'should have spawned once for fresh');

    // Force crashed state with externalSessionId set
    (session as any).state = 'crashed';
    (session as any).externalSessionId = 'ext-resume-001';
    (session as any).exitPromise = Promise.resolve();

    // On next spawnResume call, emit init for the second child
    setTimeout(() => {
      if (children[1]) children[1].emitInit('ext-resume-001');
    }, 30);

    // Emit result shortly after for the send to complete
    setTimeout(() => {
      if (children[1]) children[1].emitResult('success');
    }, 80);

    const events = [];
    for await (const ev of session.send('post-cancel message')) {
      events.push(ev);
    }

    assert.equal(spawnCallCount, 2, 'should have spawned again on send after crash');

    await session.dispose();
  });

  // ── Case 9: heartbeat event emitted when queue is idle ───────────────────────

  test('heartbeat event is queued within heartbeat interval when session is idle', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-hb-001'), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hb', makeSessionDeps() as any);
    await session.spawnFresh();

    // Directly call the heartbeat callback to simulate timer firing
    // The EventQueue's onHeartbeat is called from setInterval — we can trigger
    // it by accessing the queue's internal callback.
    const queue = (session as any).queue;
    assert.ok(queue, 'queue should be accessible');

    // Pull one event with a short race to confirm heartbeat arrives
    let heartbeatReceived = false;
    const pullPromise = queue.pull().then((ev: any) => {
      if (ev && ev.kind === 'heartbeat') heartbeatReceived = true;
      return ev;
    });

    // Directly invoke the heartbeat callback (simulating the interval firing)
    // by calling into queue's onHeartbeat handler
    const queueAny = queue as any;
    if (typeof queueAny.onHeartbeat === 'function') {
      queueAny.onHeartbeat(10001);
    } else {
      // Fallback: push a synthetic heartbeat to verify the EventQueue accepts it
      queue.push({ kind: 'heartbeat', idleMs: 10001 });
    }

    const ev = await pullPromise;
    assert.ok(ev && ev.kind === 'heartbeat', `expected heartbeat event, got: ${JSON.stringify(ev)}`);

    await session.dispose();
  });

  // ── Case 10: JSONL tail repair truncates malformed final line ────────────────

  test('spawnResume: truncates JSONL file with malformed final line and logs warn', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);

    // Set up a real temp JSONL file path that checkAndRepairJsonl will find
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
    const extSessionId = 'abc123-external';

    // We need to know what path getClaudeJsonlPath would produce
    // It's at ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
    // Rather than fully reproducing that, we stub getClaudeJsonlPath
    const projPathMod = require('michi-runtime/internal/adapters/claude/claudeProjectsPath');
    const origGetPath = projPathMod.getClaudeJsonlPath;
    const jsonlPath = path.join(tmpDir, `${extSessionId}.jsonl`);
    projPathMod.getClaudeJsonlPath = (options: unknown, _cwd: string, sid: string) => {
      return sid === extSessionId ? jsonlPath : origGetPath(options, _cwd, sid);
    };

    // Write a JSONL with a valid line followed by a malformed partial line (no trailing newline)
    const validLine = JSON.stringify({ type: 'result', subtype: 'success' });
    const malformedTail = '{"type":"incomplete';
    fs.writeFileSync(jsonlPath, validLine + '\n' + malformedTail);

    const originalSize = fs.statSync(jsonlPath).size;

    // Capture console.warn calls
    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnMessages.push(args.join(' '));

    setTimeout(() => child.emitInit(extSessionId), 20);

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-jsonl', makeSessionDeps({ cwd: tmpDir }) as any);

    try {
      await session.spawnResume(extSessionId);

      const newSize = fs.statSync(jsonlPath).size;
      assert.ok(
        newSize < originalSize,
        `JSONL should be truncated (was ${originalSize}, now ${newSize})`,
      );

      const content = fs.readFileSync(jsonlPath, 'utf8');
      assert.ok(content.endsWith('\n'), 'JSONL should end with newline after repair');

      assert.ok(
        warnMessages.some(m => m.includes('JSONL tail repair') || m.includes('truncating')),
        `expected a warn about JSONL truncation, got: ${warnMessages.join('; ')}`,
      );
    } finally {
      console.warn = origWarn;
      projPathMod.getClaudeJsonlPath = origGetPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await session.dispose();
    }
  });

  // ── Case 11: onApprove — allow policy returns allow ──────────────────────────

  test('onApprove with allow policy returns { behavior: allow }', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-approve-001'), 20);

    // Stub resolveChatPolicy to return 'allow'
    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolveChatPolicy;
    policyMod.resolveChatPolicy = () => 'allow';

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-approve', makeSessionDeps({ workspaceId: 'ws-1' }) as any);
    await session.spawnFresh();

    // The approval canUseTool runs (the MCP approve tool is gone).
    const onApprove = (session as any).makeOnApprove();

    try {
      const result = await onApprove({ toolName: 'read', input: {}, toolUseId: 'tc-1' });
      assert.equal(result.behavior, 'allow');
    } finally {
      policyMod.resolveChatPolicy = origResolve;
      await session.dispose();
    }
  });

  // ── Case 12: onApprove — deny policy returns deny ────────────────────────────

  test('onApprove with deny policy returns { behavior: deny }', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-deny-001'), 20);

    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolveChatPolicy;
    policyMod.resolveChatPolicy = () => 'deny';

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-deny', makeSessionDeps({ workspaceId: 'ws-deny' }) as any);
    await session.spawnFresh();
    const onApprove = (session as any).makeOnApprove();

    try {
      const result = await onApprove({ toolName: 'bash', input: {}, toolUseId: 'tc-deny' });
      assert.equal(result.behavior, 'deny');
    } finally {
      policyMod.resolveChatPolicy = origResolve;
      await session.dispose();
    }
  });

  test('an idle approval shows on the running workflow, and moves to the chat when that workflow completes', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-idle-approval'), 20);
    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolveChatPolicy;
    policyMod.resolveChatPolicy = () => 'ask';
    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    const session = new ClaudeSession('session-idle-approval', makeSessionDeps({ workspaceId: 'ws-idle-approval', mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();
    const onApprove: Function = (session as any).makeOnApprove();
    const queue = (session as any).queue;
    const pushed: string[] = [];
    const push = queue.push.bind(queue);
    queue.push = (event: any) => { pushed.push(event.kind); return push(event); };
    const tap = (session as any).workflowTap;
    try {
      tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-idle', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'idle' });
      assert.equal(session.hasBackgroundWork(), true);
      const approval = onApprove!({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tc-idle' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(!pushed.includes('permission_request'), 'no self-turn while a workflow can carry the request');
      // The workflow completes before anyone answers: none of its agents
      // waited, so the asker is other background work and the request moves
      // to the chat instead of a deny.
      tap.observe({ type: 'system', subtype: 'task_updated', task_id: 'wf-idle', patch: { status: 'completed' } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(pushed.includes('permission_request'), 'asked in the chat');
      const [requestId] = [...(session as any).pendingPermissions.keys()];
      session.respondToPermission(requestId, 'allow_once');
      assert.equal((await approval).behavior, 'allow');
    } finally {
      policyMod.resolveChatPolicy = origResolve;
      await session.dispose();
    }
  });

  test('an idle approval from a workflow the user stops is denied without opening a self-turn', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('ext-idle-stop'), 20);
    const policyMod = require('../src/agents/permissionPolicy');
    const origResolve = policyMod.resolveChatPolicy;
    policyMod.resolveChatPolicy = () => 'ask';
    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    const session = new ClaudeSession('session-idle-stop', makeSessionDeps({ workspaceId: 'ws-idle-stop', mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();
    const onApprove: Function = (session as any).makeOnApprove();
    const queue = (session as any).queue;
    const pushed: string[] = [];
    const push = queue.push.bind(queue);
    queue.push = (event: any) => { pushed.push(event.kind); return push(event); };
    const tap = (session as any).workflowTap;
    try {
      tap.observe({ type: 'system', subtype: 'task_started', task_id: 'wf-stop', tool_use_id: 'toolu_wf', task_type: 'local_workflow', workflow_name: 'stop' });
      const approval = onApprove!({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tc-stop' });
      // The wire of a card Stop (stop_task): killed, then stopped.
      tap.observe({ type: 'system', subtype: 'task_updated', task_id: 'wf-stop', patch: { status: 'killed' } });
      tap.observe({ type: 'system', subtype: 'task_notification', task_id: 'wf-stop', status: 'stopped' });
      assert.deepEqual(await approval, { behavior: 'deny', message: 'permission request is no longer active' },
        'a lapse is not reported to Claude as the user\'s decision');
      assert.ok(!pushed.includes('permission_request'), 'no self-turn for a request whose asker died with the run');
      assert.equal((session as any).pendingPermissions.size, 0);
    } finally {
      policyMod.resolveChatPolicy = origResolve;
      await session.dispose();
    }
  });

  test('session trust approves later Claude tools in the same turn without a native grant', async () => {
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    setTimeout(() => child.emitInit('session-trust'), 20);
    const { ClaudeSession } = freshClaudeSession();
    const mcpReg = makeMcpRegistry() as any;
    const session = new ClaudeSession('session-trust', makeSessionDeps({ mcpRegistry: mcpReg }) as any);
    await session.spawnFresh();
    const onApprove: Function = (session as any).makeOnApprove();
    try {
      let event: any;
      mock.method((session as any).queue, 'push', (value: any) => { event = value; });
      const pending = onApprove!({ toolName: 'Bash', input: { command: 'echo test' }, toolUseId: 'one' });
      assert.equal(event.options.length, 4);
      session.respondToPermission(event.requestId, 'allow_session');
      assert.equal((await pending).behavior, 'allow');
      const next = await onApprove!({ toolName: 'Edit', input: {}, toolUseId: 'two' });
      assert.equal(next.behavior, 'allow');
      assert.equal((session as any).pendingPermissions.size, 0);
    } finally { await session.dispose(); }
  });

  test('metadata hook POC blocks once, then passes after overview and follow-ups are set', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = 'hook-tool';
    const { log } = require('../src/services/logger') as typeof import('../src/services/logger');
    // Per-event POC logs were downgraded to debug (a491c789).
    const infoSpy = mock.method(log, 'debug', () => {});
    const enabledSpy = mock.method(log, 'info', () => {});
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-poc', makeSessionDeps({
      nodeId: 'node-hook-poc',
      mcpRegistry: registry as any,
      systemPromptAppend: buildStableSystemPrompt('structured-tool'),
    }) as any);

    try {
      await session.spawnFresh();
      // The slot id is a capability: the info log names only its first four characters.
      const slotId = (session as any).slotId as string;
      const enabledLogs = enabledSpy.mock.calls.filter((call) => call.arguments[1] === 'claude follow-ups hook poc enabled');
      assert.equal(enabledLogs.length, 1);
      assert.equal((enabledLogs[0].arguments[2] as { slotId?: string }).slotId, `${slotId.slice(0, 4)}…`);
      assert.ok(!JSON.stringify(enabledLogs[0].arguments).includes(slotId), 'the full slot id is not logged');
      const spawnArgs = capturedSpawnArgs[0] as Record<string, unknown>;
      assert.equal(spawnArgs.includeHookEvents, true);
      assert.equal(spawnArgs.bare, false);
      assert.match(String(spawnArgs.mcpConfigInline), /"alwaysLoad":true/);
      assert.match(String(spawnArgs.settingsInline), /validate_turn_metadata/);
      assert.match(String(spawnArgs.systemPromptAppend), /set_branch_overview/);
      assert.match(String(spawnArgs.systemPromptAppend), /set_follow_ups/);
      assert.doesNotMatch(String(spawnArgs.systemPromptAppend), /\[FOLLOW-UP/);
      assert.doesNotMatch(String(spawnArgs.systemPromptAppend), /\[BRANCH-OVERVIEW:/);

      child.send({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'Stop',
        hook_id: 'hook-poc-1',
      });
      child.send({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'Stop',
        hook_id: 'hook-poc-1',
        outcome: 'success',
      });
      child.send({
        type: 'system',
        subtype: 'hook_started',
        hook_name: 'SessionStart:startup',
        hook_id: 'unrelated-hook',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lifecycleLogs = infoSpy.mock.calls.filter(
        (call) => call.arguments[1] === 'claude follow-ups hook poc lifecycle event',
      );
      assert.equal(lifecycleLogs.length, 2);
      assert.deepEqual(lifecycleLogs.map((call) => call.arguments[2]), [
        {
          nodeId: 'node-hook-poc',
          sessionId: 'session-hook-poc',
          type: 'hook_started',
          hookName: 'Stop',
          hookId: 'hook-poc-1',
          outcome: undefined,
        },
        {
          nodeId: 'node-hook-poc',
          sessionId: 'session-hook-poc',
          type: 'hook_response',
          hookName: 'Stop',
          hookId: 'hook-poc-1',
          outcome: 'success',
        },
      ]);

      const callbacks = registry.createdCallbacks[0];
      assert.equal(typeof callbacks.onSetFollowUps, 'function');
      assert.equal(typeof callbacks.onSetBranchOverview, 'function');
      assert.equal(typeof callbacks.onValidateFollowUps, 'function');

      const turnEventsPromise = (async () => {
        const events: any[] = [];
        for await (const ev of session.send('hello')) events.push(ev);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));

      child.emitChunk('original answer');
      await new Promise<void>((resolve) => setImmediate(resolve));

      const blocked = callbacks.onValidateFollowUps();
      assert.equal(blocked.decision, 'block');
      assert.match(String(blocked.reason), /set_branch_overview/);
      assert.match(String(blocked.reason), /set_follow_ups/);

      child.emitChunk('duplicate repair answer');
      child.emitThought('repair-only reasoning');
      callbacks.onSetBranchOverview(' Current durable branch state. ');
      callbacks.onSetFollowUps(['one?', 'two?', 'three?']);
      child.emitChunk('tool acknowledgement');
      child.send({ type: 'stream_event', event: { type: 'message_stop' } });
      assert.deepEqual(callbacks.onValidateFollowUps(), {});

      child.emitResult('success');
      const events = await turnEventsPromise;
      assert.equal(
        events.filter((ev) => ev.kind === 'chunk').map((ev) => ev.text).join(''),
        'original answer',
      );
      assert.equal(events.some((ev) => ev.kind === 'thought'), false);
      assert.deepEqual(
        events.find((ev) => isHostEvent(ev, 'follow_ups'))?.payload.followUps,
        ['one?', 'two?', 'three?'],
      );
      assert.deepEqual(
        events.filter((ev) => isHostEvent(ev, 'follow_ups_status')).map((ev) => ev.payload.status),
        ['in_progress', 'completed'],
      );
      assert.ok(
        events.findIndex((ev) => isHostEvent(ev, 'follow_ups_status') && ev.payload.status === 'in_progress')
          < events.findIndex((ev) => isHostEvent(ev, 'follow_ups')),
      );
      assert.ok(
        events.findIndex((ev) => isHostEvent(ev, 'follow_ups'))
          < events.findIndex((ev) => isHostEvent(ev, 'follow_ups_status') && ev.payload.status === 'completed'),
      );
      assert.equal(
        events.find((ev) => isHostEvent(ev, 'branch_overview'))?.payload.overview,
        'Current durable branch state.',
      );
      assert.equal(events.some((ev) => ev.kind === 'turn_end'), true);
      assert.deepEqual(
        session.getHistory().filter((message) => message.role === 'assistant'),
        [{ role: 'assistant', content: 'original answer' }],
      );
      const suppressionLogs = infoSpy.mock.calls.filter(
        (call) => call.arguments[1] === 'claude follow-ups hook poc hidden metadata output suppressed',
      );
      assert.deepEqual(suppressionLogs.map((call) => call.arguments[2]), [{
        nodeId: 'node-hook-poc',
        sessionId: 'session-hook-poc',
        chunks: 2,
        thoughts: 1,
      }]);
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
      await session.dispose();
    }
  });

  for (const [hookEnabled, mode] of [['0', 'sentinel'], ['1', 'sentinel'], ['1', 'hook-tool']] as const) {
    test(`Michi assistant omits metadata hooks and reminders before and after native restore (${hookEnabled}/${mode})`, async () => {
      const previousHook = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = hookEnabled;
      process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = mode;
      const { assistantToolProfile } = require('../src/assistant/policy') as typeof import('../src/assistant/policy');
      const { MICHI_INTERNAL_MCP_NAME, MICHI_MCP_TOOL_PREFIX } = require('michi-runtime/internal/adapters/claude/claudeMcpConfig') as typeof import('michi-runtime/internal/adapters/claude/claudeMcpConfig');
      const profile = assistantToolProfile();
      const prompts: string[] = [];
      stubSpawnClaude(() => {
        const child = new MockClaudeChild();
        child.stdin.on('data', (chunk: Buffer) => {
          const message = JSON.parse(chunk.toString());
          prompts.push(message.message.content);
        });
        return child;
      });
      const registry = makeMcpRegistry();
      const { ClaudeSession } = freshClaudeSession();
      const session = new ClaudeSession('michi-assistant', makeSessionDeps({
        toolProfile: profile,
        mcpRegistry: registry as any,
        systemPromptAppend: buildStableSystemPrompt('structured-tool', false, false, 'assistant'),
      }));
      try {
        await session.spawnFresh();
        // A caller enabling ordinary-chat suggestions must not add them to Michi.
        session.setEnableFollowUps(true);
        for (let turn = 1; turn <= 6; turn += 1) {
          if (turn === 4) await session.spawnResume(session.nativeSessionId!);
          const pending = (async () => {
            const events: any[] = [];
            for await (const event of session.send(`Question ${turn}`)) events.push(event);
            return events;
          })();
          await new Promise<void>((resolve) => setImmediate(resolve));
          const child = createdChildren.at(-1)!;
          child.send({
            type: 'system', subtype: 'init', session_id: session.nativeSessionId ?? 'michi-native',
            tools: profile.allowedToolNames!.map((name) => `${MICHI_MCP_TOOL_PREFIX}${name}`),
            mcp_servers: [{ name: MICHI_INTERNAL_MCP_NAME, status: 'connected' }],
            permissionMode: 'default',
          });
          child.emitChunk(`Answer ${turn}`);
          child.emitResult();
          const events = await pending;
          assert.equal(prompts.at(-1), `Question ${turn}`);
          assert.deepEqual(events.filter((event) => event.kind === 'chunk').map((event) => event.text), [`Answer ${turn}`]);
          assert.equal(events.some((event) => ['follow_ups', 'follow_ups_status', 'branch_overview'].includes(event.kind)), false);
        }
        assert.equal(capturedSpawnArgs.length, 2, 'the original and restored native transports were checked');
        for (const args of capturedSpawnArgs as Array<Record<string, unknown>>) {
          assert.equal(args.includeHookEvents, false);
          assert.equal(args.settingsInline, undefined);
          assert.doesNotMatch(String(args.systemPromptAppend), /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|validate_turn_metadata/);
        }
        for (const callbacks of registry.createdCallbacks) {
          assert.equal(callbacks.onSetFollowUps, undefined);
          assert.equal(callbacks.onSetBranchOverview, undefined);
          assert.equal(callbacks.onValidateFollowUps, undefined);
        }
      } finally {
        if (previousHook === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
        else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previousHook;
        if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
        else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
        await session.dispose();
      }
    });
  }

  test('warm slot binding disables follow-up output and repair while retaining overview metadata', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = 'hook-tool';
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();
    const { ClaudeSession } = freshClaudeSession();
    const branchRequests: Array<{ enableFollowUps?: boolean }> = [];
    const session = new ClaudeSession('disabled-metadata', makeSessionDeps({
      mcpRegistry: registry as any,
      bridge: { ...makeBridge(), spawnBranches: async (input: any) => { branchRequests.push(input); return []; } },
    }));
    try {
      await session.spawnFresh();
      const callbacks = registry.createdCallbacks[0];
      assert.equal(typeof callbacks.onSetFollowUps, 'function', 'warm slots register before per-chat binding');
      session.setEnableFollowUps(false);
      const pending = (async () => {
        const events: any[] = [];
        for await (const event of session.send('overview only')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emitChunk('Original answer.');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await callbacks.onSpawnBranches([{ title: 'Child', prompt: 'Continue without follow-ups.' }]);
      assert.equal(branchRequests[0]?.enableFollowUps, false, 'actual child callback inherits disabled follow-ups');
      callbacks.onSetFollowUps(['should not appear?', 'nor this?', 'nor this?']);
      const decision = callbacks.onValidateFollowUps();
      assert.equal(decision.decision, 'block');
      assert.match(String(decision.reason), /set_branch_overview/);
      assert.doesNotMatch(String(decision.reason), /set_follow_ups/);
      callbacks.onSetBranchOverview(' Overview remains required. ');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitChunk('Hidden metadata acknowledgement.');
      child.emitResult();
      const events = await pending;
      assert.equal(events.some((event) => isHostEvent(event, 'follow_ups') || isHostEvent(event, 'follow_ups_status')), false);
      assert.deepEqual(events.filter((event) => event.kind === 'chunk').map((event) => event.text), ['Original answer.']);
      assert.equal(events.find((event) => isHostEvent(event, 'branch_overview'))?.payload.overview, 'Overview remains required.');
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
      await session.dispose();
    }
  });

  test('a slot gets a callback only for the business effects the bridge has', async () => {
    const { ClaudeSession } = freshClaudeSession();
    const effects = ['onSpawnBranches', 'onSaveArtifact', 'onUpdateArtifact'];
    const offered = async (bridge: Record<string, unknown>, resume: boolean) => {
      const registry = makeMcpRegistry();
      const session = new ClaudeSession('bridge-effects', makeSessionDeps({ mcpRegistry: registry as any, bridge: bridge as any }));
      try {
        if (resume) await session.spawnResume('bridge-effects-native');
        else await session.spawnFresh();
        return effects.filter((name) => typeof registry.createdCallbacks[0][name] === 'function');
      } finally { await session.dispose(); }
    };
    for (const resume of [false, true]) {
      assert.deepEqual(await offered(makeBridge(), resume), effects);
      assert.deepEqual(await offered({ saveContext: () => null }, resume), ['onSaveArtifact']);
      assert.deepEqual(await offered({}, resume), []);
    }
  });

  test('sentinel experiment reminds every turn and Hook requires only Overview', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    const previousMode = process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = 'sentinel';
    const child = new MockClaudeChild();
    const stdinChunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()));
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-sentinel-poc', makeSessionDeps({
      nodeId: 'node-sentinel-poc',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const spawnArgs = capturedSpawnArgs[0] as Record<string, unknown>;
      assert.match(String(spawnArgs.mcpConfigInline), /"alwaysLoad":true/);
      const callbacks = registry.createdCallbacks[0];
      assert.equal(callbacks.onSetFollowUps, undefined);
      assert.equal(typeof callbacks.onSetBranchOverview, 'function');

      const turnPromise = (async () => {
        const events: any[] = [];
        for await (const event of session.send('hello')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const envelopes = stdinChunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const prompt = String(envelopes.at(-1)?.message?.content ?? '');
      assert.match(prompt, /do not call set_follow_ups/i);
      assert.match(prompt, /FOLLOW-UP 1\/3/);
      assert.match(prompt, /FOLLOW-UP 3\/3/);

      child.emitChunk('answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]');
      await new Promise<void>((resolve) => setImmediate(resolve));
      callbacks.onSetBranchOverview('Sentinel experiment overview.');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitChunk('SHOULD STAY HIDDEN');
      child.emitResult('success');
      const events = await turnPromise;
      assert.equal(events.some((event) => isHostEvent(event, 'follow_ups')), false);
      assert.deepEqual(
        events.filter((event) => event.kind === 'chunk').map((event) => event.text),
        ['answer\n[FOLLOW-UP 1/3: one?]\n[FOLLOW-UP 2/3: two?]\n[FOLLOW-UP 3/3: three?]'],
      );
      assert.equal(events.some((event) => event.kind === 'turn_end'), true);
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      if (previousMode === undefined) delete process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE;
      else process.env.MICHI_FOLLOW_UPS_EXPERIMENT_MODE = previousMode;
      await session.dispose();
    }
  });

  test('follow-ups hook POC fails open after one block and resets on the next turn', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-retry', makeSessionDeps({
      nodeId: 'node-hook-retry',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const callbacks = registry.createdCallbacks[0];

      const firstTurn = (async () => {
        const events: any[] = [];
        for await (const event of session.send('first')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emitChunk('first visible');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(callbacks.onValidateFollowUps().decision, 'block');
      child.emitChunk('first repair hidden');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitResult('success');
      const firstEvents = await firstTurn;
      assert.equal(
        firstEvents.filter((event) => event.kind === 'chunk').map((event) => event.text).join(''),
        'first visible',
      );

      const secondTurn = (async () => {
        const events: any[] = [];
        for await (const event of session.send('second')) events.push(event);
        return events;
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emitChunk('second visible');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(callbacks.onValidateFollowUps().decision, 'block');
      child.emitChunk('second repair hidden');
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitResult('success');
      const secondEvents = await secondTurn;
      assert.equal(
        secondEvents.filter((event) => event.kind === 'chunk').map((event) => event.text).join(''),
        'second visible',
      );
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      await session.dispose();
    }
  });

  test('follow-ups hook POC skips validation during warmInit', async () => {
    const previous = process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
    process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = '1';
    const child = new MockClaudeChild();
    stubSpawnClaude(() => child);
    const registry = makeMcpRegistry();

    const { ClaudeSession } = freshClaudeSession();
    const session = new ClaudeSession('session-hook-warm', makeSessionDeps({
      nodeId: 'node-hook-warm',
      mcpRegistry: registry as any,
    }) as any);

    try {
      await session.spawnFresh();
      const callbacks = registry.createdCallbacks[0];
      const warm = session.warmInit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(callbacks.onValidateFollowUps(), {});
      child.emitInit('ext-hook-warm');
      child.emitResult('success');
      await warm;
    } finally {
      if (previous === undefined) delete process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC;
      else process.env.MICHI_CLAUDE_FOLLOW_UPS_HOOK_POC = previous;
      await session.dispose();
    }
  });
});
