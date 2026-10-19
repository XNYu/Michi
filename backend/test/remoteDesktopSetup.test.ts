import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { buildRemoteInstallScript, parseRemoteHost, RemoteDesktopSetup, RemoteDesktopError, runRemoteSsh, shellQuote } from '../src/services/remoteDesktopSetup';
import { getBackendConnection, listBackendConnections, saveBackendConnection } from '../src/services/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';
import { RemoteDiagnosticLog } from '../src/services/remoteDiagnostics';
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
  assert.match(script, /process.execPath =/);
  assert.match(script, /node\.elf.*"\\\$@"/);
  execFileSync('bash', ['-n'], { input: script });
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
  const remote = http.createServer((req, res) => {
    if (req.url === '/api/agent/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ runtime: 'kiro', hasRequiredKey: true, availableRuntimes: [{ id: 'kiro', available: true }] }));
      return;
    }
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

test('does not persist the credential when the forwarded API fails verification', async () => {
  class WrongTunnel extends SshTunnelManager {
    override async apiUrl() { return 'http://127.0.0.1:1/api'; }
    override stop() {}
  }
  const service = new RemoteDesktopSetup({ tunnelManager: new WrongTunnel(),
    runSsh: async () => json({ healthy: true, home: '/home/u', token: 'secret-never-persisted', port: 4444, runtimes: [] }) });
  await assert.rejects(service.connect('build+', false, () => {}));
  assert.deepEqual(listBackendConnections(), []);
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
    assert.equal(events[0].type, 'attempt'); assert.equal(events[1].type, 'progress'); assert.equal(events[2].result.kind, 'install_required');
    const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ host: 'build+' }) });
    assert.equal(denied.status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('SSH failure preserves stderr, process exit and spawn errors without credential output', async () => {
  const old = process.env.MICHI_SSH_BIN;
  const file = path.join(dataDir, 'fake-ssh');
  fs.writeFileSync(file, '#!/bin/sh\nprintf "Permission denied (publickey).\\n" >&2\nprintf "MICHI_REMOTE_TOKEN=private-value\\n"\nexit 255\n', { mode: 0o700 });
  const diagnostic = new RemoteDiagnosticLog('build+');
  try {
    process.env.MICHI_SSH_BIN = file;
    await assert.rejects(runRemoteSsh({ sshHost: 'build+' }, 'ignored', undefined, undefined, diagnostic), /SSH authentication/);
    assert.match(diagnostic.report.log, /Permission denied \(publickey\)/);
    assert.match(diagnostic.report.log, /code=255/);
    assert.doesNotMatch(diagnostic.report.log, /private-value/);
    process.env.MICHI_SSH_BIN = path.join(dataDir, 'missing-ssh');
    await assert.rejects(runRemoteSsh({ sshHost: 'build+' }, '', undefined, undefined, diagnostic), /ENOENT/);
    assert.match(diagnostic.report.log, /ENOENT/);
  } finally { diagnostic.finish(); if (old === undefined) delete process.env.MICHI_SSH_BIN; else process.env.MICHI_SSH_BIN = old; }
});

test('aborting SSH settles promptly, retains output and redacts split protocol and private-key lines', async () => {
  const old = process.env.MICHI_SSH_BIN;
  const file = path.join(dataDir, 'stuck-ssh');
  fs.writeFileSync(file, '#!/bin/sh\ntrap "" TERM\nprintf "Waiting for proxy\\n" >&2\nprintf "MICHI_SETUP_"\nsleep 0.1\nprintf \'JSON:{"token":"private-protocol"}\\n\'\nprintf "%s\\n" "-----BEGIN OPENSSH PRIVATE KEY-----" "private-key-body" "-----END OPENSSH PRIVATE KEY-----"\nsleep 60\n', { mode: 0o700 });
  const diagnostic = new RemoteDiagnosticLog('build+');
  const controller = new AbortController();
  try {
    process.env.MICHI_SSH_BIN = file;
    const operation = runRemoteSsh({ sshHost: 'build+' }, '', controller.signal, undefined, diagnostic);
    const rejected = assert.rejects(operation, /Connection cancelled/);
    for (let i = 0; i < 50 && !diagnostic.report.log.includes('private key omitted'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(diagnostic.report.log, /Waiting for proxy/);
    assert.match(diagnostic.report.log, /private setup response omitted/);
    assert.doesNotMatch(diagnostic.report.log, /private-protocol|private-key-body/);
    controller.abort(); await rejected;
    assert.match(diagnostic.report.log, /ssh exit.*Connection cancelled/);
  } finally {
    controller.abort(); diagnostic.finish();
    if (old === undefined) delete process.env.MICHI_SSH_BIN; else process.env.MICHI_SSH_BIN = old;
  }
});

test('SSH exit settles even when a proxy descendant holds its output pipes open', async () => {
  const old = process.env.MICHI_SSH_BIN;
  const file = path.join(dataDir, 'orphan-pipes-ssh');
  fs.writeFileSync(file, '#!/bin/sh\nsleep 60 &\nprintf "Permission denied (publickey).\\n" >&2\nexit 255\n', { mode: 0o700 });
  const diagnostic = new RemoteDiagnosticLog('build+');
  try {
    process.env.MICHI_SSH_BIN = file;
    await assert.rejects(runRemoteSsh({ sshHost: 'build+' }, '', undefined, undefined, diagnostic), /SSH authentication/);
    assert.match(diagnostic.report.log, /code=255/);
  } finally { diagnostic.finish(); if (old === undefined) delete process.env.MICHI_SSH_BIN; else process.env.MICHI_SSH_BIN = old; }
});

test('collects only this attempt setup log on remote build failure and preserves the original stage', async () => {
  let calls = 0;
  const diagnostic = new RemoteDiagnosticLog('build+');
  const service = new RemoteDesktopSetup({ runSsh: async (_target, script, _signal, progress) => {
    calls++;
    if (calls === 1) return json({ healthy: false });
    if (calls === 2) {
      assert.match(script, new RegExp('setup\\.' + diagnostic.report.id + '\\.log'));
      progress?.('build', 'Building remotely');
      throw new RemoteDesktopError('build', 'Remote build failed.');
    }
    assert.match(script, new RegExp('setup\\.' + diagnostic.report.id + '\\.log'));
    return 'npm ERR! dependency unavailable\nMICHI_REMOTE_TOKEN=private-log-token';
  } });
  try {
    await assert.rejects(service.connect('build+', true, (stage, message) => diagnostic.stage(stage, message), undefined, diagnostic), /Remote build failed/);
    assert.equal(diagnostic.report.stage, 'build');
    assert.match(diagnostic.report.log, /dependency unavailable/);
    assert.doesNotMatch(diagnostic.report.log, /private-log-token/);
  } finally { diagnostic.finish(); }
});

test('unknown errors include real cause, stage and retrievable diagnostics under the local-control boundary', async () => {
  class FailingSetup extends RemoteDesktopSetup {
    override async connect(_host: string, _install: boolean, progress: (stage: string, message: string) => void): Promise<never> {
      progress('tunnel', 'Opening SSH forwarding');
      throw new Error('listen EADDRINUSE: port already in use');
    }
  }
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new FailingSetup() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/backend-connections`;
  try {
    const response = await fetch(base + '/connect-ssh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'build+' }) });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const failure = events.at(-1);
    assert.equal(failure.diagnostic.stage, 'tunnel');
    assert.match(failure.message, /EADDRINUSE/);
    const saved = await fetch(base + '/diagnostics/' + events[0].id);
    assert.equal(saved.status, 200);
    assert.match(((await saved.json()) as { log: string }).log, /EADDRINUSE/);
    const denied = await fetch(base + '/diagnostics/' + events[0].id, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('connected runtime warnings return a saved diagnostic and preserve a successful result', async () => {
  class WarningSetup extends RemoteDesktopSetup {
    override async connect() {
      return { kind: 'connected' as const,
        connection: saveBackendConnection({ name: 'build+', transport: 'ssh', sshHost: 'build+' }),
        home: '/home/u', runtimes: ['codex'], runtimeWarnings: ['Codex needs sign-in. API_TOKEN=hidden-value'],
      };
    }
  }
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new WarningSetup() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/backend-connections`;
  try {
    const response = await fetch(base + '/connect-ssh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'build+' }) });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const result = events.at(-1).result;
    assert.equal(result.kind, 'connected');
    assert.equal(result.diagnostic.severity, 'warning');
    assert.match(result.diagnostic.log, /Codex needs sign-in/);
    assert.doesNotMatch(JSON.stringify(result), /hidden-value/);
    const saved = await fetch(base + '/diagnostics/' + result.diagnostic.id);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { code: string }).code, 'runtime_warning');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


const runtimeScenarios: { name: string; detected: string[]; current: string; available: string[]; expected?: string;
  hasKey?: boolean; expectedDetected?: string[]; unavailable?: boolean; failStatus?: boolean; failOptions?: boolean }[] = [
  { name: 'Codex only without Kiro', detected: ['codex'], current: 'kiro', available: ['codex'], expected: 'codex' },
  { name: 'Claude only without Kiro', detected: ['claude'], current: 'kiro', available: ['claude'], expected: 'claude' },
  { name: 'multiple runtimes keep existing choice', detected: ['claude', 'codex'], current: 'codex', available: ['claude', 'codex'] },
  { name: 'no agent still connects', detected: [], current: 'kiro', available: [] },
  { name: 'configured Pi detected from backend', detected: [], current: 'pi', available: ['pi'], hasKey: true, expectedDetected: ['pi'] },
  { name: 'unconfigured Pi is not preselected', detected: ['codex'], current: 'pi', available: ['pi', 'codex'], expected: 'codex' },
  { name: 'unavailable installed agent reports warning', detected: ['codex'], current: 'kiro', available: [], unavailable: true },
  { name: 'old status failure is advisory', detected: ['codex'], current: 'kiro', available: [], failStatus: true },
  { name: 'preselection failure is advisory', detected: ['codex'], current: 'kiro', available: ['codex'], expected: 'codex', failOptions: true },
];
for (const scenario of runtimeScenarios) {
  test('runtime discovery: ' + scenario.name, async () => {
    const selected: string[] = [];
    const token = 'test-runtime-token-never-to-renderer';
    const remote = http.createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent/status') {
        res.statusCode = scenario.failStatus ? 503 : 200;
        const ids = [...new Set(['kiro', 'pi', ...scenario.available, ...scenario.detected])];
        res.end(JSON.stringify({ runtime: scenario.current, hasRequiredKey: !!scenario.hasKey,
          availableRuntimes: ids.map(id => ({ id, label: id, available: scenario.available.includes(id), requiresApiKey: id === 'pi', unavailableReason: 'Sign in on the remote machine.' })) }));
      } else if (req.url === '/api/agent/options') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { selected.push(JSON.parse(body).runtime); res.statusCode = scenario.failOptions ? 503 : 200; res.end('{}'); });
      } else res.end(JSON.stringify({ service: 'michi-backend', status: 'healthy', serverId: 'runtime-test-box' }));
    });
    await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address(); assert.ok(address && typeof address !== 'string');
    class FakeTunnel extends SshTunnelManager {
      override async apiUrl() { return `http://127.0.0.1:${(address as { port: number }).port}/api`; }
      override stop() {}
    }
    const diagnostic = new RemoteDiagnosticLog('build+');
    const service = new RemoteDesktopSetup({ tunnelManager: new FakeTunnel(), runSsh: async () => json({
      home: '/home/u', healthy: true, token, port: 4444, runtimes: scenario.detected,
    }) });
    try {
      const result = await service.connect('build+', false, () => {}, undefined, diagnostic);
      assert.equal(result.kind, 'connected');
      if (result.kind !== 'connected') return;
      assert.deepEqual(result.runtimes, scenario.expectedDetected ?? scenario.detected);
      assert.deepEqual(selected, scenario.expected ? [scenario.expected] : []);
      assert.equal(result.runtimeWarnings.length > 0, !!(scenario.unavailable || scenario.failStatus || scenario.failOptions));
      assert.equal(listBackendConnections().length, 1);
      assert.doesNotMatch(JSON.stringify(result) + diagnostic.report.log, new RegExp(token));
    } finally { diagnostic.finish(); await new Promise<void>(resolve => remote.close(() => resolve())); }
  });
}

test('cancelling runtime discovery does not save the connection or preselect a runtime', async () => {
  const controller = new AbortController();
  let optionsCalls = 0;
  const remote = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/status') {
      controller.abort();
      res.end(JSON.stringify({ runtime: 'kiro', hasRequiredKey: true, availableRuntimes: [{ id: 'codex', available: true }] }));
    } else if (req.url === '/api/agent/options') { optionsCalls++; res.end('{}'); }
    else res.end(JSON.stringify({ service: 'michi-backend', status: 'healthy', serverId: 'cancel-test' }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address(); assert.ok(address && typeof address !== 'string');
  class FakeTunnel extends SshTunnelManager {
    override async apiUrl() { return `http://127.0.0.1:${(address as { port: number }).port}/api`; }
    override stop() {}
  }
  const service = new RemoteDesktopSetup({ tunnelManager: new FakeTunnel(), runSsh: async () => json({
    home: '/home/u', healthy: true, token: 'cancel-test-token', port: 4444, runtimes: ['codex'],
  }) });
  try {
    await assert.rejects(service.connect('build+', false, () => {}, controller.signal), /Connection cancelled/);
    assert.deepEqual(listBackendConnections(), []);
    assert.equal(optionsCalls, 0);
  } finally { await new Promise<void>(resolve => remote.close(() => resolve())); }
});
