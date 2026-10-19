import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { remoteCredentialCheckPython, remoteCredentialExpiredWarning, type RemoteCredentialProvider } from 'michi-shared';
import { RemoteDesktopSetup, RemoteDesktopError, buildRemoteRecoveryScript } from '../src/services/remoteDesktopSetup';
import { RemoteServiceRecovery } from '../src/services/remoteServiceRecovery';
import { getBackendConnection, saveBackendConnection } from '../src/services/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';
import { setupBackendConnectionRoutes } from '../src/routes/backendConnections';
import { isRemoteConnectByHostEnabled } from '../src/services/remoteConnectFeatureGate';
import type { RemoteDiagnosticLog } from '../src/services/remoteDiagnostics';

let directory = '', oldDir: string | undefined;
beforeEach(() => { oldDir = process.env.MICHI_DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-recovery-')); process.env.MICHI_DATA_DIR = directory; });
afterEach(() => { if (oldDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldDir; fs.rmSync(directory, { recursive: true, force: true }); });
const saved = () => saveBackendConnection({ name: 'Test remote', transport: 'ssh', sshHost: 'test-host', remotePort: 4444, token: 'private-saved-token' });
const json = (value: unknown) => 'MICHI_SETUP_JSON:' + JSON.stringify(value);
async function waitUntil(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Recovery did not settle');
}

test('recovery script reuses saved environment and build without installing or changing system libraries', () => {
  const script = buildRemoteRecoveryScript({ repo: "/home/u/Michi's source", dataDir: '/home/u/.michi-remote' });
  execFileSync('bash', ['-n'], { input: script });
  assert.match(script, /launch --no-setup --data-dir/);
  assert.match(script, /unset PORT MICHI_REMOTE_TOKEN/);
  assert.doesNotMatch(script, /npm (?:install|ci)|git clone|curl |sudo |reset --hard/);
});

test('inspection matches the saved identity and uses its owning checkout', () => {
  const data = path.join(directory, '.michi-remote');
  const repo = path.join(directory, 'custom-michi');
  for (const folder of [data, path.join(repo, 'backend/dist'), path.join(repo, 'scripts')]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(repo, 'backend/dist/server.js'), '');
  fs.writeFileSync(path.join(repo, 'scripts/remote-control.mjs'), '');
  fs.writeFileSync(path.join(data, 'remote.pid'), JSON.stringify({ serverPath: path.join(repo, 'backend/dist/server.js') }));
  fs.writeFileSync(path.join(data, 'remote.env'), 'PORT="4444"\nMICHI_REMOTE_TOKEN="private-saved-token"\n');
  const inspect = (token: string) => {
    const script = buildRemoteRecoveryScript({ repo, dataDir: data, expected: { port: 4444, token } });
    const python = script.split("python3 - <<'MICHI_PYTHON'\n")[1].split('\nMICHI_PYTHON')[0];
    const output = execFileSync('/usr/bin/python3', ['-c', python], { env: { ...process.env, HOME: directory, PATH: '/nonexistent' }, encoding: 'utf8' });
    return JSON.parse(output.trim().slice('MICHI_SETUP_JSON:'.length));
  };
  const info = inspect('private-saved-token');
  assert.equal(info.repo, repo); assert.equal(info.dataDir, data);
  assert.ok(buildRemoteRecoveryScript({ repo, dataDir: data }).includes(remoteCredentialCheckPython()));
  assert.equal(inspect('different-saved-token').dataDir, undefined);
});

const exampleCredentials: RemoteCredentialProvider = {
  name: 'Example SSO', localAction: 'Refresh Example SSO on this computer', localCommand: ['example-login'],
  remoteCommand: ['example-login', '--remote'], remoteCookie: { path: '.example-sso/cookie', domain: 'sso.example' },
  remoteCredentialError: null, localCredentialError: null,
};

test('remote credential check reports only cookie expiry and never the cookie value', () => {
  fs.mkdirSync(path.join(directory, '.example-sso'));
  const cookie = path.join(directory, '.example-sso/cookie');
  const inspect = () => {
    const python = `import json, pathlib, time\nhome = pathlib.Path.home()\nresult = dict(runtimeWarnings=[])\n${remoteCredentialCheckPython(exampleCredentials)}print(json.dumps(result))`;
    const output = execFileSync('/usr/bin/python3', ['-c', python], { env: { ...process.env, HOME: directory }, encoding: 'utf8' });
    assert.doesNotMatch(output, /secret-cookie-value/);
    return JSON.parse(output).runtimeWarnings as string[];
  };
  assert.deepEqual(inspect(), []);
  fs.writeFileSync(cookie, '# Netscape HTTP Cookie File\n#HttpOnly_.sso.example\tTRUE\t/\tTRUE\t1\tcookie\tsecret-cookie-value\n');
  assert.deepEqual(inspect(), [remoteCredentialExpiredWarning(exampleCredentials)]);
  fs.writeFileSync(cookie, `.sso.example\tTRUE\t/\tTRUE\t${Math.floor(Date.now() / 1000) + 600}\tcookie\tsecret-cookie-value\n`);
  assert.deepEqual(inspect(), []);
  assert.equal(remoteCredentialCheckPython({ ...exampleCredentials, remoteCookie: null }), '');
});

test('initial connect starts an existing stopped build without requesting a fresh install', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/agent/status' ? { availableRuntimes: [{ id: 'codex', available: true }] } : { service: 'michi-backend', status: 'healthy' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  class Tunnel extends SshTunnelManager { override async apiUrl() { return `http://127.0.0.1:${port}/api`; } override stop() {} }
  let calls = 0;
  const setup = new RemoteDesktopSetup({ tunnelManager: new Tunnel(), runSsh: async (_target, script) => {
    calls++;
    if (calls === 2) assert.match(script, /launch --no-setup/);
    return json({ home: '/home/u', repo: '/home/u/michi', dataDir: '/home/u/.michi-remote', port: 4444, token: 'private-saved-token', runtimes: ['codex'], healthy: calls > 1 });
  } });
  try {
    assert.equal((await setup.connect('test-host', false, () => {})).kind, 'connected');
    assert.equal(calls, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('saved SSH recovery starts only a stopped installation, verifies health and preserves its identity', async () => {
  const connection = saved();
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'michi-backend', status: 'healthy' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  class Tunnel extends SshTunnelManager { override async apiUrl() { return `http://127.0.0.1:${(address as { port: number }).port}/api`; } override stop() {} }
  const scripts: string[] = [];
  const info = { home: '/home/u', repo: '/home/u/michi', dataDir: '/home/u/.michi-remote', port: 4444, token: 'private-saved-token', runtimes: [] };
  const setup = new RemoteDesktopSetup({ tunnelManager: new Tunnel(), runSsh: async (target, script) => {
    assert.equal(target.sshHost, 'test-host'); scripts.push(script);
    return json({ ...info, healthy: scripts.length > 1 });
  } });
  try {
    await setup.recover(connection.id);
    assert.equal(scripts.length, 2); assert.match(scripts[1], /launch --no-setup/);
    assert.equal(getBackendConnection(connection.id)?.token, info.token);
    assert.equal(getBackendConnection(connection.id)?.remotePort, info.port);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('changed remote credentials prevent startup instead of silently rebinding the saved machine', async () => {
  let calls = 0;
  const setup = new RemoteDesktopSetup({ runSsh: async () => { calls++; return json({ healthy: false, port: 5555, token: 'different-secret', repo: '/home/u/michi', dataDir: '/home/u/.michi-remote' }); } });
  await assert.rejects(setup.recover(saved().id), /port or credentials changed/);
  assert.equal(calls, 1);
});

test('startup is single-flight, bounded by cooldown and exposes the correct local authentication target', async () => {
  let calls = 0, reject!: (error: Error) => void;
  class Setup extends RemoteDesktopSetup { override async recover() { calls++; await new Promise<void>((_resolve, fail) => { reject = fail; }); } }
  const recovery = new RemoteServiceRecovery(new Setup()); const id = saved().id;
  recovery.start(id); recovery.start(id); recovery.start(id, true);
  assert.equal(calls, 1);
  reject(new RemoteDesktopError('ssh_auth', 'SSH authentication needs attention.'));
  await waitUntil(() => recovery.statuses()[0].phase === 'error');
  assert.equal(recovery.statuses()[0].authentication?.scope, 'local');
  assert.doesNotMatch(JSON.stringify(recovery.statuses()), /private-saved-token/);
  recovery.start(id); assert.equal(calls, 1);
  recovery.start(id, true); assert.equal(calls, 2);
  reject(new Error('cancelled')); recovery.stop(id);
});

test('remote credential failure directs authentication to the remote host', async () => {
  class Setup extends RemoteDesktopSetup { override async recover() { throw new RemoteDesktopError('remote_credentials', 'Remote sign-in expired'); } }
  const recovery = new RemoteServiceRecovery(new Setup()); recovery.start(saved().id);
  await waitUntil(() => recovery.statuses()[0].phase === 'error');
  assert.equal(recovery.statuses()[0].authentication?.scope, 'remote');
});

test('deadline settles a stuck recovery, captures the actual stage and permits a new attempt', async () => {
  let signal!: AbortSignal, logs!: RemoteDiagnosticLog, release!: () => void;
  class Setup extends RemoteDesktopSetup {
    override async recover(_id: string, abort?: AbortSignal, diagnostic?: RemoteDiagnosticLog) {
      signal = abort!; logs = diagnostic!;
      diagnostic?.stage('ssh', 'Checking the saved remote Michi installation…');
      diagnostic?.append('ssh stderr', 'Waiting for proxy');
      await new Promise<void>(resolve => { release = resolve; });
      diagnostic?.stage('verify', 'Late result');
    }
  }
  const recovery = new RemoteServiceRecovery(new Setup(), 30);
  const id = saved().id;
  recovery.start(id);
  assert.equal(recovery.statuses()[0].message, 'Checking the saved remote Michi installation…');
  assert.equal(recovery.statuses()[0].diagnostic?.severity, 'info');
  await waitUntil(() => recovery.statuses()[0].phase === 'error');
  const status = recovery.statuses()[0];
  assert.equal(status.diagnostic?.code, 'recovery_timeout');
  assert.equal(status.diagnostic?.stage, 'ssh');
  assert.match(status.message, /timed out at ssh/);
  assert.match(status.diagnostic!.log, /Waiting for proxy/);
  assert.equal(signal.aborted, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.report.stage, 'ssh');
  assert.equal(recovery.statuses()[0].phase, 'error');
  recovery.start(id, true); recovery.stop(id); release();
});

test('proxy starts recovery after transport failure, never replays a write and excludes direct connections', async () => {
  let calls = 0;
  class Setup extends RemoteDesktopSetup { override async recover() { calls++; } }
  class Tunnel extends SshTunnelManager { override async apiUrl() { return 'http://127.0.0.1:1/api'; } }
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new Setup(), tunnelManager: new Tunnel(), connectByHost: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/backend-connections`;
  try {
    const id = saved().id;
    const failedWrite = await fetch(`${base}/${id}/proxy/chats/one/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }) });
    assert.equal(failedWrite.status, 502); assert.equal(calls, 1);
    const statuses = await fetch(base + '/recovery').then(response => response.json()) as { recoveries: unknown[] };
    assert.equal(statuses.recoveries.length, 1);
    const direct = saveBackendConnection({ name: 'Direct', apiUrl: 'http://127.0.0.1:1' });
    assert.equal((await fetch(`${base}/${direct.id}/proxy/health`)).status, 502); assert.equal(calls, 1);
    assert.equal((await fetch(`${base}/${id}/recover`, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('without Connect by host, setup and recovery are refused and a failed proxy request runs nothing over SSH', async () => {
  let calls = 0;
  class Setup extends RemoteDesktopSetup {
    override async recover() { calls++; }
    override async connect(): Promise<never> { calls++; throw new Error('connect must not run'); }
  }
  class Tunnel extends SshTunnelManager { override async apiUrl() { return 'http://127.0.0.1:1/api'; } }
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new Setup(), tunnelManager: new Tunnel(), connectByHost: false }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/backend-connections`;
  try {
    const id = saved().id;
    const listed = await fetch(base).then(response => response.json()) as { connectByHost: boolean; connections: unknown[] };
    assert.equal(listed.connectByHost, false); assert.equal(listed.connections.length, 1);
    const connect = await fetch(`${base}/connect-ssh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'test-host' }) });
    assert.equal(connect.status, 404); assert.equal((await connect.json() as { code: string }).code, 'feature_disabled');
    const recover = await fetch(`${base}/${id}/recover`, { method: 'POST' });
    assert.equal(recover.status, 404);
    const failed = await fetch(`${base}/${id}/proxy/health`);
    assert.equal(failed.status, 502);
    const body = await failed.json() as { error: string; recovery?: unknown };
    assert.match(body.error, /Remote backend unavailable/); assert.equal(body.recovery, undefined);
    const statuses = await fetch(base + '/recovery').then(response => response.json()) as { recoveries: unknown[] };
    assert.deepEqual(statuses.recoveries, []); assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Connect by host is enabled only by MICHI_REMOTE_CONNECT_BY_HOST=1', () => {
  assert.equal(isRemoteConnectByHostEnabled({}), false);
  assert.equal(isRemoteConnectByHostEnabled({ MICHI_REMOTE_CONNECT_BY_HOST: 'true' }), false);
  assert.equal(isRemoteConnectByHostEnabled({ MICHI_REMOTE_CONNECT_BY_HOST: '1' }), true);
});
