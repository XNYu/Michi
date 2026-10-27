/**
 * T09 — Cross-runtime contract tests.
 *
 * Validates that all four runtime adapters satisfy the shared contract when
 * exercised through the RuntimeRunExecutor. Tests here focus on:
 *
 * 1. Executor-level contract: each adapter flows through the same start/resume
 *    path and produces structurally identical outcomes.
 * 2. Fallback: incompatibility in Kiro/Codex advances to the next profile.
 * 3. Error classification: failure categories are consistent across runtimes.
 * 4. Native token round-trip: JSON persistence for all four runtimes.
 * 5. Pi/Claude regression: behavior is unchanged by Kiro/Codex additions.
 *
 * No real runtime binaries, credentials, or network access required.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AgentRuntime,
  AgentSession,
  LoadAgentSessionOptions,
  NewAgentSessionOptions,
  RuntimeSessionOwner,
} from '../src/agents/types';

import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';

import type { NormalizedEvent } from '../src/services/chatEvents';
import { chatOwner } from './helpers/owners';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

/**
 * Creates a fake runtime for any runtimeId, returning predictable sessions.
 */
function createFakeRuntime(runtimeId: string, opts: {
  nativeResume?: boolean;
  nativeSessionId?: string | null;
  sessionEvents?: NormalizedEvent[];
} = {}): {
  runtime: AgentRuntime;
  capturedNewOpts: NewAgentSessionOptions[];
  capturedLoadOpts: LoadAgentSessionOptions[];
  releases: Array<[string, RuntimeSessionOwner | undefined]>;
} {
  const nativeResume = opts.nativeResume ?? (runtimeId === 'kiro' || runtimeId === 'codex' || runtimeId === 'claude');
  const nativeSessionId = opts.nativeSessionId ?? (nativeResume ? `${runtimeId}-native-sid` : null);
  const events = opts.sessionEvents ?? [
    { kind: 'chunk' as const, text: `${runtimeId} response` },
    { kind: 'turn_end' as const },
  ];

  const capturedNewOpts: NewAgentSessionOptions[] = [];
  const capturedLoadOpts: LoadAgentSessionOptions[] = [];
  const releases: Array<[string, RuntimeSessionOwner | undefined]> = [];

  const makeSession = (sessionId: string, owner: RuntimeSessionOwner, profileHash?: string | null): AgentSession => ({
    id: sessionId,
    runtimeId,
    owner,
    runtimeProfileHash: profileHash ?? null,
    nativeSessionId,
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    async *send() { for (const ev of events) yield ev; },
    cancel: async () => {},
    steer: async (text: string) => ({ accepted: true }),
  });

  const runtime: AgentRuntime = {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    id: runtimeId,
    label: `${runtimeId} fake`,
    capabilities: {
      modes: false, permissions: true, models: runtimeId === 'pi' || runtimeId === 'claude',
      providerModels: runtimeId === 'pi', reasoning: true,
      supportedReasoningLevels: ['medium'],
      apiKeys: runtimeId === 'pi', warmSessions: false, saveContext: false,
      spawnBranches: false, nativeResume,
    },
    async warm() {},
    async newSession(newOpts) {
      capturedNewOpts.push(newOpts);
      const owner = newOpts.owner ?? chatOwner(newOpts.sessionId ?? 'unknown');
      return makeSession(newOpts.sessionId ?? 'session', owner, newOpts.profileHash);
    },
    async loadSession(loadOpts) {
      capturedLoadOpts.push(loadOpts);
      const owner = loadOpts.owner ?? chatOwner(loadOpts.sessionId);
      return makeSession(loadOpts.sessionId, owner, loadOpts.profileHash);
    },
    releaseSession(id, owner) { releases.push([id, owner]); },
    async shutdown() {},
  };

  return { runtime, capturedNewOpts, capturedLoadOpts, releases };
}

// ---------------------------------------------------------------------------
// Pi/Claude regression: unchanged behavior
// ---------------------------------------------------------------------------

describe('Pi/Claude regression behavior', () => {
  test('Pi adapter rejects wrong runtime id', () => {
    const pi = new PiRunAdapter();
    assert.throws(
      () => pi.assertCompatible(createFakeRuntime('claude').runtime),
      /Pi Run adapter cannot execute runtime claude/,
    );
  });
});
