/**
 * T09 — Pi Agent Run conformance tests.
 *
 * Runs the shared conformance suite against PiRuntime. Pi uses the `allowlist`
 * tool mode, `native` steering, and does NOT support native resume.
 */

import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import type {
  RuntimePermissionBroker,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../src/agents/types';
import {
  registerConformanceSuite,
  makeConformanceBroker,
  makeConformanceToolProfile,
  attemptIdOf,
  RUN_OWNER,
  type ConformanceHarness,
  type ConformanceSession,
} from './fixtures/runtimeRunConformance';

// ---------------------------------------------------------------------------
// Shared Pi test config
// ---------------------------------------------------------------------------

const agentConfig = {
  getAgentConfig: () => ({
    runtime: 'pi',
    provider: 'test',
    modelByRuntime: {},
    reasoningByRuntime: {},
  }),
  resolveModel: () => 'test-model',
  resolveReasoning: () => 'medium' as const,
};

const historyStore = {
  getNode: () => { throw new Error('Run must not query node history'); },
  listMessages: () => { throw new Error('Run must not query node messages'); },
  getWorkspace: () => null,
  getWorkspaceInstructions: () => null,
  hasGrant: () => false,
  grantPermission: () => {},
};

const bridge = {
  spawnBranches: async () => [],
  saveContext: () => null,
  updateContext: () => null,
};

// ---------------------------------------------------------------------------
// Pi conformance harness
// ---------------------------------------------------------------------------

function createPiHarness(): ConformanceHarness {
  configureRuntimeDeps({
    historyStore: historyStore as any,
    agentConfig,
    providerKeys: { getProviderApiKey: () => 'test-key' },
    dataDir: '/tmp/michi-pi-conformance',
  });

  const runtime = new PiRuntime(bridge as any);
  const adapter = new PiRunAdapter();

  return {
    runtimeLabel: 'Pi',
    adapter,

    async createRunSession(opts): Promise<ConformanceSession> {
      const session = await runtime.newSession({
        sessionId: attemptIdOf(opts.owner),
        cwd: process.cwd(),
        owner: opts.owner,
        profileHash: opts.profileHash ?? null,
        toolProfile: opts.toolProfile ?? makeConformanceToolProfile(),
        permissionBroker: opts.permissionBroker,
        workspaceId: opts.workspaceId ?? 'ws-conformance',
        ownerUserId: 'user-conformance',
        bootstrapInstructions: 'Conformance test instructions.',
        replayHistory: [],
      });

      return {
        session,
        nativeSessionId: session.nativeSessionId ?? null,
      };
    },

    // Pi does NOT support native resume
    resumeRunSession: undefined,

    async releaseSession(sessionId, expectedOwner) {
      runtime.releaseSession(sessionId, expectedOwner);
    },

    async releaseSessionWrongOwner(sessionId, wrongOwner) {
      // Pi's releaseSession silently no-ops when owners don't match (returns
      // without destroying the session). This is a valid "fail closed"
      // implementation that protects the real owner. We surface it as a throw
      // so the conformance suite can validate the owner guard.
      const beforeRelease = (runtime as any).sessions?.has?.(sessionId) ?? false;
      runtime.releaseSession(sessionId, wrongOwner);
      const afterRelease = (runtime as any).sessions?.has?.(sessionId) ?? false;
      if (beforeRelease && afterRelease) {
        // Session was NOT released — owner guard worked. Throw to satisfy the conformance assertion.
        throw new Error('Owner mismatch: Pi silently refused release for wrong owner');
      }
    },

    async cleanup() {
      await runtime.shutdown();
      clearAllSessions();
      __resetRuntimeDeps();
    },
  };
}

// ---------------------------------------------------------------------------
// Register shared conformance suite
// ---------------------------------------------------------------------------

registerConformanceSuite({
  test,
  describe,
  createHarness: createPiHarness,
});

// ---------------------------------------------------------------------------
// Pi-specific conformance extras
// ---------------------------------------------------------------------------

describe('Pi-specific conformance', () => {
  afterEach(() => {
    clearAllSessions();
    __resetRuntimeDeps();
  });

  test('Pi adapter declares no native resume', () => {
    const adapter = new PiRunAdapter();
    assert.equal(adapter.supportsNativeResume, false,
      'Pi must not claim native resume support');
  });

  test('Pi session uses replay history instead of native resume', async () => {
    const harness = createPiHarness();
    try {
      const { session } = await harness.createRunSession({
        owner: RUN_OWNER,
      });
      // Pi returns the session directly from newSession, never from loadSession
      assert.equal(session.id, RUN_OWNER.attemptId);
      // nativeSessionId is null for Pi (no native transport identity)
      assert.equal(session.nativeSessionId ?? null, null,
        'Pi sessions should not have a native session id');
    } finally {
      await harness.cleanup();
    }
  });

  test('Pi Run session does not query node history store', async () => {
    let nodeQueried = false;
    configureRuntimeDeps({
      historyStore: {
        getNode: () => { nodeQueried = true; throw new Error('Should not be called'); },
        listMessages: () => { nodeQueried = true; throw new Error('Should not be called'); },
        getWorkspace: () => null,
        getWorkspaceInstructions: () => null,
        hasGrant: () => false,
        grantPermission: () => {},
      } as any,
      agentConfig,
      providerKeys: { getProviderApiKey: () => 'test-key' },
      dataDir: '/tmp/michi-pi-conformance-hist',
    });

    const runtime = new PiRuntime(bridge as any);
    await runtime.newSession({
      sessionId: RUN_OWNER.attemptId,
      cwd: process.cwd(),
      owner: RUN_OWNER,
      bootstrapInstructions: 'test',
      replayHistory: [{ role: 'user', content: 'prior' }],
    });

    assert.equal(nodeQueried, false, 'Pi Run must not query node history');
    await runtime.shutdown();
    clearAllSessions();
    __resetRuntimeDeps();
  });
});
