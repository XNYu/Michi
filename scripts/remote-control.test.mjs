import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  healthHostForBind,
  parseArgs,
  parseEnvironmentFile,
  renderEnvironmentFile,
  renderSystemdUnit,
  resolveRemoteConfig,
} from './remote-control.mjs';

test('remote launch defaults to detached loopback mode', () => {
  const options = parseArgs(['launch']);
  assert.equal(options.action, 'launch');
  assert.equal(options.service, false);
  assert.equal(options.setup, true);
  assert.equal(options.public, false);
});

test('remote launch accepts service and explicit connection options', () => {
  const options = parseArgs([
    'launch', '--service', '--no-setup', '--port=4123',
    '--bind-host', '10.0.0.8', '--data-dir', '~/michi remote',
  ]);
  assert.equal(options.service, true);
  assert.equal(options.setup, false);
  assert.equal(options.port, '4123');
  assert.equal(options.bindHost, '10.0.0.8');
  assert.equal(options.dataDir, '~/michi remote');
});

test('remote arguments reject ambiguous or invalid options', () => {
  assert.throws(() => parseArgs(['launch', '--public', '--bind-host', '127.0.0.1']), /cannot be used together/);
  assert.throws(() => parseArgs(['launch', '--unknown']), /unknown option/);
  assert.throws(() => resolveRemoteConfig(parseArgs(['launch', '--port', '0']), {}, '/tmp'), /invalid port/);
  assert.throws(() => resolveRemoteConfig(parseArgs(['launch', '--token', 'short']), {}, '/tmp'), /at least 16/);
});

test('remote config generates a strong token once and reuses the saved token', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'michi-remote-control-'));
  try {
    const options = parseArgs(['launch', '--data-dir', path.join(home, 'data')]);
    const first = resolveRemoteConfig(options, {}, home, () => 'generated-token-1234567890');
    mkdirSync(path.dirname(first.envFile), { recursive: true });
    writeFileSync(first.envFile, renderEnvironmentFile(first), { mode: 0o600 });
    const second = resolveRemoteConfig(options, {}, home, () => 'should-not-rotate-token');
    assert.equal(first.token, 'generated-token-1234567890');
    assert.equal(second.token, first.token);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('environment file round-trips spaces and keeps remote mode isolated from cloud auth', () => {
  const config = {
    token: 'token-with-special_~-123456',
    bindHost: '127.0.0.1',
    dataDir: '/tmp/Michi Remote/data',
    port: 3000,
    pathEnv: '/usr/local/bin:/usr/bin',
  };
  const parsed = parseEnvironmentFile(renderEnvironmentFile(config));
  assert.equal(parsed.MICHI_REMOTE_TOKEN, config.token);
  assert.equal(parsed.MICHI_DATA_DIR, config.dataDir);
  assert.equal(parsed.MICHI_REMOTE_ACCESS, '1');
  assert.equal(parsed.MICHI_REQUIRE_AUTH, '');
  assert.equal(parsed.MICHI_CLOUD, '0');
});

test('systemd unit references the protected environment file without embedding the token', () => {
  const config = {
    repoRoot: '/tmp/Michi Repo',
    envFile: '/tmp/Michi Data/remote.env',
    serverPath: '/tmp/Michi Repo/backend/dist/server.js',
    token: 'must-not-appear-in-unit-123456',
  };
  const unit = renderSystemdUnit(config, '/tmp/Node Runtime/node');
  assert.match(unit, /EnvironmentFile="\/tmp\/Michi Data\/remote\.env"/);
  assert.match(unit, /ExecStart="\/tmp\/Node Runtime\/node" --experimental-sqlite/);
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(unit, /must-not-appear/);
});

test('Node version comparison enforces the documented remote minimum', () => {
  assert.equal(compareVersions('22.18.9'), -1);
  assert.equal(compareVersions('22.19.0'), 0);
  assert.equal(compareVersions('24.0.0'), 1);
});

test('health checks use a reachable address for wildcard and explicit binds', () => {
  assert.equal(healthHostForBind('0.0.0.0'), '127.0.0.1');
  assert.equal(healthHostForBind('::'), '::1');
  assert.equal(healthHostForBind('10.0.0.8'), '10.0.0.8');
});

test('package exposes the one-command remote lifecycle scripts', () => {
  const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(rootPackage.scripts['remote:launch'], 'node scripts/remote-control.mjs launch');
  assert.equal(rootPackage.scripts['remote:status'], 'node scripts/remote-control.mjs status');
  assert.equal(rootPackage.scripts['remote:stop'], 'node scripts/remote-control.mjs stop');
  assert.equal(rootPackage.scripts['remote:restart'], 'node scripts/remote-control.mjs restart');
  assert.equal(rootPackage.scripts['remote:service:remove'], 'node scripts/remote-control.mjs remove-service');
});
