import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackendConnectionRecord } from '../src/services/backendConnections';
import { buildSshTunnelArgs, SshTunnelManager } from '../src/services/sshTunnelManager';

type FakeChild = ChildProcess & {
  killedWith?: NodeJS.Signals | number;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stderr: new PassThrough(),
    exitCode: null,
    killedWith: undefined,
    kill(signal: NodeJS.Signals | number = 'SIGTERM') {
      child.killedWith = signal;
      (child as unknown as { exitCode: number | null }).exitCode = 0;
      child.emit('exit', null, signal);
      return true;
    },
  });
  return child;
}

function emitExit(child: FakeChild, code: number): void {
  (child as unknown as { exitCode: number | null }).exitCode = code;
  child.emit('exit', code, null);
}

function sshConnection(overrides: Partial<BackendConnectionRecord> = {}): BackendConnectionRecord {
  return {
    id: 'remote-1',
    name: 'Build box',
    transport: 'ssh',
    apiUrl: '',
    sshHost: 'build-server-box',
    sshUser: 'builder',
    sshPort: 2222,
    remotePort: 4649,
    token: 'remote-secret-token',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SSH tunnel arguments', () => {
  test('uses fixed safety options and passes the target without a shell', () => {
    assert.deepEqual(buildSshTunnelArgs(sshConnection(), 32123), [
      '-N',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=yes',
      '-L', '127.0.0.1:32123:127.0.0.1:4649',
      '-p', '2222',
      'builder@build-server-box',
    ]);
  });

  test('uses SSH config defaults when user and ports are omitted', () => {
    const connection = sshConnection({ sshUser: undefined, sshPort: undefined, remotePort: undefined });
    const args = buildSshTunnelArgs(connection, 32123);
    assert.equal(args.at(-1), 'build-server-box');
    assert.equal(args.includes('-p'), false);
    assert.ok(args.includes('127.0.0.1:32123:127.0.0.1:3000'));
  });
});

describe('SshTunnelManager', () => {
  test('deduplicates concurrent starts for one connection', async () => {
    const child = createFakeChild();
    let spawnCount = 0;
    let releasePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => { releasePort = resolve; });
    const manager = new SshTunnelManager({
      sshBinary: '/usr/bin/ssh',
      allocatePort: () => port,
      spawnSsh: (binary, args) => {
        spawnCount += 1;
        assert.equal(binary, '/usr/bin/ssh');
        assert.equal(args.at(-1), 'builder@build-server-box');
        return child;
      },
      waitUntilReady: async () => undefined,
    });

    const first = manager.apiUrl(sshConnection());
    const second = manager.apiUrl(sshConnection());
    releasePort(32123);

    assert.equal(await first, 'http://127.0.0.1:32123/api');
    assert.equal(await second, 'http://127.0.0.1:32123/api');
    assert.equal(spawnCount, 1);
    assert.deepEqual(manager.status('remote-1'), { phase: 'connected' });
    manager.shutdown();
  });

  test('starts a fresh process on the request after SSH exits', async () => {
    const children: FakeChild[] = [];
    let nextPort = 32000;
    const manager = new SshTunnelManager({
      allocatePort: async () => ++nextPort,
      spawnSsh: () => {
        const child = createFakeChild();
        children.push(child);
        return child;
      },
      waitUntilReady: async () => undefined,
    });

    assert.equal(await manager.apiUrl(sshConnection()), 'http://127.0.0.1:32001/api');
    emitExit(children[0], 255);
    assert.equal(manager.status('remote-1').phase, 'error');
    assert.equal(await manager.apiUrl(sshConnection()), 'http://127.0.0.1:32002/api');
    assert.equal(children.length, 2);
    manager.shutdown();
  });

  test('stop terminates a live process and marks it disconnected', async () => {
    const child = createFakeChild();
    const manager = new SshTunnelManager({
      allocatePort: async () => 32123,
      spawnSsh: () => child,
      waitUntilReady: async () => undefined,
    });
    await manager.apiUrl(sshConnection());

    manager.stop('remote-1');

    assert.equal(child.killedWith, 'SIGTERM');
    assert.deepEqual(manager.status('remote-1'), { phase: 'disconnected' });
  });

  test('stop during port allocation prevents a late process spawn', async () => {
    let releasePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => { releasePort = resolve; });
    let spawnCount = 0;
    const manager = new SshTunnelManager({
      allocatePort: () => port,
      spawnSsh: () => {
        spawnCount += 1;
        return createFakeChild();
      },
    });
    const pending = manager.apiUrl(sshConnection());
    manager.stop('remote-1');
    releasePort(32123);

    await assert.rejects(pending, /SSH tunnel was stopped/);
    assert.equal(spawnCount, 0);
    assert.deepEqual(manager.status('remote-1'), { phase: 'disconnected' });
  });

  test('reports SSH stderr when readiness fails', async () => {
    const child = createFakeChild();
    const manager = new SshTunnelManager({
      allocatePort: async () => 32123,
      spawnSsh: () => child,
      waitUntilReady: async () => {
        (child.stderr as PassThrough).write('Permission denied (publickey).\n');
        throw new Error('port never opened');
      },
    });

    await assert.rejects(manager.apiUrl(sshConnection()), /Permission denied/);
    assert.equal(child.killedWith, 'SIGTERM');
    assert.match(manager.status('remote-1').error ?? '', /Permission denied/);
  });

  test('returns direct URLs without allocating or spawning', async () => {
    let touched = false;
    const manager = new SshTunnelManager({
      allocatePort: async () => { touched = true; return 32123; },
      spawnSsh: () => { touched = true; return createFakeChild(); },
    });
    const direct = sshConnection({
      transport: 'direct',
      apiUrl: 'https://michi.example.com/api',
      sshHost: undefined,
    });

    assert.equal(await manager.apiUrl(direct), 'https://michi.example.com/api');
    assert.equal(touched, false);
  });
});
