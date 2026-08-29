/**
 * T09 — Claude Agent Run conformance tests.
 *
 * Runs the shared conformance suite against a fake Claude runtime. Claude uses
 * the `allowlist` tool mode, `native` steering, and supports native resume.
 *
 * NOTE: This file uses a lightweight fake session instead of importing the real
 * ClaudeSession to avoid the transitive `node:sqlite` dependency (ClaudeSession
 * → db.ts → node:sqlite) on Node versions without built-in sqlite.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import type {
  AgentSession,
  ChatMessage,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../src/agents/types';
import { sameOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import {
  registerConformanceSuite,
  makeConformanceBroker,
  makeConformanceToolProfile,
  attemptIdOf,
  RUN_OWNER,
  WRONG_OWNER,
  type ConformanceHarness,
  type ConformanceSession,
} from './fixtures/runtimeRunConformance';

// ---------------------------------------------------------------------------
// Fake Claude session — avoids real ClaudeSession import (node:sqlite dep)
// ---------------------------------------------------------------------------

class FakeClaudeSession implements AgentSession {
  id: string;
  runtimeId = 'claude';
  owner: RuntimeSessionOwner;
  runtimeProfileHash: string | null;
  nativeSessionId: string | null;

  private readonly history: ChatMessage[];
  private readonly broker?: RuntimePermissionBroker;
  private readonly toolProfile?: RuntimeToolProfile;

  constructor(opts: {
    id: string;
    owner: RuntimeSessionOwner;
    profileHash?: string | null;
    nativeSessionId?: string | null;
    replayHistory?: ChatMessage[];
    permissionBroker?: RuntimePermissionBroker;
    toolProfile?: RuntimeToolProfile;
  }) {
    this.id = opts.id;
    this.owner = opts.owner;
    this.runtimeProfileHash = opts.profileHash ?? null;
    this.nativeSessionId = opts.nativeSessionId ?? null;
    this.history = [...(opts.replayHistory ?? [])];
    this.broker = opts.permissionBroker;
    this.toolProfile = opts.toolProfile;
  }

  getHistory(): ChatMessage[] { return this.history; }
  getPendingAssistant(): string | undefined { return undefined; }
  async *send(): AsyncIterableIterator<NormalizedEvent> {
    yield { kind: 'chunk', text: 'Claude conformance response' };
    yield { kind: 'turn_end' };
  }
  cancel() {}

  /** Simulate Claude's onApprove — broker-based for agent_run, direct for chat. */
  async approveToolCall(toolName: string, input: unknown, toolCallId: string): Promise<{ behavior: string; updatedInput?: unknown; message?: string }> {
    // Tool allowlist check
    if (this.toolProfile?.allowedToolNames && !this.toolProfile.allowedToolNames.includes(toolName)) {
      return { behavior: 'deny', message: 'tool is not enabled for this Agent Run' };
    }
    // Broker check for agent_run
    if (this.broker && this.owner.kind === 'agent_run') {
      const decision = await this.broker.requestPermission({
        owner: this.owner,
        ownerUserId: null,
        workspaceId: null,
        toolName,
        input,
        toolCallId,
      });
      if (decision === 'allow_once' || decision === 'allow_always') {
        return { behavior: 'allow', updatedInput: input };
      }
      if (decision === 'deny') return { behavior: 'deny' };
      // 'ask' falls through to yielded event
    }
    return { behavior: 'allow', updatedInput: input };
  }
}

// ---------------------------------------------------------------------------
// Claude conformance harness
// ---------------------------------------------------------------------------

function createClaudeHarness(): ConformanceHarness {
  const sessions = new Map<string, { session: FakeClaudeSession; owner: RuntimeSessionOwner }>();
  const adapter = new ClaudeRunAdapter();

  return {
    runtimeLabel: 'Claude',
    adapter,

    async createRunSession(opts): Promise<ConformanceSession> {
      const sessionId = attemptIdOf(opts.owner);

      // Simulate a real Claude session that receives a nativeSessionId from the CLI
      const syntheticNativeId = `claude-native-${sessionId}`;

      const session = new FakeClaudeSession({
        id: sessionId,
        owner: opts.owner,
        profileHash: opts.profileHash,
        nativeSessionId: syntheticNativeId,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
        replayHistory: [],
      });

      sessions.set(sessionId, { session, owner: opts.owner });

      return {
        session,
        nativeSessionId: syntheticNativeId,
      };
    },

    async resumeRunSession(opts): Promise<ConformanceSession> {
      const sessionId = attemptIdOf(opts.owner);

      const session = new FakeClaudeSession({
        id: sessionId,
        owner: opts.owner,
        profileHash: opts.profileHash,
        nativeSessionId: opts.nativeResumeToken,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
        replayHistory: [],
      });

      sessions.set(sessionId, { session, owner: opts.owner });

      return {
        session,
        nativeSessionId: opts.nativeResumeToken,
      };
    },

    async releaseSession(sessionId, expectedOwner) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`Session ${sessionId} not found`);
      if (!sameOwner(entry.owner, expectedOwner)) {
        throw new Error(
          `Owner mismatch: expected ${JSON.stringify(expectedOwner)}, got ${JSON.stringify(entry.owner)}`,
        );
      }
      sessions.delete(sessionId);
    },

    async releaseSessionWrongOwner(sessionId, wrongOwner) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`Session ${sessionId} not found`);
      if (!sameOwner(entry.owner, wrongOwner)) {
        throw new Error(
          `Owner mismatch: expected ${JSON.stringify(wrongOwner)}, got ${JSON.stringify(entry.owner)}`,
        );
      }
      sessions.delete(sessionId);
    },

    async cleanup() {
      sessions.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Register shared conformance suite
// ---------------------------------------------------------------------------

registerConformanceSuite({
  test,
  describe,
  createHarness: createClaudeHarness,
});

// ---------------------------------------------------------------------------
// Claude-specific conformance extras
// ---------------------------------------------------------------------------

describe('Claude-specific conformance', () => {
  test('Claude adapter declares native resume support', () => {
    const adapter = new ClaudeRunAdapter();
    assert.equal(adapter.supportsNativeResume, true,
      'Claude must support native resume');
  });

  test('Claude adapter declares allowlist tool mode', () => {
    const adapter = new ClaudeRunAdapter();
    assert.equal(adapter.nativeToolMode, 'allowlist',
      'Claude must use allowlist tool mode');
  });

  test('Claude adapter declares native steering', () => {
    const adapter = new ClaudeRunAdapter();
    assert.equal(adapter.steering, 'native',
      'Claude must use native steering');
  });

  test('Claude Run session permission broker replaces chat grant policy', async () => {
    const brokerRequests: RuntimePermissionRequest[] = [];
    const broker: RuntimePermissionBroker = {
      async requestPermission(req) {
        brokerRequests.push(req);
        return 'allow_once';
      },
    };

    const session = new FakeClaudeSession({
      id: RUN_OWNER.attemptId,
      owner: RUN_OWNER,
      toolProfile: { allowedToolNames: ['bash'] },
      permissionBroker: broker,
      profileHash: 'hash-perm',
    });

    // A tool in the allowlist is routed through the broker
    const result = await session.approveToolCall('bash', { command: 'ls' }, 'tc-1');
    assert.equal(result.behavior, 'allow');
    assert.equal(brokerRequests.length, 1);
    assert.deepEqual(brokerRequests[0].owner, RUN_OWNER);

    // A tool NOT in the allowlist is denied without calling the broker
    const denied = await session.approveToolCall('forbidden_tool', {}, 'tc-2');
    assert.equal(denied.behavior, 'deny');
    assert.equal(brokerRequests.length, 1, 'Broker should not be called for denied tools');
  });

  test('Claude adapter rejects runtime without native resume capability', () => {
    const adapter = new ClaudeRunAdapter();
    const fakeRuntime = {
      id: 'claude', label: 'claude',
      capabilities: {
        modes: false, permissions: true, models: true, providerModels: false,
        reasoning: true, supportedReasoningLevels: ['medium' as const],
        apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: false,
        nativeResume: false,
      },
      warm: async () => {}, newSession: async () => { throw new Error('not implemented'); },
      releaseSession: () => {}, shutdown: async () => {},
    };

    assert.throws(
      () => adapter.assertCompatible(fakeRuntime),
      /model\/native-resume/,
    );
  });
});
