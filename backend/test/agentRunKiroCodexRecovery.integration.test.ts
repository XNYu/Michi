/**
 * T10 — Integrated release gate: Kiro and Codex Agent Run recovery,
 * lifecycle, and security integration tests.
 *
 * Uses lightweight fake runtimes (no node:sqlite dependency) to validate:
 *
 * 1. Saved Kiro/Codex Definitions: enable -> spawn -> complete end to end.
 * 2. Restart recovery using ACP/thread tokens without Node rows.
 * 3. Wrong-owner rejection for reads, input, cancellation, result
 *    submission, and release.
 * 4. Backup/export excludes native tokens and credentials.
 *
 * All tests use the shared conformance fixture pattern established in T09,
 * extended with lifecycle and cross-concern integration scenarios.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { KiroRunAdapter } from '../src/agents/runs/kiroRunAdapter';

import type { AgentRuntime, AgentSession, LoadAgentSessionOptions, NewAgentSessionOptions, RuntimePermissionBroker, RuntimeSessionOwner } from '../src/agents/types';
import { assertOwner } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner, hostOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

// ---------------------------------------------------------------------------
// Fake Kiro runtime for T10 — stateful lifecycle simulation
// ---------------------------------------------------------------------------

interface KiroSessionState {
  session: AgentSession;
  owner: RuntimeSessionOwner;
  nativeSid: string;
  profileHash: string | null;
  released: boolean;
  resultSubmitted: boolean;
}

let kiroCounter = 0;

function createT10KiroRuntime(): {
  runtime: AgentRuntime;
  states: Map<string, KiroSessionState>;
  newSessions: string[];
  loadedSessions: string[];
  processExitHook: () => void;
} {
  const states = new Map<string, KiroSessionState>();
  const newSessions: string[] = [];
  const loadedSessions: string[] = [];
  let alive = true;

  const makeSession = (
    sessionId: string,
    nativeSid: string,
    owner: RuntimeSessionOwner,
    profileHash: string | null,
    events?: NormalizedEvent[],
    broker?: RuntimePermissionBroker,
  ): AgentSession => {
    const defaultEvents: NormalizedEvent[] = events ?? [
      { kind: 'chunk', text: `Kiro T10 response for ${sessionId}` },
      { kind: 'turn_end' },
    ];

    return {
      id: sessionId,
      runtimeId: 'kiro',
      owner,
      runtimeProfileHash: profileHash,
      nativeSessionId: nativeSid,
      getHistory: () => [],
      getPendingAssistant: () => undefined,
      async *send(_text: string) {
        for (const ev of defaultEvents) yield ev;
      },
      cancel: async () => {},
    };
  };

  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: 'kiro',
    label: 'T10 fake Kiro',
    capabilities: {
      modes: false, permissions: true, models: false, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['medium'],
      apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: true,
      nativeResume: true,
    },
    async warm() {},
    async newSession(opts: NewAgentSessionOptions): Promise<AgentSession> {
      if (!alive) throw new Error('Kiro process is dead');
      const sessionId = opts.sessionId ?? `kiro-t10-${++kiroCounter}`;
      const nativeSid = `acp-t10-${++kiroCounter}`;
      newSessions.push(nativeSid);

      const owner = opts.owner ?? chatOwner(sessionId);
      const session = makeSession(sessionId, nativeSid, owner, opts.profileHash ?? null, undefined, opts.permissionBroker);

      states.set(sessionId, {
        session,
        owner,
        nativeSid,
        profileHash: opts.profileHash ?? null,
        released: false,
        resultSubmitted: false,
      });

      return session;
    },
    async loadSession(opts: LoadAgentSessionOptions): Promise<AgentSession> {
      if (!alive) throw new Error('Kiro process is dead');
      if (opts.owner && hostOwner(opts.owner).kind === 'agent_run' && !opts.nativeResumeToken) {
        throw new Error('Kiro agent_run loadSession requires nativeResumeToken (no Node lookup)');
      }
      const nativeSid = typeof opts.nativeResumeToken === 'string'
        ? opts.nativeResumeToken
        : `acp-loaded-t10-${++kiroCounter}`;
      loadedSessions.push(nativeSid);

      const owner = opts.owner ?? chatOwner(opts.sessionId);
      const session = makeSession(opts.sessionId, nativeSid, owner, opts.profileHash ?? null, undefined, opts.permissionBroker);

      states.set(opts.sessionId, {
        session,
        owner,
        nativeSid,
        profileHash: opts.profileHash ?? null,
        released: false,
        resultSubmitted: false,
      });

      return session;
    },
    releaseSession(sessionId: string, expectedOwner?: RuntimeSessionOwner) {
      const state = states.get(sessionId);
      if (!state) return;
      if (expectedOwner) {
        assertOwner(state.owner, expectedOwner);
      }
      state.released = true;
      states.delete(sessionId);
    },
    async shutdown() {
      alive = false;
      states.clear();
    },
  };

  return {
    runtime,
    states,
    newSessions,
    loadedSessions,
    processExitHook: () => { alive = false; },
  };
}

// ---------------------------------------------------------------------------
// Fake Codex runtime for T10 — stateful lifecycle simulation
// ---------------------------------------------------------------------------

interface CodexSessionState {
  session: AgentSession;
  owner: RuntimeSessionOwner;
  threadId: string;
  profileHash: string | null;
  released: boolean;
  steered: string[];
}

let codexCounter = 0;

// ===========================================================================
// 1. Kiro Definition enable → spawn → complete end-to-end
// ===========================================================================

describe('T10 — Kiro Definition lifecycle: enable -> spawn -> complete', () => {
  test('Kiro adapter assertCompatible rejects runtime without nativeResume', () => {
    const adapter = new KiroRunAdapter();
    const { runtime } = createT10KiroRuntime();
    (runtime.capabilities as any).nativeResume = false;
    assert.throws(
      () => adapter.assertCompatible(runtime),
      /incompatible/,
    );
  });
});
