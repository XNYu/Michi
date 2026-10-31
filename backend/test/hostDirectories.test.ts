import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { HostDirectoryError, listHostDirectory } from '../src/services/hostDirectories';
import { setupHostDirectoryRoutes } from '../src/routes/hostDirectories';
import { createRemoteAccessMiddleware } from '../src/services/remoteAccess';
import { RemoteDesktopSetup } from '../src/services/remoteDesktopSetup';
import { saveBackendConnection } from '../src/services/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';

let root = '', oldDataDir: string | undefined;
const oldRemote = { access: process.env.MICHI_REMOTE_ACCESS, token: process.env.MICHI_REMOTE_TOKEN };
beforeEach(() => {
  oldDataDir = process.env.MICHI_DATA_DIR;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-host-dirs-')));
  process.env.MICHI_DATA_DIR = path.join(root, 'data');
});
afterEach(() => {
  if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldDataDir;
  if (oldRemote.access === undefined) delete process.env.MICHI_REMOTE_ACCESS; else process.env.MICHI_REMOTE_ACCESS = oldRemote.access;
  if (oldRemote.token === undefined) delete process.env.MICHI_REMOTE_TOKEN; else process.env.MICHI_REMOTE_TOKEN = oldRemote.token;
  fs.rmSync(root, { recursive: true, force: true });
});

async function listen(app: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

describe('host directory listing', () => {
  test('lists visible subfolders like the SSH listing', async () => {
    const home = path.join(root, 'home');
    for (const dir of ['beta', 'Alpha', '.hidden', 'gamma/inner']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, 'file.txt'), '');
    fs.symlinkSync(path.join(home, 'gamma'), path.join(home, 'link-to-gamma'));
    fs.symlinkSync(path.join(home, 'missing'), path.join(home, 'dangling'));

    const listed = await listHostDirectory('~', home);
    assert.equal(listed.path, home);
    assert.equal(listed.parent, root);
    assert.deepEqual(listed.entries.map(entry => entry.name), ['Alpha', 'beta', 'gamma', 'link-to-gamma']);
    assert.equal(listed.entries[3].path, path.join(home, 'link-to-gamma'));

    assert.equal((await listHostDirectory('gamma', home)).path, path.join(home, 'gamma'));
    assert.equal((await listHostDirectory('~/link-to-gamma', home)).path, path.join(home, 'gamma'));
    assert.equal((await listHostDirectory('/', home)).parent, null);
    await assert.rejects(listHostDirectory('missing', home), (error: unknown) => error instanceof HostDirectoryError && error.code === 'path');
    await assert.rejects(listHostDirectory('file.txt', home), (error: unknown) => error instanceof HostDirectoryError && error.code === 'path');
    await assert.rejects(listHostDirectory('a\nb', home), (error: unknown) => error instanceof HostDirectoryError && error.code === 'invalid_path');
  });

  test('the route answers only token-authenticated remote requests', async () => {
    process.env.MICHI_REMOTE_ACCESS = '1';
    process.env.MICHI_REMOTE_TOKEN = 'host-directories-test-token';
    const gated = express();
    gated.use('/api', createRemoteAccessMiddleware(), setupHostDirectoryRoutes());
    // Mounted without the token middleware, the route still refuses.
    const ungated = express();
    ungated.use('/api', setupHostDirectoryRoutes());
    const a = await listen(gated), b = await listen(ungated);
    try {
      const url = (port: number) => `http://127.0.0.1:${port}/api/host/directories?path=${encodeURIComponent(root)}`;
      assert.equal((await fetch(url(a.port))).status, 401);
      assert.equal((await fetch(url(a.port), { headers: { Authorization: 'Bearer wrong-token-value-xx' } })).status, 401);
      const ok = await fetch(url(a.port), { headers: { Authorization: 'Bearer host-directories-test-token' } });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json() as { path: string }).path, root);
      const missing = await fetch(url(a.port) + 'nope', { headers: { Authorization: 'Bearer host-directories-test-token' } });
      assert.equal(missing.status, 400);
      assert.equal((await missing.json() as { code: string }).code, 'path');
      assert.equal((await fetch(url(b.port))).status, 403);
    } finally { await a.close(); await b.close(); }
  });
});

describe('remote browsing through the tunnel', () => {
  const token = 'saved-remote-token-value';
  const directory = { path: '/home/u/src', parent: '/home/u', entries: [{ name: 'Michi', path: '/home/u/src/Michi' }] };
  class FakeTunnel extends SshTunnelManager {
    constructor(private readonly url: string) { super(); }
    override async apiUrl() { return this.url; }
    override stop() {}
  }
  function setup(apiUrl: string, host = 'box') {
    const saved = saveBackendConnection({ name: host, transport: 'ssh', sshHost: host, token });
    const ssh = { calls: 0 };
    const service = new RemoteDesktopSetup({
      tunnelManager: new FakeTunnel(apiUrl),
      runSsh: async () => { ssh.calls++; return 'MICHI_SETUP_JSON:' + JSON.stringify({ path: '/ssh', parent: '/', entries: [] }) + '\n'; },
    });
    return { saved, service, ssh };
  }

  test('uses the remote API with the saved token and skips SSH', async () => {
    let seen: { auth?: string; path?: string | null } = {};
    const remote = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen = { auth: req.headers.authorization, path: url.searchParams.get('path') };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(directory));
    });
    try {
      const { saved, service, ssh } = setup(`http://127.0.0.1:${remote.port}/api`);
      assert.deepEqual(await service.browse(saved.id, '~/src'), directory);
      assert.deepEqual(seen, { auth: 'Bearer ' + token, path: '~/src' });
      assert.equal(ssh.calls, 0);
    } finally { await remote.close(); }
  });

  test('a folder error from the remote API is final', async () => {
    const remote = await listen((_req, res) => {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'x', code: 'path' }));
    });
    try {
      const { saved, service, ssh } = setup(`http://127.0.0.1:${remote.port}/api`);
      await assert.rejects(service.browse(saved.id, '/nope'), /does not exist or cannot be read/);
      assert.equal(ssh.calls, 0);
    } finally { await remote.close(); }
  });

  test('falls back to SSH for older remotes, bad responses and unreachable tunnels', async () => {
    let mode: 'missing' | 'garbage' | 'unauthorized' = 'missing';
    const remote = await listen((_req, res) => {
      if (mode === 'missing') { res.statusCode = 404; res.end('Cannot GET /api/host/directories'); return; }
      if (mode === 'unauthorized') { res.statusCode = 401; res.end('{"error":"invalid remote access token"}'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end('{"path":1}');
    });
    try {
      const { saved, service, ssh } = setup(`http://127.0.0.1:${remote.port}/api`);
      for (const next of ['missing', 'garbage', 'unauthorized'] as const) {
        mode = next;
        assert.equal((await service.browse(saved.id)).path, '/ssh', next);
      }
      assert.equal(ssh.calls, 3);
    } finally { await remote.close(); }
    const unreachable = setup('http://127.0.0.1:1/api', 'stopped-box');
    assert.equal((await unreachable.service.browse(unreachable.saved.id)).path, '/ssh');
    assert.equal(unreachable.ssh.calls, 1);
  });

  test('a connection without a saved token keeps the SSH listing', async () => {
    const saved = saveBackendConnection({ name: 'plain', transport: 'ssh', sshHost: 'plain' });
    let tunnelUsed = false;
    class WatchedTunnel extends SshTunnelManager {
      override async apiUrl(): Promise<string> { tunnelUsed = true; throw new Error('unexpected'); }
    }
    let calls = 0;
    const service = new RemoteDesktopSetup({ tunnelManager: new WatchedTunnel(),
      runSsh: async () => { calls++; return 'MICHI_SETUP_JSON:' + JSON.stringify({ path: '/ssh', parent: '/', entries: [] }) + '\n'; } });
    assert.equal((await service.browse(saved.id)).path, '/ssh');
    assert.equal(tunnelUsed, false);
    assert.equal(calls, 1);
  });
});
