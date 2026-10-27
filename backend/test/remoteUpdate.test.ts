import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import express from 'express';
import type { RemoteUpdateJob } from 'michi-shared';
import { compareRemoteBuild, type BuildInfo } from '../src/services/buildInfo';
import { RemoteDesktopError, RemoteDesktopSetup } from '../src/services/remoteDesktopSetup';
import { saveBackendConnection } from '../src/services/backendConnections';
import { SshTunnelManager } from '../src/services/sshTunnelManager';
import { setupBackendConnectionRoutes } from '../src/routes/backendConnections';

const oldHash = 'a'.repeat(40), newHash = 'b'.repeat(40);
const build: BuildInfo = { version: '1.0.0', revision: newHash, ancestors: [newHash, oldHash] };
let dir: string, previousDataDir: string | undefined;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-remote-update-'))); previousDataDir = process.env.MICHI_DATA_DIR; process.env.MICHI_DATA_DIR = dir; });
afterEach(() => { if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir; fs.rmSync(dir, { recursive: true, force: true }); });

test('only an ancestor of the running local build is older, including legacy short hashes', () => {
  for (const revision of [oldHash, oldHash.slice(0, 7)]) assert.equal(compareRemoteBuild(build, { version: '1.0.0', revision }, true).state, 'older');
  assert.equal(compareRemoteBuild(build, { version: '1.0.0', revision: newHash }, true).state, 'current');
  for (const revision of ['c'.repeat(40), 'd'.repeat(7)]) assert.equal(compareRemoteBuild(build, { version: '1.0.0', revision }, true).canUpdate, false);
  assert.equal(compareRemoteBuild(build, null, true).state, 'unknown');
  assert.equal(compareRemoteBuild(build, { version: '1.0.0', revision: 'invalid' }, true).state, 'unknown');
  assert.equal(compareRemoteBuild(build, { version: '1.0.0', revision: oldHash }, false).canUpdate, false);
  assert.equal(compareRemoteBuild({ ...build, dirty: true }, { version: '1.0.0', revision: oldHash }, true).canUpdate, false);
});

test('checks legacy remote version with the saved token and verifies the running build after update', async () => {
  let updated = false, inspections = 0;
  const token = 'private-remote-token';
  const remote = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/version' ? { localHash: oldHash.slice(0, 7) }
      : { service: 'michi-backend', status: 'healthy', ...(updated ? { build: { version: '1.0.0', revision: newHash } } : {}) }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address(); assert.ok(address && typeof address !== 'string');
  class Tunnels extends SshTunnelManager { override async apiUrl() { return `http://127.0.0.1:${(address as { port: number }).port}/api`; } override stop() {} }
  const connection = saveBackendConnection({ name: 'box', transport: 'ssh', sshHost: 'box', remotePort: 4444, token });
  const setup = new RemoteDesktopSetup({ build, tunnelManager: new Tunnels(), runSsh: async (_target, script) => {
    inspections++;
    if (script.includes('MICHI_PROGRESS:build')) { assert.match(script, new RegExp(newHash)); updated = true; }
    return 'MICHI_SETUP_JSON:' + JSON.stringify({ repo: '/remote/source', dataDir: '/remote/data', home: '/remote', healthy: true, token, port: 4444 });
  } });
  try {
    assert.equal((await setup.checkVersion(connection.id)).state, 'older');
    assert.equal((await setup.update(connection.id, () => {})).state, 'current');
    assert.equal(inspections, 2);
  } finally { await new Promise<void>(resolve => remote.close(() => resolve())); }
});

test('update routes enforce local control, reject duplicates, and finish after the renderer disconnects', async () => {
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  class Setup extends RemoteDesktopSetup {
    override async update() { calls++; started(); await pending; return compareRemoteBuild(build, { version: '1.0.0', revision: newHash }, true); }
  }
  const connection = saveBackendConnection({ name: 'box', transport: 'ssh', sshHost: 'box' });
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: new Setup() }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/backend-connections/${connection.id}/update`;
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const response = await fetch(url, { method: 'POST' }); await start;
    assert.equal((await fetch(url, { method: 'POST' })).status, 409);
    await response.body!.cancel(); complete();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally { complete(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function serveUpdates(setup: RemoteDesktopSetup, id: string) {
  const app = express(); app.use(express.json()); app.use('/api', setupBackendConnectionRoutes({ remoteSetup: setup }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/backend-connections/${id}`;
  const read = async () => (await (await fetch(base + '/update')).json() as { update: RemoteUpdateJob | null }).update;
  const settled = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await read();
      if (job?.phase !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('The update did not finish.');
  };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { base, read, settled, close };
}

test('a reopened view can read a detached update’s progress and outcome until the connection is removed', async () => {
  let complete!: () => void; const pending = new Promise<void>(resolve => { complete = resolve; });
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  class Setup extends RemoteDesktopSetup {
    override async update(_id: string, progress: (stage: string, message: string) => void) {
      progress('build', 'Building remotely…'); started(); await pending;
      return compareRemoteBuild(build, { version: '1.0.0', revision: newHash }, true);
    }
  }
  const connection = saveBackendConnection({ name: 'box', transport: 'ssh', sshHost: 'box' });
  const gateway = await serveUpdates(new Setup(), connection.id);
  try {
    assert.equal(await gateway.read(), null);
    const response = await fetch(gateway.base + '/update', { method: 'POST' }); await start;
    await response.body!.cancel();
    const running = await gateway.read();
    assert.ok(running);
    assert.equal(running.phase, 'running'); assert.equal(running.stage, 'build'); assert.equal(running.message, 'Building remotely…');
    assert.equal(running.diagnostic, undefined); assert.equal(running.finishedAt, undefined);
    assert.equal((await fetch(gateway.base + '/update', { method: 'POST' })).status, 409);
    assert.equal((await fetch(gateway.base, { method: 'DELETE' })).status, 409);
    complete();
    const done = await gateway.settled();
    assert.ok(done);
    assert.equal(done.phase, 'succeeded'); assert.equal(done.attemptId, running.attemptId);
    assert.equal(done.result?.state, 'current'); assert.ok(done.finishedAt);
    assert.equal((await fetch(gateway.base, { method: 'DELETE' })).status, 200);
    assert.equal(await gateway.read(), null);
  } finally { complete(); await gateway.close(); }
});

test('a failed update keeps its saved report for reopened views and releases the machine', async () => {
  class Setup extends RemoteDesktopSetup {
    override async update(_id: string, progress: (stage: string, message: string) => void): Promise<never> {
      progress('build', 'Building remotely…');
      throw new RemoteDesktopError('build', 'Remote build failed.');
    }
  }
  const connection = saveBackendConnection({ name: 'box', transport: 'ssh', sshHost: 'box' });
  const gateway = await serveUpdates(new Setup(), connection.id);
  try {
    const response = await fetch(gateway.base + '/update', { method: 'POST' });
    assert.match(await response.text(), /"type":"error"/);
    const failed = await gateway.settled();
    assert.ok(failed);
    assert.equal(failed.phase, 'failed'); assert.equal(failed.message, 'Remote build failed.');
    assert.equal(failed.diagnostic?.id, failed.attemptId); assert.equal(failed.diagnostic?.code, 'build');
    assert.match(failed.diagnostic?.log ?? '', /Remote build failed/);
    const retry = await fetch(gateway.base + '/update', { method: 'POST' });
    assert.equal(retry.status, 200); await retry.text();
  } finally { await gateway.close(); }
});
