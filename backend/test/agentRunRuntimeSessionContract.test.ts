import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { RuntimeRunAdapter } from '../src/agents/runs/runtimeRunAdapter';
import { PiRunAdapter } from '../src/agents/runs/piRunAdapter';
import { ClaudeRunAdapter } from '../src/agents/runs/claudeRunAdapter';
import type { AgentRuntime } from '../src/agents/types';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime/internal/core/descriptors';

function fakeRuntime(id: string, overrides: Partial<AgentRuntime['capabilities']> = {}): AgentRuntime {
  return {
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
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
// Adapter compatibility checks
// ---------------------------------------------------------------------------

describe('RuntimeRunAdapter compatibility', () => {
  const adapters: RuntimeRunAdapter[] = [new PiRunAdapter(), new ClaudeRunAdapter()];

  test('Pi adapter rejects missing model capability', () => {
    const pi = new PiRunAdapter();
    assert.throws(
      () => pi.assertCompatible(fakeRuntime('pi', { models: false })),
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
});
