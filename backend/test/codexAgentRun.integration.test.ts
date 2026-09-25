/**
 * T09 — Codex Agent Run integration tests with fake app-server fixtures.
 *
 * Runs the shared conformance suite against a fake Codex runtime, plus
 * Codex-specific integration tests that exercise thread lifecycle, MCP slot
 * ownership, approval routing, and the native steering model — all without a
 * real Codex binary, network, or node:sqlite dependency.
 *
 * NOTE: This file uses lightweight fakes instead of importing real CodexRuntime
 * to avoid the transitive `node:sqlite` dependency. The real CodexRuntime
 * integration tests live in codexAgentRunSession.test.ts (which require Node 22+).
 *
 * Codex uses `runtime_default` tool mode, `native` steering, and supports
 * native resume via app-server thread ids.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRunAdapter } from '../src/agents/runs/codexRunAdapter';
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
import { assertOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import {
  registerConformanceSuite,
  makeConformanceToolProfile,
  attemptIdOf,
  type ConformanceHarness,
  type ConformanceSession,
} from './fixtures/runtimeRunConformance';

// ---------------------------------------------------------------------------
// Fake Codex session — simulates CodexSession without node:sqlite
// ---------------------------------------------------------------------------

let threadCounter = 0;

class FakeCodexSession implements AgentSession {
  id: string;
  runtimeId = 'codex';
  owner?: RuntimeSessionOwner;
  runtimeProfileHash: string | null;
  nativeSessionId: string | null;

  private readonly history: ChatMessage[];

  constructor(opts: {
    id: string;
    nativeSessionId: string;
    owner?: RuntimeSessionOwner;
    profileHash?: string | null;
    replayHistory?: ChatMessage[];
  }) {
    this.id = opts.id;
    this.nativeSessionId = opts.nativeSessionId;
    this.owner = opts.owner;
    this.runtimeProfileHash = opts.profileHash ?? null;
    this.history = [...(opts.replayHistory ?? [])];
  }

  getHistory(): ChatMessage[] { return this.history; }
  getPendingAssistant(): string | undefined { return undefined; }
  async *send(): AsyncIterableIterator<NormalizedEvent> {
    yield { kind: 'chunk', text: 'Codex conformance response' };
    yield { kind: 'turn_end' };
  }
  cancel() {}
  async steer(text: string) { return { accepted: true }; }
}

// ---------------------------------------------------------------------------
// Fake Codex runtime — simulates CodexRuntime without node:sqlite
// ---------------------------------------------------------------------------

interface FakeSlot {
  owner?: RuntimeSessionOwner;
  nodeId: string | null;
  exposedToolNames?: ReadonlySet<string>;
  workspaceId: string | null;
}

function createFakeCodexRuntime(): {
  runtime: AgentRuntime;
  sessions: Map<string, { session: FakeCodexSession; owner: RuntimeSessionOwner }>;
  startedThreads: Array<{ model: string; cwd: string }>;
  resumedThreads: string[];
  slots: FakeSlot[];
} {
  const sessions = new Map<string, { session: FakeCodexSession; owner: RuntimeSessionOwner }>();
  const startedThreads: Array<{ model: string; cwd: string }> = [];
  const resumedThreads: string[] = [];
  const slots: FakeSlot[] = [];

  const runtime: AgentRuntime = {
    id: 'codex',
    label: 'Codex fake',
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: false, supportedReasoningLevels: [],
      apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      nativeResume: true,
    },
    async warm() {},
    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
      const sessionId = opts.sessionId ?? `codex-${++threadCounter}`;
      const threadId = `thread-fake-${++threadCounter}`;
      startedThreads.push({ model: opts.model ?? '', cwd: opts.cwd });

      const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: sessionId };

      // Track slot creation
      const slot: FakeSlot = {
        owner: opts.owner,
        nodeId: opts.owner?.kind === 'agent_run' ? null : sessionId,
        exposedToolNames: opts.toolProfile?.allowedToolNames
          ? new Set(opts.toolProfile.allowedToolNames)
          : undefined,
        workspaceId: opts.workspaceId ?? null,
      };
      slots.push(slot);

      const session = new FakeCodexSession({
        id: sessionId,
        nativeSessionId: threadId,
        owner,
        profileHash: opts.profileHash,
        replayHistory: opts.replayHistory,
      });

      sessions.set(sessionId, { session, owner });
      return session;
    },
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
      if (opts.owner?.kind === 'agent_run' && !opts.nativeResumeToken) {
        throw new Error('Codex agent_run loadSession requires nativeResumeToken (CodexSessionNotResumableError)');
      }
      const threadId = typeof opts.nativeResumeToken === 'string' ? opts.nativeResumeToken : `thread-resumed-${++threadCounter}`;
      resumedThreads.push(threadId);

      const owner = opts.owner ?? { kind: 'chat_node' as const, nodeId: opts.sessionId };
      const session = new FakeCodexSession({
        id: opts.sessionId,
        nativeSessionId: threadId,
        owner,
        profileHash: opts.profileHash,
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

  return { runtime, sessions, startedThreads, resumedThreads, slots };
}

// ---------------------------------------------------------------------------
// Codex conformance harness
// ---------------------------------------------------------------------------

function createCodexHarness(): ConformanceHarness {
  const { runtime } = createFakeCodexRuntime();
  const adapter = new CodexRunAdapter();

  return {
    runtimeLabel: 'Codex',
    adapter,

    async createRunSession(opts): Promise<ConformanceSession> {
      const session = await runtime.newSession({
        sessionId: attemptIdOf(opts.owner),
        cwd: '/tmp/codex-conformance',
        model: 'test-model',
        owner: opts.owner,
        profileHash: opts.profileHash ?? null,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
        workspaceId: opts.workspaceId ?? 'ws-conformance',
      });

      return {
        session,
        nativeSessionId: session.nativeSessionId ?? null,
      };
    },

    async resumeRunSession(opts): Promise<ConformanceSession> {
      const session = await runtime.loadSession!({
        sessionId: attemptIdOf(opts.owner),
        cwd: '/tmp/codex-conformance',
        model: 'test-model',
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
  createHarness: createCodexHarness,
});

// ---------------------------------------------------------------------------
// Codex-specific integration tests with app-server fixtures
// ---------------------------------------------------------------------------

describe('Codex adapter metadata', () => {
  test('Codex adapter declares runtime_default tool mode', () => {
    const adapter = new CodexRunAdapter();
    assert.equal(adapter.nativeToolMode, 'runtime_default');
  });
});
