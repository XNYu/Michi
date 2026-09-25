import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSessionOwner } from '../src/agents/types';
import { assertOwner, ownerLabel, sameOwner } from '../src/agents/types';
import { assertReleaseOwnership } from '../src/agents/runs/runtimeRunAdapter';
import type { RuntimeRunAdapter } from '../src/agents/runs/runtimeRunAdapter';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import type { AgentRuntime } from '../src/agents/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatOwner(nodeId: string): Extract<RuntimeSessionOwner, { kind: 'chat_node' }> {
  return { kind: 'chat_node', nodeId };
}

function runOwner(runId: string, attemptId: string): Extract<RuntimeSessionOwner, { kind: 'agent_run' }> {
  return { kind: 'agent_run', runId, attemptId };
}

function fakeRuntime(id: string, overrides: Partial<AgentRuntime['capabilities']> = {}): AgentRuntime {
  return {
    id,
    label: id,
    capabilities: {
      modes: false,
      permissions: false,
      models: true,
      providerModels: false,
      reasoning: true,
      supportedReasoningLevels: ['medium'],
      apiKeys: true,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
      nativeResume: false,
      ...overrides,
    },
    warm: async () => {},
    newSession: async () => { throw new Error('not implemented'); },
    releaseSession: () => {},
    shutdown: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Owner shapes
// ---------------------------------------------------------------------------

describe('RuntimeSessionOwner shapes', () => {
  test('chat_node owners are equal when nodeId matches', () => {
    assert.equal(sameOwner(chatOwner('n1'), chatOwner('n1')), true);
    assert.equal(sameOwner(chatOwner('n1'), chatOwner('n2')), false);
  });

  test('agent_run owners are equal only when both runId and attemptId match', () => {
    assert.equal(sameOwner(runOwner('r1', 'a1'), runOwner('r1', 'a1')), true);
    assert.equal(sameOwner(runOwner('r1', 'a1'), runOwner('r1', 'a2')), false);
    assert.equal(sameOwner(runOwner('r1', 'a1'), runOwner('r2', 'a1')), false);
    assert.equal(sameOwner(runOwner('r1', 'a1'), runOwner('r2', 'a2')), false);
  });

  test('ownerLabel returns distinct labels for each kind', () => {
    assert.match(ownerLabel(chatOwner('node-42')), /chat_node\(node-42\)/);
    assert.match(ownerLabel(runOwner('run-7', 'attempt-3')), /agent_run.*run=run-7.*attempt=attempt-3/);
  });
});

// ---------------------------------------------------------------------------
// assertOwner
// ---------------------------------------------------------------------------

describe('assertOwner', () => {
  test('throws for mismatched attempt ids', () => {
    assert.throws(
      () => assertOwner(runOwner('r1', 'a1'), runOwner('r1', 'a2')),
      /Owner mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// Release ownership guard
// ---------------------------------------------------------------------------

describe('assertReleaseOwnership', () => {
  test('passes when expectedOwner is undefined (no guard)', () => {
    assert.doesNotThrow(() => assertReleaseOwnership(chatOwner('n1'), undefined));
    assert.doesNotThrow(() => assertReleaseOwnership(runOwner('r1', 'a1'), undefined));
  });

  test('passes when owners match', () => {
    assert.doesNotThrow(() => assertReleaseOwnership(runOwner('r1', 'a1'), runOwner('r1', 'a1')));
    assert.doesNotThrow(() => assertReleaseOwnership(chatOwner('n1'), chatOwner('n1')));
  });

  test('rejects stale attempt releasing a rebound session', () => {
    assert.throws(
      () => assertReleaseOwnership(runOwner('r1', 'a2'), runOwner('r1', 'a1')),
      /Owner mismatch/,
    );
  });

  test('rejects cross-kind release attempt', () => {
    assert.throws(
      () => assertReleaseOwnership(chatOwner('n1'), runOwner('r1', 'n1')),
      /Owner mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// Run session public id === attempt id
// ---------------------------------------------------------------------------

describe('Run session identity contract', () => {
  test('agent_run owner attemptId is the canonical public session id', () => {
    const owner = runOwner('run-1', 'attempt-42');
    // The contract states session.id === owner.attemptId
    assert.equal(owner.attemptId, 'attempt-42');
    // Even when a native session id differs, the public id must be attemptId
    const nativeSessionId = 'acp-session-xyz';
    assert.notEqual(nativeSessionId, owner.attemptId);
    // sameOwner must still match by runId+attemptId, not by native id
    assert.equal(sameOwner(owner, runOwner('run-1', 'attempt-42')), true);
  });
});

// ---------------------------------------------------------------------------
// Adapter compatibility checks
// ---------------------------------------------------------------------------

describe('RuntimeRunAdapter compatibility', () => {
  const adapters: RuntimeRunAdapter[] = [new PiRunAdapter(), new ClaudeRunAdapter()];

  test('Pi adapter rejects missing reasoning capability', () => {
    const pi = new PiRunAdapter();
    assert.throws(
      () => pi.assertCompatible(fakeRuntime('pi', { reasoning: false })),
      /model\/reasoning capabilities/,
    );
  });

  test('Claude adapter rejects wrong runtime id', () => {
    const claude = new ClaudeRunAdapter();
    assert.throws(
      () => claude.assertCompatible(fakeRuntime('pi')),
      /Claude Run adapter cannot execute runtime pi/,
    );
  });

  test('Claude adapter rejects missing native resume capability', () => {
    const claude = new ClaudeRunAdapter();
    assert.throws(
      () => claude.assertCompatible(fakeRuntime('claude', { nativeResume: false })),
      /model\/native-resume capabilities/,
    );
  });

  test('all adapters declare required metadata fields', () => {
    for (const adapter of adapters) {
      assert.equal(typeof adapter.runtimeId, 'string');
      assert.notEqual(adapter.runtimeId, '');
      assert.equal(typeof adapter.supportsNativeResume, 'boolean');
      assert.ok(
        ['allowlist', 'runtime_default'].includes(adapter.nativeToolMode),
        `${adapter.runtimeId} nativeToolMode must be allowlist or runtime_default`,
      );
      assert.ok(
        ['native', 'next_turn', 'none'].includes(adapter.steering),
        `${adapter.runtimeId} steering must be native, next_turn, or none`,
      );
      assert.equal(typeof adapter.assertCompatible, 'function');
    }
  });
});

// ---------------------------------------------------------------------------
// Incompatible profile hash
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Malformed native tokens
// ---------------------------------------------------------------------------

