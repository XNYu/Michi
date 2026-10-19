import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRemoteInstallScript, RemoteDesktopSetup, shellQuote } from '../src/services/remoteDesktopSetup';
import { getBackendConnection, listBackendConnections, saveBackendConnection } from '../src/services/backendConnections';
import { RemoteDiagnosticLog } from '../src/services/remoteDiagnostics';
import { SshTunnelManager } from '../src/services/sshTunnelManager';

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

async function discover() {
  let info: Awaited<ReturnType<typeof inspect>>;
  const setup = new RemoteDesktopSetup({ runSsh: async (_target, script) => {
    info = await inspect(script);
    throw new Error('stop after inspection');
  } });
  await assert.rejects(setup.connect('test-host', false, () => {}), /stop after inspection/);
  return info;
}

test('new install uses the manual launcher data default and retains managed source separately', () => {
  const script = buildRemoteInstallScript('ssh://example/repo', 'dev');
  execFileSync('bash', ['-n'], { input: script });
  assert.match(script, /data="\$HOME\/\.michi"\n/);
  assert.match(script, /root="\$HOME\/\.local\/share\/michi\/devdesktop"/);
  assert.match(script, /MICHI_DATA_DIR="\$data" MICHI_CONFIG_DIR="\$data" MICHI_LOG_DIR="\$data\/logs"/);
  assert.match(script, /unset PORT MICHI_REMOTE_TOKEN MICHI_BIND_HOST/);
  assert.match(script, /launch --no-setup --data-dir "\$data"/);
});

for (const name of ['.michi-remote', '.michi'] as const) {
  test(`saved recovery selects stopped ${name} even when the other directory is healthy`, async () => {
    // Sharing a port makes matching both the port and the token essential.
    const port = await healthServer('other-installation-token');
    const wanted = installation(name, port, 'saved-installation-token');
    installation(name === '.michi' ? '.michi-remote' : '.michi', port, 'other-installation-token');
    const saved = saveBackendConnection({ name: 'test', transport: 'ssh', sshHost: 'test-host', remotePort: port, token: wanted.token });
    const before = getBackendConnection(saved.id);
    let calls = 0;
    const setup = new RemoteDesktopSetup({ runSsh: async (_target, script) => {
      calls++;
      const info = await inspect(script);
      assert.equal(info.dataDir, wanted.dataDir);
      assert.equal(info.repo, wanted.repo);
      assert.equal(info.token, wanted.token);
      assert.equal(info.healthy, false);
      if (calls === 2) {
        assert.ok(script.includes(`data=${shellQuote(wanted.dataDir)}`));
        assert.ok(script.includes(`repo=${shellQuote(wanted.repo!)}`));
        throw new Error('stop before remote launch');
      }
      return json(info);
    } });
    await assert.rejects(setup.recover(saved.id), /stop before remote launch/);
    assert.equal(calls, 2);
    assert.deepEqual(getBackendConnection(saved.id), before);
  });
}

test('saved recovery rejects the wrong port even when the token matches', async () => {
  const port = await healthServer();
  installation('.michi', port, 'saved-installation-token');
  const saved = saveBackendConnection({ name: 'test', transport: 'ssh', sshHost: 'test-host', remotePort: port === 65535 ? port - 1 : port + 1, token: 'saved-installation-token' });
  let calls = 0;
  const setup = new RemoteDesktopSetup({ runSsh: async (_target, script) => { calls++; return runPython(script); } });
  await assert.rejects(setup.recover(saved.id), /port or credentials changed/);
  assert.equal(calls, 1);
});

test('discovery preserves each stopped installation and prefers legacy when both coexist', async () => {
  const port = await healthServer();
  const current = installation('.michi', port, 'current-installation-token');
  assert.equal((await discover()).dataDir, current.dataDir);
  const legacy = installation('.michi-remote', port, 'legacy-installation-token');
  const both = await discover();
  assert.equal(both.dataDir, legacy.dataDir);
  assert.equal(both.repo, legacy.repo);
  assert.equal(both.token, legacy.token);
  fs.rmSync(current.dataDir, { recursive: true });
  assert.equal((await discover()).dataDir, legacy.dataDir);
});

test('healthy discovery does not inherit another installation checkout', async () => {
  const port = await healthServer('current-installation-token');
  installation('.michi-remote', port, 'legacy-installation-token');
  const current = installation('.michi', port, 'current-installation-token', false);
  const info = await discover();
  assert.equal(info.dataDir, current.dataDir);
  assert.equal(info.repo, null);
  assert.equal(info.healthy, true);
});

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

test('preparing a missing legacy build preserves its directory, credentials and database', async () => {
  const port = await healthServer();
  const legacy = installation('.michi-remote', port, 'legacy-installation-token', false);
  const envBefore = fs.readFileSync(path.join(legacy.dataDir, 'remote.env'), 'utf8');
  // An unbuilt managed checkout must request preparation rather than repeatedly
  // attempting recovery with a missing server.js.
  const scripts = path.join(home, '.local/share/michi/devdesktop/source/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'remote-control.mjs'), '');
  let calls = 0;
  const setup = new RemoteDesktopSetup({ runSsh: async (_target, script) => {
    calls++;
    if (calls === 2) {
      assert.ok(script.includes(`data=${shellQuote(legacy.dataDir)}`));
      assert.match(script, /npm run remote:setup/);
      const info = await inspect(script);
      assert.equal(info.dataDir, legacy.dataDir);
      assert.equal(info.token, legacy.token);
      assert.equal(info.port, legacy.port);
      throw new Error('stop before installation');
    }
    return runPython(script);
  } });
  await assert.rejects(setup.connect('test-host', true, () => {}), /stop before installation/);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(legacy.dataDir, 'remote.env'), 'utf8'), envBefore);
  assert.equal(fs.readFileSync(path.join(legacy.dataDir, 'data.db'), 'utf8'), 'existing data in .michi-remote');
  assert.equal(fs.existsSync(path.join(home, '.michi')), false);
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
  test(`failure diagnostics read ${name} service log without the other directory's output`, async () => {
    const selected = installation(name, 4444, 'selected-installation-token');
    const other = installation(name === '.michi' ? '.michi-remote' : '.michi', 5555, 'other-installation-token');
    fs.writeFileSync(path.join(selected.dataDir, 'remote.log'), 'selected service output');
    fs.writeFileSync(path.join(other.dataDir, 'remote.log'), 'unrelated service output');
    class Tunnel extends SshTunnelManager { override async apiUrl(): Promise<string> { throw new Error('forwarding failed'); } override stop() {} }
    let calls = 0;
    const diagnostic = new RemoteDiagnosticLog('test-host');
    const setup = new RemoteDesktopSetup({ tunnelManager: new Tunnel(), runSsh: async (_target, script) => {
      calls++;
      return calls === 1 ? json({ ...selected, healthy: true }) : runPython(script);
    } });
    try {
      await assert.rejects(setup.connect('test-host', false, () => {}, undefined, diagnostic), /forwarding failed/);
      assert.equal(calls, 2);
      assert.match(diagnostic.report.log, /selected service output/);
      assert.doesNotMatch(diagnostic.report.log, /unrelated service output/);
    } finally { diagnostic.finish(); }
  });
}
