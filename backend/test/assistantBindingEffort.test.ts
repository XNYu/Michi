import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import './isolatedConfigDir';
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { closeDb, initDb } from '../src/services/db';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { ensureAssistant } from '../src/assistant/store';
import { resolveAssistantBindingForSession } from '../src/assistant/binding';

function runtime(id: string, models: Array<{ id: string; isDefault?: boolean; supportsReasoning?: boolean; supportedReasoningLevels?: Array<'low' | 'high'> }>): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false,
      reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false,
      warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
    async listModels() { return models; },
  } as AgentRuntime;
}

registerRuntime(runtime('kiro-auto', [{ id: 'auto', isDefault: true, supportsReasoning: false }, { id: 'sonnet', supportedReasoningLevels: ['low', 'high'] }]));

let tmpDir: string;

describe('assistant binding for a new session', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-assistant-effort-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb(); initDb();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('drops a reasoning level the resolved model cannot use', async () => {
    updateMetaAgentSettings({ runtimeId: 'kiro-auto', modelId: null, reasoning: 'high' });
    const { nodeId } = ensureAssistant();
    const binding = await resolveAssistantBindingForSession(nodeId);
    assert.equal(binding?.effectiveDefinition.runtimeProfile.reasoning, null);
  });

  test('keeps a reasoning level the model supports', async () => {
    updateMetaAgentSettings({ runtimeId: 'kiro-auto', modelId: 'sonnet', reasoning: 'high' });
    const { nodeId } = ensureAssistant();
    const binding = await resolveAssistantBindingForSession(nodeId);
    assert.equal(binding?.effectiveDefinition.runtimeProfile.reasoning, 'high');
  });

  test('is null for a node outside the assistant workspace', async () => {
    assert.equal(await resolveAssistantBindingForSession('n-missing'), null);
  });
});
