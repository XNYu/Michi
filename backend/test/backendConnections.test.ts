import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {
  type BackendConnectionRecord,
  deleteBackendConnection,
  getBackendConnection,
  listBackendConnections,
  normalizeBackendApiUrl,
  normalizeBackendConnection,
  probeBackendConnection,
  saveBackendConnection,
} from '../src/services/backendConnections';
import { setupBackendConnectionRoutes } from '../src/routes/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';

let tempDir = '';
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.MICHI_DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-connections-'));
  process.env.MICHI_DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR;
  else process.env.MICHI_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('backend connection persistence', () => {
  test('normalizes host URLs to an API root', () => {
    assert.equal(normalizeBackendApiUrl('example.com:3000'), 'http://example.com:3000/api');
    assert.equal(normalizeBackendApiUrl('https://example.com/api/'), 'https://example.com/api');
    assert.throws(() => normalizeBackendApiUrl('file:///tmp/server'), /http or https/);
  });

  test('stores tokens but redacts them from summaries', () => {
    const saved = saveBackendConnection({
      name: 'Build box',
      apiUrl: 'https://build.example.com',
      token: 'super-secret-remote-token',
    });
    assert.equal(saved.hasToken, true);
    assert.equal((saved as unknown as Record<string, unknown>).token, undefined);
    assert.equal(listBackendConnections()[0].apiUrl, 'https://build.example.com/api');
    assert.equal(getBackendConnection(saved.id)?.token, 'super-secret-remote-token');
    assert.equal(fs.statSync(path.join(tempDir, 'config.json')).mode & 0o777, 0o600);
    assert.equal(deleteBackendConnection(saved.id), true);
    assert.deepEqual(listBackendConnections(), []);
  });

  test('blank token on edit preserves the saved secret', () => {
    const first = saveBackendConnection({ name: 'Remote', apiUrl: 'http://host:3000', token: 'existing-secret-token' });
    saveBackendConnection({ id: first.id, name: 'Renamed', apiUrl: 'http://host:3000/api', token: '' });
    assert.equal(getBackendConnection(first.id)?.token, 'existing-secret-token');
  });

  test('loads legacy direct records that predate the transport field', () => {
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
      backendConnections: [{
        id: 'legacy-1',
        name: 'Legacy',
        apiUrl: 'https://legacy.example.com/api',
        token: '',
        createdAt: 1,
        updatedAt: 2,
      }],
    }));

    assert.deepEqual(listBackendConnections(), [{
      id: 'legacy-1',
      name: 'Legacy',
      transport: 'direct',
      apiUrl: 'https://legacy.example.com/api',
      sshHost: undefined,
      sshUser: undefined,
      sshPort: undefined,
      remotePort: undefined,
      hasToken: false,
      createdAt: 1,
      updatedAt: 2,
    }]);
  });

  test('persists SSH settings while keeping the token server-side', () => {
    const saved = saveBackendConnection({
      name: 'SSH build box',
      transport: 'ssh',
      sshHost: 'build-server-box',
      sshUser: 'builder',
      sshPort: 2222,
      remotePort: 4649,
      token: 'super-secret-remote-token',
    });

    assert.equal(saved.transport, 'ssh');
    assert.equal(saved.sshHost, 'build-server-box');
    assert.equal(saved.hasToken, true);
    assert.equal((saved as unknown as Record<string, unknown>).token, undefined);
    assert.equal(getBackendConnection(saved.id)?.token, 'super-secret-remote-token');
    assert.equal(getBackendConnection(saved.id)?.apiUrl, '');
  });

  test('rejects unsafe SSH targets and invalid ports', () => {
    const base = { name: 'SSH', transport: 'ssh' as const, sshHost: 'build-server-box' };
    assert.throws(() => normalizeBackendConnection({ ...base, sshHost: '-proxy-command' }), /SSH host/);
    assert.throws(() => normalizeBackendConnection({ ...base, sshHost: 'host name' }), /SSH host/);
    assert.throws(() => normalizeBackendConnection({ ...base, sshUser: 'user@host' }), /SSH user/);
    assert.throws(() => normalizeBackendConnection({ ...base, sshPort: 0 }), /SSH port/);
    assert.throws(() => normalizeBackendConnection({ ...base, remotePort: 65536 }), /Remote port/);
  });

  test('treats omitted and explicit default SSH ports as the same target', () => {
    saveBackendConnection({ name: 'First', transport: 'ssh', sshHost: 'build-server-box' });
    assert.throws(() => saveBackendConnection({
      name: 'Duplicate',
      transport: 'ssh',
      sshHost: 'build-server-box',
      sshPort: 22,
      remotePort: 3000,
    }), /already exists/);
  });
});

class StaticTunnelManager extends SshTunnelManager {
  readonly resolved: BackendConnectionRecord[] = [];

  constructor(private readonly targetApiUrl: string) {
    super();
  }

  override async apiUrl(connection: BackendConnectionRecord): Promise<string> {
    this.resolved.push(connection);
    return this.targetApiUrl;
  }
}

test('SSH proxy resolves the upstream URL through the injected tunnel manager', async () => {
  const remote = express();
  remote.get('/api/echo', (req, res) => {
    res.json({ authorization: req.headers.authorization });
  });
  const remoteServer = http.createServer(remote);
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remoteServer.address();
  assert.ok(remoteAddress && typeof remoteAddress === 'object');

  const saved = saveBackendConnection({
    name: 'SSH remote',
    transport: 'ssh',
    sshHost: 'build-server-box',
    token: 'remote-secret-token',
  });
  const tunnelManager = new StaticTunnelManager(`http://127.0.0.1:${remoteAddress.port}/api`);
  const gateway = express();
  gateway.use(express.json());
  gateway.use('/api', setupBackendConnectionRoutes({ tunnelManager }));
  const gatewayServer = http.createServer(gateway);
  await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = gatewayServer.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === 'object');

  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/api/backend-connections/${saved.id}/proxy/echo`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorization: 'Bearer remote-secret-token' });
    assert.equal(tunnelManager.resolved[0].transport, 'ssh');
  } finally {
    await new Promise<void>((resolve, reject) => gatewayServer.close((err) => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => remoteServer.close((err) => err ? reject(err) : resolve()));
  }
});

test('probe and streaming proxy authenticate to a Michi backend', async () => {
  const remote = express();
  remote.use(express.json());
  remote.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer remote-secret-token') {
      return res.status(401).json({ error: 'bad token' });
    }
    next();
  });
  remote.get('/api/health', (_req, res) => res.json({ status: 'healthy', service: 'michi-backend', serverId: 'remote-1' }));
  remote.get('/api/echo', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('event: chunk\ndata: {"text":"hello"}\n\n');
    res.end();
  });
  const remoteServer = http.createServer(remote);
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remoteServer.address();
  assert.ok(remoteAddress && typeof remoteAddress === 'object');
  const apiUrl = `http://127.0.0.1:${remoteAddress.port}`;

  try {
    const bad = await probeBackendConnection({ apiUrl, token: 'wrong' });
    assert.equal(bad.ok, false);
    const good = await probeBackendConnection({ apiUrl, token: 'remote-secret-token' });
    assert.deepEqual(good, { ok: true, apiUrl: `${apiUrl}/api`, serverId: 'remote-1' });

    const saved = saveBackendConnection({ name: 'Remote', apiUrl, token: 'remote-secret-token' });
    const gateway = express();
    gateway.use(express.json());
    gateway.use('/api', setupBackendConnectionRoutes());
    const gatewayServer = http.createServer(gateway);
    await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
    const gatewayAddress = gatewayServer.address();
    assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayAddress.port}/api/backend-connections/${saved.id}/proxy/echo`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /event: chunk/);
    } finally {
      await new Promise<void>((resolve, reject) => gatewayServer.close((err) => err ? reject(err) : resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => remoteServer.close((err) => err ? reject(err) : resolve()));
  }
});

test('streaming proxy detaches its upstream response when the renderer disconnects', async () => {
  let markRemoteClosed: (() => void) | null = null;
  const remoteClosed = new Promise<void>((resolve) => { markRemoteClosed = resolve; });
  const remote = express();
  remote.get('/api/hold', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(': connected\n\n');
    res.on('close', () => markRemoteClosed?.());
  });
  const remoteServer = http.createServer(remote);
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', resolve));
  const remoteAddress = remoteServer.address();
  assert.ok(remoteAddress && typeof remoteAddress === 'object');
  const saved = saveBackendConnection({
    name: 'Remote stream',
    apiUrl: `http://127.0.0.1:${remoteAddress.port}`,
  });

  const gateway = express();
  gateway.use(express.json());
  gateway.use('/api', setupBackendConnectionRoutes());
  const gatewayServer = http.createServer(gateway);
  await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = gatewayServer.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === 'object');

  try {
    const response = await fetch(
      `http://127.0.0.1:${gatewayAddress.port}/api/backend-connections/${saved.id}/proxy/hold`,
    );
    assert.equal(response.status, 200);
    await response.body?.cancel();
    await Promise.race([
      remoteClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('upstream stream stayed open')), 2_000)),
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => gatewayServer.close((err) => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => remoteServer.close((err) => err ? reject(err) : resolve()));
  }
});
