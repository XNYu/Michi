import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initDb } from '../src/services/db';

import { getUserAgentConfig, upsertUserAgentConfig } from '../src/services/dbRepository';
import { getAgentConfig, recordLastUsedProviderModel, resolveModel, resolveProvider, updateAgentConfig } from '../src/services/agentConfig';

let directory: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-cloud-provider-config-'));
  process.env.MICHI_DATA_DIR = directory;
  process.env.MICHI_CLOUD = '1';
  closeDb();
  initDb();
});

afterEach(() => {
  closeDb();
  process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

test('cloud provider and model memory survives reopening the DB and stays user scoped', () => {
  updateAgentConfig({ runtime: 'claude', provider: 'openrouter-free' }, 'alice');
  updateAgentConfig({ runtime: 'pi', provider: 'openrouter-free' }, 'bob');
  recordLastUsedProviderModel('pi', 'deepseek', 'deepseek-v4-flash', 'alice');
  updateAgentConfig({ reasoningByRuntime: { pi: 'high' } }, 'alice');
  closeDb();
  initDb();
  assert.equal(getAgentConfig('alice').runtime, 'claude');
  assert.deepEqual(getAgentConfig('alice').providerByRuntime, { pi: 'deepseek' });
  assert.equal(resolveProvider('pi', 'alice'), 'deepseek');
  assert.equal(resolveModel('pi', 'alice'), 'deepseek-v4-flash');
  assert.equal(resolveProvider('pi', 'bob'), 'openrouter-free');
  assert.deepEqual(getAgentConfig('bob').providerByRuntime, {});
});

test('cloud config merges runtime memories and repository updates preserve an omitted provider map', () => {
  updateAgentConfig({ runtime: 'pi', providerByRuntime: { pi: 'deepseek' }, modelByRuntime: { pi: 'deepseek-v4-flash' } }, 'alice');
  updateAgentConfig({ providerByRuntime: { another: 'openai' } }, 'alice');
  const row = getUserAgentConfig('alice')!;
  upsertUserAgentConfig('alice', { runtime: row.runtime, provider: row.provider,
    model_by_runtime: row.model_by_runtime, reasoning_by_runtime: row.reasoning_by_runtime });
  assert.deepEqual(getAgentConfig('alice').providerByRuntime, { pi: 'deepseek', another: 'openai' });
});

test('changing the remembered provider without a model does not retain the old provider model', () => {
  recordLastUsedProviderModel('pi', 'deepseek', 'deepseek-v4-flash', 'alice');
  recordLastUsedProviderModel('pi', 'openai', null, 'alice');
  assert.equal(getAgentConfig('alice').modelByRuntime.pi, '');
  assert.notEqual(resolveModel('pi', 'alice'), 'deepseek-v4-flash');
});
