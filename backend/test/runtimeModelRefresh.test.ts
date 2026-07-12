import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshRuntimeModelsInBackground } from '../src/agents/runtimeModelRefresh';
import type { AgentRuntime } from '../src/agents/types';

function runtime(id: string, refreshModels?: () => Promise<any[]>): AgentRuntime {
  return {
    id,
    label: id,
    capabilities: {
      modes: false,
      permissions: false,
      models: !!refreshModels,
      providerModels: false,
      reasoning: false,
      supportedReasoningLevels: [],
      apiKeys: false,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
      nativeResume: false,
    },
    warm: async () => {},
    newSession: async () => { throw new Error('unused'); },
    releaseSession: async () => {},
    refreshModels,
    shutdown: async () => {},
  };
}

test('refreshRuntimeModelsInBackground starts dynamic refreshes without awaiting them', async () => {
  let started = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });

  refreshRuntimeModelsInBackground([
    runtime('codex', async () => {
      started = true;
      await pending;
      return [];
    }),
    runtime('claude'),
  ]);

  assert.equal(started, true);
  release();
  await pending;
});
test('refreshRuntimeModelsInBackground reports refresh failures', async () => {
  const errors: string[] = [];
  refreshRuntimeModelsInBackground(
    [runtime('kiro', async () => { throw new Error('offline'); })],
    (runtimeId, error) => errors.push(`${runtimeId}:${error.message}`),
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['kiro:offline']);
});
