import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import net from 'node:net';
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
  test('uses SSH config defaults when user and ports are omitted', () => {
    const connection = sshConnection({ sshUser: undefined, sshPort: undefined, remotePort: undefined });
    const args = buildSshTunnelArgs(connection, 32123);
    assert.equal(args.at(-1), 'build-server-box');
    assert.equal(args.includes('-p'), false);
    assert.ok(args.includes('127.0.0.1:32123:127.0.0.1:3000'));
    assert.ok(args.includes('ConnectTimeout=30'), 'allow a cold SSH proxy to finish its handshake');
    assert.ok(args.includes('-C'), 'compress repetitive chat and workspace JSON over SSH');
    assert.ok(args.includes('ControlPath=none'));
    assert.ok(args.includes('ControlMaster=no'));
  });
});

describe('SshTunnelManager', () => {
  test('waits for forwarding when a cold proxy takes more than ten seconds', async (t) => {
    const server = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const child = createFakeChild();
    const manager = new SshTunnelManager({ allocatePort: async () => port, spawnSsh: () => child });
    let settled = false;
    const ready = manager.apiUrl(sshConnection()).finally(() => { settled = true; });
    // Observe an early rejection too, so a regression does not leak it.
    void ready.catch(() => {});
    const flushIo = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
    try {
      await flushIo();
      t.mock.timers.tick(14_000);
      await flushIo();
      assert.equal(settled, false, 'keep waiting while SSH is within its handshake budget');
      assert.equal(manager.status('remote-1').phase, 'connecting');
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
      t.mock.timers.tick(100);
      assert.equal(await ready, `http://127.0.0.1:${port}/api`);
      assert.equal(manager.status('remote-1').phase, 'connected');
    } finally {
      manager.shutdown();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('still bounds forwarding startup and terminates a stuck SSH process', async (t) => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const child = createFakeChild();
    const manager = new SshTunnelManager({ allocatePort: async () => port, spawnSsh: () => child });
    const rejected = assert.rejects(manager.apiUrl(sshConnection()), /Timed out waiting for SSH port forwarding/);
    try {
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(35_001);
      await rejected;
      assert.equal(child.killedWith, 'SIGTERM');
      assert.equal(manager.status('remote-1').phase, 'error');
    } finally { manager.shutdown(); }
  });

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

  test('reconnects after SSH exits without a renderer request, sharing the pending attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
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
    await assert.rejects(manager.apiUrl(sshConnection()), /SSH exited/);
    t.mock.timers.tick(1000);
    assert.equal(await manager.apiUrl(sshConnection()), 'http://127.0.0.1:32002/api');
    assert.equal(children.length, 2);
    manager.shutdown();
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

  test('a failed probe cannot stop the replacement tunnel', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const children: FakeChild[] = [];
    let port = 32000;
    const manager = new SshTunnelManager({
      allocatePort: async () => ++port,
      spawnSsh: () => { const child = createFakeChild(); children.push(child); return child; },
      waitUntilReady: async () => undefined,
    });
    try {
      const previous = await manager.apiUrl(sshConnection());
      emitExit(children[0], 255);
      t.mock.timers.tick(1000);
      const current = await manager.apiUrl(sshConnection());
      manager.stop('remote-1', previous);
      assert.equal(manager.status('remote-1').phase, 'connected');
      assert.equal(children[1].killedWith, undefined);
      assert.equal(await manager.apiUrl(sshConnection()), current);
      manager.stop('remote-1', current);
      assert.equal(children[1].killedWith, 'SIGTERM');
    } finally { manager.shutdown(); }
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
    manager.shutdown();
  });

  test('coalesces probes, tolerates transient failures and replaces only a persistently stalled forward', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const children: FakeChild[] = [];
    let port = 32000, alive = false, probes = 0;
    const manager = new SshTunnelManager({ allocatePort: async () => ++port,
      spawnSsh: () => { const child = createFakeChild(); children.push(child); return child; },
      waitUntilReady: async () => {}, probeTransport: async () => { probes++; return alive; },
      probeIntervalMs: 100, recoveryDelayMs: 10 });
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    try {
      await manager.apiUrl(sshConnection());
      manager.checkNow(); manager.checkNow(); await flush();
      assert.equal(probes, 1);
      t.mock.timers.tick(100); await flush();
      assert.equal(children[0].killedWith, undefined);
      alive = true;
      t.mock.timers.tick(100); await flush();
      alive = false;
      for (let i = 0; i < 2; i++) { t.mock.timers.tick(100); await flush(); }
      assert.equal(children[0].killedWith, undefined, 'success reset consecutive failures');
      t.mock.timers.tick(100); await flush();
      assert.equal(children[0].killedWith, 'SIGTERM');
      t.mock.timers.tick(10); await flush();
      assert.equal(children.length, 2);
    } finally { manager.shutdown(); }
  });

  test('local rebinds do not reset the bounded recovery budget and stop cancels scheduled work', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let starts = 0;
    const manager = new SshTunnelManager({ allocatePort: async () => 32123,
      spawnSsh: () => { starts++; return createFakeChild(); }, waitUntilReady: async () => {},
      probeTransport: async () => false, probeIntervalMs: 10, probeFailureThreshold: 1,
      maxRecoveryAttempts: 2, recoveryDelayMs: 10 });
    const tick = async (ms: number) => { t.mock.timers.tick(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); };
    try {
      await manager.apiUrl(sshConnection());
      await tick(10); await tick(10); await tick(10); await tick(20); await tick(10);
      assert.equal(starts, 3);
      assert.equal(manager.isSupervising('remote-1'), false);
      await assert.rejects(manager.apiUrl(sshConnection()), /stopped responding/);
      await tick(60_000);
      assert.equal(starts, 3);
      manager.stop('remote-1');
      await manager.apiUrl(sshConnection());
      await tick(10);
      manager.stop('remote-1');
      await tick(60_000);
      assert.equal(starts, 4);
    } finally { manager.shutdown(); }
  });

  test('a late failed health check cannot kill a new connection or reconnect after shutdown', async () => {
    let finish!: (alive: boolean) => void;
    const children: FakeChild[] = [];
    const manager = new SshTunnelManager({ allocatePort: async () => 32123,
      spawnSsh: () => { const child = createFakeChild(); children.push(child); return child; }, waitUntilReady: async () => {},
      probeTransport: () => new Promise(resolve => { finish = resolve; }), probeFailureThreshold: 1 });
    await manager.apiUrl(sshConnection());
    manager.checkNow();
    manager.stop('remote-1');
    await manager.apiUrl(sshConnection());
    finish(false);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(children[1].killedWith, undefined);
    assert.equal(manager.status('remote-1').phase, 'connected');
    manager.shutdown();
    assert.equal(manager.isSupervising('remote-1'), false);
  });
});
