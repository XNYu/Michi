import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('integration isolation redirects captured config/credential paths and blocks writes to caller profiles', () => {
  const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-integration-isolation-caller-'));
  try {
    const home = path.join(caller, 'home');
    const configDir = path.join(caller, 'config');
    const dataDir = path.join(caller, 'data');
    const sentinelPaths = [path.join(home, '.michi', 'config.json'), path.join(configDir, 'config.json'), path.join(dataDir, 'config.json')];
    const sentinel = JSON.stringify({ providerApiKeys: { fixture: 'disposable-sentinel' }, preserved: true });
    for (const file of sentinelPaths) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, sentinel);
    }
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const callerHome = require('node:os').homedir();
      const callerConfig = process.env.MICHI_CONFIG_DIR;
      const { isolatedIntegrationRoot, isolatedIntegrationHome, isolatedIntegrationConfigDir, isolatedIntegrationDataDir, resetIntegrationConfig } = require('./test/isolatedIntegrationEnvironment');
      resetIntegrationConfig();
      const { getMichiConfigPaths, getMichiCredentialConfigPaths, getMichiConnectionConfigPath } = require('./src/services/configPaths');
      assert.equal(require('node:os').homedir(), isolatedIntegrationHome);
      assert.equal(getMichiConfigPaths().configDir, isolatedIntegrationConfigDir);
      assert.equal(getMichiCredentialConfigPaths().configDir, path.join(isolatedIntegrationHome, '.michi'));
      assert.equal(getMichiConnectionConfigPath(), path.join(isolatedIntegrationDataDir, 'config.json'));
      const { updateAgentConfig } = require('./src/services/agentConfig');
      const { writePrefs } = require('./src/services/prefsConfig');
      const { setProviderApiKey } = require('./src/services/secrets');
      updateAgentConfig({ runtime: 'isolation-probe' });
      writePrefs({ uiFont: 'Inter' });
      setProviderApiKey('fixture', 'disposable-fixture');
      const profile = JSON.parse(fs.readFileSync(getMichiConfigPaths().configPath, 'utf8'));
      const credentials = JSON.parse(fs.readFileSync(getMichiCredentialConfigPaths().configPath, 'utf8'));
      assert.equal(profile.agent.runtime, 'isolation-probe');
      assert.equal(profile.prefs.uiFont, 'Inter');
      assert.equal(credentials.providerApiKeys.fixture, 'disposable-fixture');
      const oldHomeConfig = path.join(callerHome, '.michi', 'config.json');
      const rejected = /mutation outside isolated environment/;
      assert.throws(() => fs.writeFileSync(oldHomeConfig, '{}'), rejected);
      assert.throws(() => fs.writeFileSync(path.join(callerHome, '.michi', '.config.json.fixture.tmp'), '{}'), rejected);
      assert.throws(() => fs.openSync(path.join(callerConfig, 'config.json.lock'), 'wx'), rejected);
      const temp = path.join(isolatedIntegrationRoot, 'rename-probe.tmp');
      fs.writeFileSync(temp, '{}');
      assert.throws(() => fs.renameSync(temp, oldHomeConfig), rejected);
      process.stdout.write(JSON.stringify({ root: isolatedIntegrationRoot }));
    `;
    const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: home, USERPROFILE: home, MICHI_CONFIG_DIR: configDir, MICHI_DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout) as { root: string };
    for (const file of sentinelPaths) assert.equal(fs.readFileSync(file, 'utf8'), sentinel);
    assert.equal(fs.existsSync(output.root), false, 'the disposable environment is removed on exit');
  } finally {
    fs.rmSync(caller, { recursive: true, force: true });
  }
});
