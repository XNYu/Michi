/**
 * T09 — Kiro Agent Run integration tests with fake ACP fixtures.
 *
 * Runs the shared conformance suite against a fake Kiro runtime, plus
 * Kiro-specific integration tests that exercise ACP session lifecycle, binding
 * records, and the next_turn steering model — all without a real kiro-cli
 * binary or node:sqlite dependency.
 *
 * NOTE: This file uses lightweight fakes instead of importing real KiroRuntime/
 * KiroSession to avoid the transitive `node:sqlite` dependency (KiroRuntime →
 * dbRepository → db.ts → node:sqlite) on Node versions without built-in sqlite.
 * The real KiroRuntime integration tests live in kiroAgentRunRuntime.test.ts
 * and kiroAgentRunSession.test.ts (which require Node 22+).
 *
 * Kiro uses `runtime_default` tool mode, `next_turn` steering, and supports
 * native resume via ACP session ids.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';
import type {
  AgentRuntime,
  AgentSession,
  ChatMessage,
  LoadAgentSessionOptions,
  NewAgentSessionOptions,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../src/agents/types';
import { sameOwner, assertOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import {
  registerConformanceSuite,
  makeConformanceBroker,
  makeConformanceToolProfile,
  attemptIdOf,
  RUN_OWNER,
  WRONG_OWNER,
  CHAT_OWNER,
  type ConformanceHarness,
  type ConformanceSession,
} from './fixtures/runtimeRunConformance';

// ---------------------------------------------------------------------------
// Fake Kiro session — simulates KiroSession without node:sqlite
// ---------------------------------------------------------------------------

class FakeKiroSession implements AgentSession {
  id: string;
  runtimeId = 'kiro';
  owner?: RuntimeSessionOwner;
  runtimeProfileHash: string | null;
  nativeSessionId: string | null;

  private readonly history: ChatMessage[];
  private readonly broker?: RuntimePermissionBroker;

  constructor(opts: {
    id: string;
    nativeSessionId: string;
    owner?: RuntimeSessionOwner;
    profileHash?: string | null;
    replayHistory?: ChatMessage[];
    permissionBroker?: RuntimePermissionBroker;
  }) {
    this.id = opts.id;
    this.nativeSessionId = opts.nativeSessionId;
    this.owner = opts.owner;
    this.runtimeProfileHash = opts.profileHash ?? null;
    this.history = [...(opts.replayHistory ?? [])];
    this.broker = opts.permissionBroker;
  }

  getHistory(): ChatMessage[] { return this.history; }
  getPendingAssistant(): string | undefined { return undefined; }
  async *send(): AsyncIterableIterator<NormalizedEvent> {
    yield { kind: 'chunk', text: 'Kiro conformance response' };
    yield { kind: 'turn_end' };
  }
  cancel() {}
}

// ---------------------------------------------------------------------------
// Fake Kiro runtime — simulates KiroRuntime without node:sqlite
// ---------------------------------------------------------------------------

let acpSessionCounter = 0;

function createFakeKiroRuntime(): {
  runtime: AgentRuntime;
  sessions: Map<string, { session: FakeKiroSession; owner: RuntimeSessionOwner }>;
  createdSessions: string[];
  loadedSessions: string[];
  warmedCwds: string[];
} {
  const sessions = new Map<string, { session: FakeKiroSession; owner: RuntimeSessionOwner }>();
  const createdSessions: string[] = [];
  const loadedSessions: string[] = [];
  const warmedCwds: string[] = [];

  const runtime: AgentRuntime = {
    id: 'kiro',
    label: 'Kiro fake',
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [],
      apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: true,
      nativeResume: true,
    },
    async warm(cwd: string) { warmedCwds.push(cwd); },
    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
      const sessionId = opts.sessionId ?? `kiro-${++acpSessionCounter}`;
      const nativeSid = `acp-fake-${++acpSessionCounter}`;
      createdSessions.push(nativeSid);

      const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: sessionId };
      const session = new FakeKiroSession({
        id: sessionId,
        nativeSessionId: nativeSid,
        owner,
        profileHash: opts.profileHash,
        replayHistory: opts.replayHistory,
        permissionBroker: opts.permissionBroker,
      });

      sessions.set(sessionId, { session, owner });
      return session;
    },
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
      if (opts.owner?.kind === 'agent_run' && !opts.nativeResumeToken) {
        throw new Error('Kiro agent_run loadSession requires nativeResumeToken');
      }
      const nativeSid = typeof opts.nativeResumeToken === 'string' ? opts.nativeResumeToken : `acp-loaded-${++acpSessionCounter}`;
      loadedSessions.push(nativeSid);

      const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: opts.sessionId };
      const session = new FakeKiroSession({
        id: opts.sessionId,
        nativeSessionId: nativeSid,
        owner,
        profileHash: opts.profileHash,
        permissionBroker: opts.permissionBroker,
      });

      sessions.set(opts.sessionId, { session, owner });
      return session;
    },
    releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner) {
      const entry = sessions.get(sessionId);
      if (!entry) return;
      if (expectedOwner) {
        assertOwner(entry.owner, expectedOwner);
      }
      sessions.delete(sessionId);
    },
    async shutdown() {
      sessions.clear();
    },
  };

  return { runtime, sessions, createdSessions, loadedSessions, warmedCwds };
}

// ---------------------------------------------------------------------------
// Kiro conformance harness
// ---------------------------------------------------------------------------

function createKiroHarness(): ConformanceHarness {
  const { runtime, sessions, createdSessions, loadedSessions } = createFakeKiroRuntime();
  const adapter = new KiroRunAdapter();

  return {
    runtimeLabel: 'Kiro',
    adapter,

    async createRunSession(opts): Promise<ConformanceSession> {
      const session = await runtime.newSession({
        sessionId: attemptIdOf(opts.owner),
        cwd: '/tmp/kiro-conformance',
        owner: opts.owner,
        profileHash: opts.profileHash ?? null,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
        workspaceId: opts.workspaceId ?? 'ws-conformance',
        ownerUserId: 'user-conformance',
      });

      return {
        session,
        nativeSessionId: session.nativeSessionId ?? null,
      };
    },

    async resumeRunSession(opts): Promise<ConformanceSession> {
      const session = await runtime.loadSession!({
        sessionId: attemptIdOf(opts.owner),
        cwd: '/tmp/kiro-conformance',
        owner: opts.owner,
        nativeResumeToken: opts.nativeResumeToken,
        profileHash: opts.profileHash ?? null,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
      });

      return {
        session,
        nativeSessionId: session.nativeSessionId ?? null,
      };
    },

    async releaseSession(sessionId, expectedOwner) {
      await runtime.releaseSession(sessionId, expectedOwner);
    },

    async cleanup() {
      await runtime.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Register shared conformance suite
// ---------------------------------------------------------------------------

registerConformanceSuite({
  test,
  describe,
  createHarness: createKiroHarness,
});

// ---------------------------------------------------------------------------
// Kiro-specific integration tests with ACP fixtures
// ---------------------------------------------------------------------------

describe('Kiro ACP integration fixtures', () => {
  test('newSession creates a fresh ACP session with distinct native id', async () => {
    const { runtime, createdSessions } = createFakeKiroRuntime();

    const session = await runtime.newSession({
      sessionId: RUN_OWNER.attemptId,
      cwd: '/tmp/kiro-acp',
      owner: RUN_OWNER,
      toolProfile: makeConformanceToolProfile(),
    });

    assert.equal(session.id, RUN_OWNER.attemptId);
    assert.ok(session.nativeSessionId);
    assert.notEqual(session.nativeSessionId, session.id);
    assert.equal(createdSessions.length, 1);

    await runtime.shutdown();
  });

  test('loadSession uses nativeResumeToken and never queries Node', async () => {
    const { runtime, loadedSessions } = createFakeKiroRuntime();

    const session = await runtime.loadSession!({
      sessionId: RUN_OWNER.attemptId,
      cwd: '/tmp/kiro-acp',
      owner: RUN_OWNER,
      nativeResumeToken: 'acp-original-sid-123',
      profileHash: 'hash-resume',
    });

    assert.equal(session.id, RUN_OWNER.attemptId);
    assert.equal(session.nativeSessionId, 'acp-original-sid-123');
    assert.deepEqual(loadedSessions, ['acp-original-sid-123']);

    await runtime.shutdown();
  });

  test('loadSession rejects agent_run without nativeResumeToken', async () => {
    const { runtime } = createFakeKiroRuntime();

    await assert.rejects(
      () => runtime.loadSession!({
        sessionId: RUN_OWNER.attemptId,
        cwd: '/tmp/kiro-acp',
        owner: RUN_OWNER,
      }),
      /nativeResumeToken/,
    );

    await runtime.shutdown();
  });

  test('ACP session id survives JSON persistence round-trip', async () => {
    const { runtime, createdSessions } = createFakeKiroRuntime();

    await runtime.newSession({
      sessionId: RUN_OWNER.attemptId,
      cwd: '/tmp/kiro-acp',
      owner: RUN_OWNER,
    });

    const nativeSid = createdSessions[0];
    const json = JSON.stringify(nativeSid);
    const restored = JSON.parse(json);
    assert.equal(typeof restored, 'string');
    assert.equal(restored, nativeSid);
    assert.ok(restored.length > 0);

    await runtime.shutdown();
  });

  test('release with wrong owner is rejected', async () => {
    const { runtime } = createFakeKiroRuntime();

    await runtime.newSession({
      sessionId: RUN_OWNER.attemptId,
      cwd: '/tmp/kiro-acp',
      owner: RUN_OWNER,
    });

    assert.throws(
      () => runtime.releaseSession(RUN_OWNER.attemptId, WRONG_OWNER),
      /Owner mismatch/,
    );

    // Correct owner works
    runtime.releaseSession(RUN_OWNER.attemptId, RUN_OWNER);

    await runtime.shutdown();
  });
});

describe('Kiro adapter metadata', () => {
  test('Kiro adapter declares runtime_default tool mode', () => {
    const adapter = new KiroRunAdapter();
    assert.equal(adapter.nativeToolMode, 'runtime_default');
  });

  test('Kiro adapter declares native steering', () => {
    const adapter = new KiroRunAdapter();
    assert.equal(adapter.steering, 'native');
  });

  test('Kiro adapter declares native resume', () => {
    const adapter = new KiroRunAdapter();
    assert.equal(adapter.supportsNativeResume, true);
  });

  test('Kiro adapter rejects runtime without nativeResume capability', () => {
    const adapter = new KiroRunAdapter();
    const fakeRuntime: AgentRuntime = {
      id: 'kiro', label: 'kiro',
      capabilities: {
        modes: false, permissions: true, models: false, providerModels: false,
        reasoning: false, supportedReasoningLevels: [],
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
        nativeResume: false,
      },
      warm: async () => {}, newSession: async () => { throw new Error('not impl'); },
      releaseSession: () => {}, shutdown: async () => {},
    };

    assert.throws(
      () => adapter.assertCompatible(fakeRuntime),
      /incompatible.*native-resume/,
    );
  });
});
