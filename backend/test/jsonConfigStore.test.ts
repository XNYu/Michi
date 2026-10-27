import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { JsonConfigError, readJsonConfig, updateJsonConfig, writeJsonConfig } from '../src/services/jsonConfigStore';

let root: string;
let file: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-json-store-')); file = path.join(root, 'config.json'); });
afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });

test('missing initializes, namespace updates preserve other fields, complete writes are private', () => {
  assert.equal(readJsonConfig(file), null);
  updateJsonConfig(file, () => ({ agent: { runtime: 'pi' }, providerApiKeys: { provider: 'test-key' } }));
  updateJsonConfig(file, (config) => ({ ...config, prefs: { uiFont: 'Inter' } }));
  assert.deepEqual(readJsonConfig(file), { agent: { runtime: 'pi' }, providerApiKeys: { provider: 'test-key' }, prefs: { uiFont: 'Inter' } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
});

test('corrupt and non-object JSON cannot be silently overwritten', () => {
  for (const raw of ['{"agent":', '[]', 'null', '42']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => readJsonConfig(file), (error: any) => error instanceof JsonConfigError && error.code === 'CONFIG_CORRUPT');
    assert.throws(() => updateJsonConfig(file, () => ({ prefs: {} })), JsonConfigError);
    assert.throws(() => writeJsonConfig(file, {}), JsonConfigError);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  }
});

test('read permissions errors are distinct from a missing file', () => {
  const read = fs.readFileSync;
  mock.method(fs, 'readFileSync', ((input: any, ...args: any[]) => {
    if (input === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return (read as any)(input, ...args);
  }) as typeof fs.readFileSync);
  assert.throws(() => readJsonConfig(file), (error: any) => error instanceof JsonConfigError && error.operation === 'read');
  assert.throws(() => updateJsonConfig(file, () => ({})), JsonConfigError);
});

test('temporary write and rename failures preserve the original and release temporary resources', () => {
  for (const fail of ['write', 'rename']) {
    fs.writeFileSync(file, '{"kept":"original"}');
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    const stub = fail === 'write'
      ? mock.method(fs, 'writeFileSync', ((target: any, ...args: any[]) => {
        if (typeof target === 'string' && target.endsWith('.tmp')) throw new Error('disk full');
        return (write as any)(target, ...args);
      }) as typeof write)
      : mock.method(fs, 'renameSync', ((source: any, target: any) => {
        if (target === file) throw new Error('rename denied');
        return rename(source, target);
      }) as typeof rename);
    assert.throws(() => updateJsonConfig(file, (config) => ({ ...config, prefs: {} })), JsonConfigError);
    stub.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), '{"kept":"original"}');
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  }
});

test('unknown or abandoned locks time out without stealing ownership or changing data', () => {
  fs.writeFileSync(file, '{"kept":true}');
  fs.writeFileSync(`${file}.lock`, '{"pid":1,"token":"unknown"}');
  const started = Date.now();
  assert.throws(() => updateJsonConfig(file, () => ({})), (error: any) => error instanceof JsonConfigError && error.code === 'CONFIG_LOCKED' && error.message.includes(`${file}.lock`));
  assert.ok(Date.now() - started < 1000, 'synchronous lock wait must stay bounded');
  assert.deepEqual(readJsonConfig(file), { kept: true });
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), '{"pid":1,"token":"unknown"}');
});

test('two child processes competing for different namespaces preserve both writes', async () => {
  fs.writeFileSync(file, '{"kept":true}');
  const script = `
    const { updateJsonConfig } = require('./src/services/jsonConfigStore');
    process.send('ready');
    process.once('message', () => {
      updateJsonConfig(process.env.TEST_CONFIG_PATH, (config) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
        return { ...config, [process.env.TEST_NAMESPACE]: { saved: true } };
      });
      process.disconnect();
    });
  `;
  const children = ['prefs', 'providerApiKeys'].map((namespace) => spawn(process.execPath, ['--require', 'ts-node/register', '-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, TEST_CONFIG_PATH: file, TEST_NAMESPACE: namespace, TS_NODE_TRANSPILE_ONLY: 'true' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  }));
  try {
    await Promise.all(children.map((child) => once(child, 'message')));
    const done = children.map(async (child) => {
      let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += chunk; });
      const result = once(child, 'exit'); child.send('go');
      assert.equal((await result)[0], 0, stderr);
    });
    await Promise.all(done);
    assert.deepEqual(readJsonConfig(file), { kept: true, prefs: { saved: true }, providerApiKeys: { saved: true } });
    assert.deepEqual(fs.readdirSync(root), ['config.json']);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
});

test('actual config services preserve profile, shared credentials and data-directory contracts', () => {
  const selectedProfile = path.join(root, 'profile');
  const dataDir = path.join(root, 'data');
  const script = `
    const { updateAgentConfig } = require('./src/services/agentConfig');
    const { writePrefs } = require('./src/services/prefsConfig');
    const { setProviderApiKey } = require('./src/services/secrets');
    const { saveBedrockConfig } = require('./src/services/bedrockCredentials');
    const { saveBackendConnection } = require('./src/services/backendConnections');
    updateAgentConfig({ runtime: 'pi' });
    writePrefs({ uiFont: 'Inter', transient: true });
    setProviderApiKey('fixture', 'fixture-key');
    saveBedrockConfig({ region: 'us-east-1', credentialSource: 'auto' });
    saveBackendConnection({ name: 'Fixture', apiUrl: 'https://fixture.example' });
  `;
  const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: root, MICHI_CONFIG_DIR: selectedProfile, MICHI_DATA_DIR: dataDir, TS_NODE_TRANSPILE_ONLY: 'true' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJsonConfig(path.join(selectedProfile, 'config.json'))?.prefs, { uiFont: 'Inter' });
  assert.equal(readJsonConfig(path.join(selectedProfile, 'config.json'))?.agent.runtime, 'pi');
  assert.deepEqual(readJsonConfig(path.join(root, '.michi/config.json')), { providerApiKeys: { fixture: 'fixture-key' }, bedrock: { region: 'us-east-1', credentialSource: 'auto' } });
  assert.equal(readJsonConfig(path.join(dataDir, 'config.json'))?.backendConnections[0].name, 'Fixture');
});

test('corrupt JSON errors never include secret-bearing parser snippets', () => {
  fs.writeFileSync(file, '{"providerApiKeys":{"fixture":"do-not-print-this"} trailing');
  try { readJsonConfig(file); assert.fail('expected corrupt config rejection'); }
  catch (error) {
    assert.equal((error as JsonConfigError).code, 'CONFIG_CORRUPT');
    assert.ok(!String(error).includes('do-not-print-this'));
    assert.ok(!String((error as Error).cause).includes('do-not-print-this'));
  }
});
