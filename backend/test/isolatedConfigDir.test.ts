import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards the helper that keeps route tests from rewriting the developer's
// real ~/.michi/config.json (agent runtime/model/effort and prefs).
test('isolatedConfigDir redirects agent and prefs writes away from HOME and cleans up', () => {
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-config-isolation-home-'));
  try {
    const script = `
      require('./test/isolatedConfigDir');
      const { updateAgentConfig } = require('./src/services/agentConfig');
      const { writePrefs } = require('./src/services/prefsConfig');
      updateAgentConfig({ runtime: 'leak-probe', modelByRuntime: { 'leak-probe': 'probe-model' } });
      writePrefs({ uiFont: 'Inter' });
      const configPath = require('path').join(process.env.MICHI_CONFIG_DIR, 'config.json');
      process.stdout.write(JSON.stringify({ dir: process.env.MICHI_CONFIG_DIR, written: JSON.parse(require('fs').readFileSync(configPath, 'utf8')) }));
    `;
    const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
      cwd: path.join(__dirname, '..'),
      // The helper must win even when the caller's environment points at a real config.
      env: { ...process.env, HOME: sandboxHome, MICHI_CONFIG_DIR: path.join(sandboxHome, '.michi') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { dir, written } = JSON.parse(result.stdout) as { dir: string; written: Record<string, any> };

    assert.equal(written.agent.runtime, 'leak-probe');
    assert.equal(written.prefs.uiFont, 'Inter');
    assert.ok(!dir.startsWith(sandboxHome), `config dir ${dir} must not live under HOME`);
    assert.equal(fs.existsSync(path.join(sandboxHome, '.michi', 'config.json')), false);
    assert.equal(fs.existsSync(dir), false, 'temporary config dir is removed on exit');
  } finally {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  }
});
