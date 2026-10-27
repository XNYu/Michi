import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRemoteInstallScript, RemoteDesktopSetup } from '../src/services/remoteDesktopSetup';
import { listBackendConnections } from '../src/services/backendConnections';

const exec = promisify(execFile);
const json = (value: unknown) => 'MICHI_SETUP_JSON:' + JSON.stringify(value);
let home = '', oldDataDir: string | undefined;
const servers: http.Server[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "michi-directories-'"));
  oldDataDir = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = path.join(home, 'local-gateway');
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = oldDataDir;
  fs.rmSync(home, { recursive: true, force: true });
});

async function healthServer(healthyToken?: string) {
  const server = http.createServer((req, res) => {
    const healthy = !!healthyToken && req.headers.authorization === `Bearer ${healthyToken}`;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'michi-backend', status: healthy ? 'healthy' : 'unavailable' }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return address.port;
}

function installation(name: '.michi' | '.michi-remote', port: number, token: string, withBuild = true) {
  const dataDir = path.join(home, name);
  const repo = path.join(home, name + '-source');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'remote.env'), `PORT="${port}"\nMICHI_REMOTE_TOKEN=${JSON.stringify(token)}\n`);
  fs.writeFileSync(path.join(dataDir, 'data.db'), `existing data in ${name}`);
  if (withBuild) {
    fs.mkdirSync(path.join(repo, 'backend/dist'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'backend/dist/server.js'), '');
    fs.writeFileSync(path.join(repo, 'scripts/remote-control.mjs'), '');
    fs.writeFileSync(path.join(dataDir, 'remote.pid'), JSON.stringify({ serverPath: path.join(repo, 'backend/dist/server.js') }));
  }
  return { home, dataDir, repo: withBuild ? repo : null, port, token, healthy: false, runtimes: [] };
}

async function runPython(script: string) {
  const python = script.split("python3 - <<'MICHI_PYTHON'\n")[1]?.split('\nMICHI_PYTHON')[0];
  assert.ok(python, 'generated script contains Python');
  return (await exec('/usr/bin/python3', ['-c', python], {
    env: { HOME: home, PATH: '/nonexistent', NO_PROXY: '*' },
  })).stdout;
}

async function inspect(script: string) {
  const output = await runPython(script);
  return JSON.parse(output.trim().slice('MICHI_SETUP_JSON:'.length));
}

for (const name of ['.michi-remote', '.michi'] as const) {
}

test('post-install verification stays in the selected directory despite another healthy service', async () => {
  const port = await healthServer('legacy-installation-token');
  const legacy = installation('.michi-remote', port, 'legacy-installation-token');
  const current = installation('.michi', port, 'current-installation-token');
  const fresh = await inspect(buildRemoteInstallScript('ssh://example/repo', 'dev'));
  assert.equal(fresh.dataDir, current.dataDir);
  assert.equal(fresh.healthy, false);
  const existingScript = buildRemoteInstallScript('ssh://example/repo', 'dev', undefined, undefined, legacy.dataDir);
  execFileSync('bash', ['-n'], { input: existingScript });
  const existing = await inspect(existingScript);
  assert.equal(existing.dataDir, legacy.dataDir);
  assert.equal(existing.healthy, true);
});

test('a changed identity during startup is not saved as a successful connection', async () => {
  let calls = 0;
  const setup = new RemoteDesktopSetup({ runSsh: async () => {
    calls++;
    return json({ home, repo: '/repo', dataDir: '/data', runtimes: [], port: 4444,
      token: calls === 1 ? 'original-installation-token' : 'different-installation-token', healthy: calls > 1 });
  } });
  await assert.rejects(setup.connect('test-host', false, () => {}), /credentials changed during startup/);
  assert.equal(calls, 2);
  assert.deepEqual(listBackendConnections(), []);
});

for (const name of ['.michi', '.michi-remote'] as const) {
}
