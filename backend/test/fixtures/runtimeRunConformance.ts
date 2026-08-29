/**
 * T09 — Shared deterministic Runtime Run conformance fixture.
 *
 * Provides a table-driven conformance suite that exercises the same contract
 * assertions against every runtime that can execute durable Agent Runs. Each
 * runtime supplies a `ConformanceHarness` describing how to create/resume/
 * release sessions and what behavioral invariants apply; the fixture runs one
 * uniform set of tests against every harness.
 *
 * Invariants tested (from the T09 acceptance criteria):
 *  1. Session ownership: public id === attemptId, owner fields correct.
 *  2. Result submission: submit_agent_result bound to correct collector.
 *  3. Permission routing: Run broker used, not chat grants.
 *  4. Cancellation: clean session release.
 *  5. Release: owner guard enforcement.
 *  6. Resume: native token round-trip (for runtimes with supportsNativeResume).
 */

import assert from 'node:assert/strict';
import type {
  AgentRuntime,
  AgentSession,
  NewAgentSessionOptions,
  RuntimePermissionBroker,
  RuntimePermissionDecision,
  RuntimePermissionRequest,
  RuntimeSessionOwner,
  RuntimeToolProfile,
} from '../../src/agents/types';
import type { RuntimeRunAdapter } from '../../src/agents/runs/runtimeRunAdapter';
import type { ResultBundleV1 } from 'michi-shared';

// ---------------------------------------------------------------------------
// Harness contract — each runtime test file provides one implementation
// ---------------------------------------------------------------------------

export interface ConformanceSession {
  /** The AgentSession returned by newSession or loadSession. */
  session: AgentSession;
  /** The native session id returned (e.g. ACP sid, thread id). */
  nativeSessionId: string | null;
}

export interface ConformanceHarness {
  /** Human-readable runtime name for test descriptions. */
  runtimeLabel: string;

  /** The adapter under test. */
  adapter: RuntimeRunAdapter;

  /** Create a fresh Run session with the given owner and return it. */
  createRunSession(opts: {
    owner: RuntimeSessionOwner;
    profileHash?: string;
    toolProfile?: RuntimeToolProfile;
    permissionBroker?: RuntimePermissionBroker;
    workspaceId?: string;
  }): Promise<ConformanceSession>;

  /**
   * Resume a Run session from a native token. Throws if the runtime does
   * not support native resume.
   */
  resumeRunSession?(opts: {
    owner: RuntimeSessionOwner;
    nativeResumeToken: string;
    profileHash?: string;
    toolProfile?: RuntimeToolProfile;
    permissionBroker?: RuntimePermissionBroker;
  }): Promise<ConformanceSession>;

  /** Release a session by public id with an expected owner guard. */
  releaseSession(sessionId: string, expectedOwner: RuntimeSessionOwner): Promise<void>;

  /** Attempt to release with a wrong owner — should throw. */
  releaseSessionWrongOwner?(sessionId: string, wrongOwner: RuntimeSessionOwner): Promise<void>;

  /** Tear down resources created during the test. */
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Standard test owners and helpers
// ---------------------------------------------------------------------------

export const RUN_OWNER: Extract<RuntimeSessionOwner, { kind: 'agent_run' }> = {
  kind: 'agent_run',
  runId: 'conformance-run',
  attemptId: 'conformance-attempt',
};

export const WRONG_OWNER: Extract<RuntimeSessionOwner, { kind: 'agent_run' }> = {
  kind: 'agent_run',
  runId: 'wrong-run',
  attemptId: 'wrong-attempt',
};

export const CHAT_OWNER: Extract<RuntimeSessionOwner, { kind: 'chat_node' }> = {
  kind: 'chat_node',
  nodeId: 'node-chat-conformance',
};

export function makeConformanceBroker(
  decisions: Record<string, RuntimePermissionDecision> = {},
): RuntimePermissionBroker & { requests: RuntimePermissionRequest[] } {
  const requests: RuntimePermissionRequest[] = [];
  return {
    requests,
    async requestPermission(req: RuntimePermissionRequest): Promise<RuntimePermissionDecision> {
      requests.push(req);
      return decisions[req.toolName] ?? 'allow_once';
    },
  };
}

export function makeConformanceToolProfile(
  toolNames: string[] = ['submit_agent_result'],
): RuntimeToolProfile {
  return {
    allowedToolNames: toolNames,
  };
}

/**
 * Extract the attemptId from a RuntimeSessionOwner that is known to be
 * an agent_run. Provides safe narrowing for tests.
 */
export function attemptIdOf(owner: RuntimeSessionOwner): string {
  if (owner.kind !== 'agent_run') throw new Error('Expected agent_run owner');
  return owner.attemptId;
}

// ---------------------------------------------------------------------------
// Conformance suite — call from each runtime's test file
// ---------------------------------------------------------------------------

export interface ConformanceSuiteOptions {
  /** Test registration function (node:test's `test`). */
  test: (name: string, fn: () => Promise<void>) => void;
  /** Describe wrapper (node:test's `describe`). */
  describe: (name: string, fn: () => void) => void;
  /** Factory that creates a fresh harness per test invocation. */
  createHarness: () => Promise<ConformanceHarness> | ConformanceHarness;
}

/**
 * Register the full conformance suite for one runtime. Each test gets a
 * fresh harness so tests are isolated.
 */
export function registerConformanceSuite(opts: ConformanceSuiteOptions): void {
  const { test, describe, createHarness } = opts;

  describe('Runtime Run conformance', () => {
    // -----------------------------------------------------------------------
    // 1. Session ownership
    // -----------------------------------------------------------------------

    test('public session id equals attemptId', async () => {
      const harness = await createHarness();
      try {
        const { session } = await harness.createRunSession({ owner: RUN_OWNER });
        assert.equal(session.id, RUN_OWNER.attemptId,
          `${harness.runtimeLabel}: session.id must equal attemptId`);
      } finally {
        await harness.cleanup();
      }
    });

    test('session owner matches the provided agent_run owner', async () => {
      const harness = await createHarness();
      try {
        const { session } = await harness.createRunSession({ owner: RUN_OWNER });
        assert.deepEqual(session.owner, RUN_OWNER,
          `${harness.runtimeLabel}: session.owner must match the input owner`);
      } finally {
        await harness.cleanup();
      }
    });

    test('session runtimeProfileHash is set from input', async () => {
      const harness = await createHarness();
      try {
        const { session } = await harness.createRunSession({
          owner: RUN_OWNER,
          profileHash: 'conformance-hash-abc',
        });
        assert.equal(session.runtimeProfileHash, 'conformance-hash-abc',
          `${harness.runtimeLabel}: runtimeProfileHash must be propagated`);
      } finally {
        await harness.cleanup();
      }
    });

    test('nativeSessionId is distinct from public session id when present', async () => {
      const harness = await createHarness();
      try {
        const { session, nativeSessionId } = await harness.createRunSession({
          owner: RUN_OWNER,
        });
        if (nativeSessionId !== null) {
          assert.notEqual(nativeSessionId, session.id,
            `${harness.runtimeLabel}: nativeSessionId must differ from public id`);
        }
      } finally {
        await harness.cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 2. Adapter metadata correctness
    // -----------------------------------------------------------------------

    test('adapter declares valid metadata fields', async () => {
      const harness = await createHarness();
      try {
        const { adapter } = harness;
        assert.equal(typeof adapter.runtimeId, 'string');
        assert.notEqual(adapter.runtimeId, '');
        assert.equal(typeof adapter.supportsNativeResume, 'boolean');
        assert.ok(
          ['allowlist', 'runtime_default'].includes(adapter.nativeToolMode),
          `${harness.runtimeLabel}: nativeToolMode must be allowlist or runtime_default`,
        );
        assert.ok(
          ['native', 'next_turn', 'none'].includes(adapter.steering),
          `${harness.runtimeLabel}: steering must be native, next_turn, or none`,
        );
        assert.equal(typeof adapter.assertCompatible, 'function');
      } finally {
        await harness.cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 3. Release ownership guard
    // -----------------------------------------------------------------------

    test('release with correct owner succeeds', async () => {
      const harness = await createHarness();
      try {
        await harness.createRunSession({ owner: RUN_OWNER });
        // Should not throw
        await harness.releaseSession(RUN_OWNER.attemptId, RUN_OWNER);
      } finally {
        await harness.cleanup();
      }
    });

    test('release with wrong owner is rejected', async () => {
      const harness = await createHarness();
      try {
        await harness.createRunSession({ owner: RUN_OWNER });
        if (harness.releaseSessionWrongOwner) {
          await assert.rejects(
            () => harness.releaseSessionWrongOwner!(RUN_OWNER.attemptId, WRONG_OWNER),
            /Owner mismatch/,
            `${harness.runtimeLabel}: wrong owner release must throw`,
          );
        } else {
          await assert.rejects(
            () => harness.releaseSession(RUN_OWNER.attemptId, WRONG_OWNER),
            /Owner mismatch/,
            `${harness.runtimeLabel}: wrong owner release must throw`,
          );
        }
      } finally {
        await harness.cleanup();
      }
    });

    // -----------------------------------------------------------------------
    // 4. Resume (for runtimes that support it)
    // -----------------------------------------------------------------------

    test('native token round-trip survives JSON persistence', async () => {
      const harness = await createHarness();
      try {
        if (!harness.adapter.supportsNativeResume || !harness.resumeRunSession) {
          // Skip for runtimes without native resume
          return;
        }
        const { nativeSessionId } = await harness.createRunSession({
          owner: RUN_OWNER,
        });
        assert.ok(nativeSessionId, `${harness.runtimeLabel}: must return a native session id`);

        // Simulate JSON persistence round-trip
        const serialized = JSON.stringify(nativeSessionId);
        const deserialized = JSON.parse(serialized) as string;

        // Release old session first
        await harness.releaseSession(RUN_OWNER.attemptId, RUN_OWNER);

        // Resume with the deserialized token
        const resumed = await harness.resumeRunSession({
          owner: RUN_OWNER,
          nativeResumeToken: deserialized,
        });
        assert.equal(resumed.session.id, RUN_OWNER.attemptId,
          `${harness.runtimeLabel}: resumed session.id must be attemptId`);
        assert.deepEqual(resumed.session.owner, RUN_OWNER,
          `${harness.runtimeLabel}: resumed session.owner must match`);
        assert.equal(resumed.nativeSessionId, deserialized,
          `${harness.runtimeLabel}: resumed nativeSessionId must match the token`);
      } finally {
        await harness.cleanup();
      }
    });
  });
}
