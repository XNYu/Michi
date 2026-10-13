import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { buildRemoteInstallScript, parseRemoteHost, RemoteDesktopSetup, shellQuote } from '../src/services/remoteDesktopSetup';
import { getBackendConnection, listBackendConnections, saveBackendConnection } from '../src/services/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';
import { setupBackendConnectionRoutes } from '../src/routes/backendConnections';

let dataDir = '', oldDataDir: string | undefined;
beforeEach(() => {
  oldDataDir = process.env.MICHI_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-remote-setup-'));
  process.env.MICHI_DATA_DIR = dataDir;
});
afterEach(() => {
  if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = oldDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('accepts build+ and pasted ssh command, rejects shell and option injection', () => {
  assert.deepEqual(parseRemoteHost('ssh build+'), { sshHost: 'build+', sshUser: undefined });
  assert.deepEqual(parseRemoteHost('builder@box'), { sshHost: 'box', sshUser: 'builder' });
  for (const host of ['-oProxyCommand=x', 'host;echo foo', 'host$(id)', 'ssh -p 22 host', 'host\nrm -rf']) {
    assert.throws(() => parseRemoteHost(host), /SSH alias/);
  }
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});

test('installation builds source remotely without resetting a user checkout', () => {
  const script = buildRemoteInstallScript("file:///repo's/source.bundle", 'codex/experiment');
  assert.match(script, /git clone --single-branch --branch 'codex\/experiment'/);
  assert.match(script, /npm run remote:setup/);
  assert.match(script, /sha256sum -c/);
  assert.match(script, /setup.lock/);
  assert.doesNotMatch(script, /reset --hard|StrictHostKeyChecking=no|sudo /);
});

const json = (value: unknown) => 'banner\nMICHI_SETUP_JSON:' + JSON.stringify(value) + '\n';
test('inspection requires an explicit install action, persists nothing before readiness', async () => {
  let calls = 0;
  const service = new RemoteDesktopSetup({ runSsh: async () => { calls++; return json({ home: '/home/u', healthy: false, runtimes: [] }); } });
  const result = await service.connect('build+', false, () => {});
  assert.deepEqual(result, { kind: 'install_required', host: 'build+' });
  assert.equal(calls, 1);
  assert.deepEqual(listBackendConnections(), []);
});

test('healthy setup verifies the API, hides the token, and reuses the saved connection', async () => {
  const remote = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ service: 'michi-backend', status: 'healthy', serverId: 'test-box' }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address(); assert.ok(address && typeof address !== 'string');
  class FakeTunnel extends SshTunnelManager {
    stopped: string[] = [];
    override async apiUrl() { return `http://127.0.0.1:${(address as { port: number }).port}/api`; }
    override stop(id: string) { this.stopped.push(id); }
  }
  const tunnels = new FakeTunnel();
  const token = 'private-token-never-to-renderer';
  const service = new RemoteDesktopSetup({ tunnelManager: tunnels, runSsh: async () => json({ home: '/home/u', healthy: true, token, port: 4444, runtimes: ['kiro'] }) });
  try {
    const result = await service.connect('build+', false, () => {});
    assert.equal(result.kind, 'connected');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    const saved = listBackendConnections()[0];
    assert.equal(getBackendConnection(saved.id)?.token, token);
    const second = await service.connect('build+', false, () => {});
    assert.equal(second.kind === 'connected' && second.connection.id, saved.id);
    assert.equal(listBackendConnections().length, 1);
    assert.ok(tunnels.stopped.every(id => id.startsWith('setup-')));
  } finally { await new Promise<void>(resolve => remote.close(() => resolve())); }
});

test('directory browsing quotes paths and only accepts a stored SSH connection', async () => {
  const saved = saveBackendConnection({ name: 'build+', transport: 'ssh', sshHost: 'build+' });
  let script = '';
  const service = new RemoteDesktopSetup({ runSsh: async (_target, source) => { script = source; return json({ path: '/home/u', parent: '/home', entries: [] }); } });
  await service.browse(saved.id, '/home/a;$(touch nope)');
  assert.match(script, /requested = json.loads/);
  await assert.rejects(service.browse('unknown'), /Select an SSH/);
  await assert.rejects(service.browse(saved.id, '/home/a\n'), /Invalid folder/);
});

test('setup route streams progress and sanitized result under the local-control boundary', async () => {
  class FakeSetup extends RemoteDesktopSetup {
    override async connect(_host: string, _install: boolean, progress: (stage: string, message: string) => void) {
      progress('ssh', 'Connecting…');
      return { kind: 'install_required' as const, host: 'build+' };
    }
  }
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new FakeSetup() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/backend-connections/connect-ssh`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'build+' }) });
    assert.match(response.headers.get('Content-Type') ?? '', /ndjson/);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].type, 'progress'); assert.equal(events[1].result.kind, 'install_required');
    const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ host: 'build+' }) });
    assert.equal(denied.status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
