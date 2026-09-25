import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb, initDb } from '../src/services/db';
import { runMigrations } from '../src/services/migrate';
import { getUserAgentConfig, upsertUserAgentConfig } from '../src/services/dbRepository';
import { getAgentConfig, isNativeResumeEnabled, recordLastUsedProviderModel, resolveModel, resolveProvider, updateAgentConfig } from '../src/services/agentConfig';

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

test('native resume defaults on and persists independently per runtime and per user', () => {
  assert.equal(isNativeResumeEnabled('codex', 'alice'), true);
  updateAgentConfig({ nativeResumeByRuntime: { codex: false } }, 'alice');
  updateAgentConfig({ nativeResumeByRuntime: { claude: false } }, 'alice');
  updateAgentConfig({ nativeResumeByRuntime: { codex: true } }, 'alice');
  closeDb(); initDb();
  assert.deepEqual(getAgentConfig('alice').nativeResumeByRuntime, { codex: true, claude: false });
  assert.equal(isNativeResumeEnabled('claude', 'alice'), false);
  assert.equal(isNativeResumeEnabled('claude', 'bob'), true);
  updateAgentConfig({ modelByRuntime: { claude: 'sonnet' } }, 'alice');
  assert.equal(isNativeResumeEnabled('claude', 'alice'), false);
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

test('provider memory migration is additive and preserves legacy configuration on repeated boots', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/0002_user_agent_configs.sql'), 'utf8'));
    raw.prepare('INSERT INTO user_agent_configs VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', 'pi', 'deepseek', '{"pi":"deepseek-v4-flash"}', '{"pi":"high"}', 123);
    const migrations = path.join(directory, 'migration-fixture');
    fs.mkdirSync(migrations);
    const file = '0023_user_provider_memory.sql';
    fs.copyFileSync(path.join(__dirname, '../src/db/migrations', file), path.join(migrations, file));
    runMigrations(raw, migrations);
    runMigrations(raw, migrations);
    const row = raw.prepare('SELECT * FROM user_agent_configs').get()!;
    assert.equal(row.provider_by_runtime, '{}');
    assert.equal(row.provider, 'deepseek');
    assert.equal(row.model_by_runtime, '{"pi":"deepseek-v4-flash"}');
    assert.equal(row.updated_at, 123);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n, 1);
    assert.ok(getDb().prepare('PRAGMA table_info(user_agent_configs)').all().some((column) => column.name === 'provider_by_runtime'));
  } finally {
    raw.close();
  }
});
