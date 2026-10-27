import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards the helper that keeps route tests from rewriting the developer's
// real ~/.michi/config.json (agent runtime/model/effort, prefs and Pi MCP).
test('isolatedConfigDir redirects agent and prefs writes away from HOME and cleans up', () => {
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-config-isolation-home-'));
  try {
    const homeConfigPath = path.join(sandboxHome, '.michi', 'config.json');
    const homeConfig = { piMcpServers: [{ serverName: 'production', command: 'production-mcp' }], piAimServers: ['production'] };
    fs.mkdirSync(path.dirname(homeConfigPath));
    fs.writeFileSync(homeConfigPath, JSON.stringify(homeConfig));
    const script = `
      require('./test/isolatedConfigDir');
      const configPath = require('path').join(process.env.MICHI_CONFIG_DIR, 'config.json');
      require('fs').writeFileSync(configPath, JSON.stringify({ piMcpServers: [{ serverName: 'isolated', command: 'isolated-mcp' }] }));
      delete process.env.MICHI_PI_MCP_SERVERS;
      process.env.MICHI_PI_AIM_DISCOVERY = '0';
      const { updateAgentConfig } = require('./src/services/agentConfig');
      const { writePrefs } = require('./src/services/prefsConfig');
      const { readPiMcpServers } = require('./src/services/piMcpConfig');
      updateAgentConfig({ runtime: 'leak-probe', modelByRuntime: { 'leak-probe': 'probe-model' } });
      writePrefs({ uiFont: 'Inter' });
      process.stdout.write(JSON.stringify({ dir: process.env.MICHI_CONFIG_DIR, servers: readPiMcpServers(), written: JSON.parse(require('fs').readFileSync(configPath, 'utf8')) }));
    `;
    const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
      cwd: path.join(__dirname, '..'),
      // The helper must win even when the caller's environment points at a real config.
      env: { ...process.env, HOME: sandboxHome, MICHI_CONFIG_DIR: path.join(sandboxHome, '.michi') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { dir, written, servers } = JSON.parse(result.stdout) as { dir: string; written: Record<string, any>; servers: Array<{ serverName: string }> };

    assert.equal(written.agent.runtime, 'leak-probe');
    assert.equal(written.prefs.uiFont, 'Inter');
    assert.deepEqual(servers.map(server => server.serverName), ['isolated']);
    assert.equal(written.piMcpServers[0].serverName, 'isolated', 'agent and prefs writes preserve the MCP config');
    assert.ok(!dir.startsWith(sandboxHome), `config dir ${dir} must not live under HOME`);
    assert.deepEqual(JSON.parse(fs.readFileSync(homeConfigPath, 'utf8')), homeConfig, 'the home profile is untouched');
    assert.equal(fs.existsSync(dir), false, 'temporary config dir is removed on exit');
  } finally {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  }
});

test('agent, prefs and Pi MCP share the home profile when MICHI_CONFIG_DIR is unset', () => {
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-config-default-home-'));
  try {
    const homeConfigPath = path.join(sandboxHome, '.michi', 'config.json');
    fs.mkdirSync(path.dirname(homeConfigPath));
    fs.writeFileSync(homeConfigPath, JSON.stringify({ piMcpServers: ['default-mcp'] }));
    const script = `
      delete process.env.MICHI_CONFIG_DIR;
      delete process.env.MICHI_PI_MCP_SERVERS;
      process.env.MICHI_PI_AIM_DISCOVERY = '0';
      const { updateAgentConfig } = require('./src/services/agentConfig');
      const { writePrefs, readPrefs } = require('./src/services/prefsConfig');
      const { readPiMcpServers } = require('./src/services/piMcpConfig');
      updateAgentConfig({ runtime: 'default-probe' });
      writePrefs({ uiFont: 'Inter' });
      process.stdout.write(JSON.stringify({ prefs: readPrefs(), servers: readPiMcpServers() }));
    `;
    const result = spawnSync(process.execPath, ['--require', 'ts-node/register', '-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, HOME: sandboxHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.prefs.uiFont, 'Inter');
    assert.deepEqual(output.servers.map((server: { serverName: string }) => server.serverName), ['default']);
    const written = JSON.parse(fs.readFileSync(homeConfigPath, 'utf8'));
    assert.equal(written.agent.runtime, 'default-probe');
    assert.equal(written.prefs.uiFont, 'Inter');
    assert.deepEqual(written.piMcpServers, ['default-mcp']);
  } finally {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  }
});
