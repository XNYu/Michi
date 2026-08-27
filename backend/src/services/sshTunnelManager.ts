import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { BackendConnectionRecord } from './backendConnections';

export type SshTunnelPhase = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SshTunnelStatus {
  phase: SshTunnelPhase;
  error?: string;
}

type SpawnSsh = (binary: string, args: string[]) => ChildProcess;

interface TunnelState {
  configKey: string;
  localPort?: number;
  process?: ChildProcess;
  ready: Promise<string>;
  stderr: string;
}

interface SshTunnelManagerDeps {
  spawnSsh?: SpawnSsh;
  allocatePort?: () => Promise<number>;
  waitUntilReady?: (port: number, process: ChildProcess) => Promise<void>;
  sshBinary?: string;
}

function connectionConfigKey(connection: BackendConnectionRecord): string {
  return [
    connection.sshUser ?? '',
    connection.sshHost ?? '',
    connection.sshPort ?? 22,
    connection.remotePort ?? 3000,
  ].join('\0');
}

export function buildSshTunnelArgs(connection: BackendConnectionRecord, localPort: number): string[] {
  if (connection.transport !== 'ssh' || !connection.sshHost) {
    throw new Error('SSH connection configuration is incomplete');
  }
  const target = connection.sshUser
    ? `${connection.sshUser}@${connection.sshHost}`
    : connection.sshHost;
  const args = [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=yes',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${connection.remotePort ?? 3000}`,
  ];
  if (connection.sshPort) args.push('-p', String(connection.sshPort));
  args.push(target);
  return args;
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a local SSH port')));
        return;
      }
      const port = address.port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

async function waitForLoopbackPort(port: number, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (process.exitCode !== null) throw new Error(`SSH exited with code ${process.exitCode}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(250);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for SSH port forwarding');
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
}

function defaultSpawn(binary: string, args: string[]): ChildProcess {
  return spawn(binary, args, {
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

export class SshTunnelManager {
  private readonly states = new Map<string, TunnelState>();
  private readonly statuses = new Map<string, SshTunnelStatus>();
  private readonly spawnSsh: SpawnSsh;
  private readonly allocatePort: () => Promise<number>;
  private readonly waitUntilReady: (port: number, process: ChildProcess) => Promise<void>;
  private readonly sshBinary: string;

  constructor(deps: SshTunnelManagerDeps = {}) {
    this.spawnSsh = deps.spawnSsh ?? defaultSpawn;
    this.allocatePort = deps.allocatePort ?? allocateLoopbackPort;
    this.waitUntilReady = deps.waitUntilReady ?? waitForLoopbackPort;
    this.sshBinary = deps.sshBinary ?? (process.env.MICHI_SSH_BIN?.trim() || 'ssh');
  }

  status(connectionId: string): SshTunnelStatus {
    return this.statuses.get(connectionId) ?? { phase: 'disconnected' };
  }

  async apiUrl(connection: BackendConnectionRecord): Promise<string> {
    if (connection.transport === 'direct') return connection.apiUrl;
    const configKey = connectionConfigKey(connection);
    const existing = this.states.get(connection.id);
    if (
      existing?.configKey === configKey
      && (!existing.process || existing.process.exitCode === null)
    ) {
      return existing.ready;
    }
    if (existing) this.stop(connection.id);

    this.statuses.set(connection.id, { phase: 'connecting' });
    const state: TunnelState = {
      configKey,
      ready: Promise.resolve(''),
      stderr: '',
    };
    this.states.set(connection.id, state);

    state.ready = (async () => {
      try {
        const localPort = await this.allocatePort();
        if (this.states.get(connection.id) !== state) {
          throw new Error('SSH tunnel was stopped');
        }
        state.localPort = localPort;
        const child = this.spawnSsh(this.sshBinary, buildSshTunnelArgs(connection, localPort));
        state.process = child;
        child.stderr?.on('data', (chunk) => {
          state.stderr = `${state.stderr}${String(chunk)}`.slice(-4_000);
        });
        child.once('exit', (code, signal) => {
          if (this.states.get(connection.id) !== state) return;
          this.states.delete(connection.id);
          const detail = state.stderr.trim() || `SSH exited (${code ?? signal ?? 'unknown'})`;
          this.statuses.set(connection.id, { phase: 'error', error: detail });
        });
        const childFailure = new Promise<never>((_resolve, reject) => {
          child.once('error', (err) => reject(err));
          child.once('exit', (code, signal) => {
            reject(new Error(`SSH exited (${code ?? signal ?? 'unknown'})`));
          });
        });
        await Promise.race([this.waitUntilReady(localPort, child), childFailure]);
        if (this.states.get(connection.id) !== state) {
          throw new Error('SSH tunnel was stopped');
        }
        this.statuses.set(connection.id, { phase: 'connected' });
        return `http://127.0.0.1:${localPort}/api`;
      } catch (err) {
        const detail = state.stderr.trim();
        if (this.states.get(connection.id) === state) {
          this.states.delete(connection.id);
          this.statuses.set(connection.id, {
            phase: 'error',
            error: detail || (err as Error).message,
          });
        }
        if (state.process?.exitCode === null) state.process.kill('SIGTERM');
        throw new Error(detail || (err as Error).message);
      }
    })();
    return state.ready;
  }

  stop(connectionId: string): void {
    const state = this.states.get(connectionId);
    this.states.delete(connectionId);
    this.statuses.set(connectionId, { phase: 'disconnected' });
    if (state?.process?.exitCode === null) state.process.kill('SIGTERM');
  }

  shutdown(): void {
    for (const id of Array.from(this.states.keys())) this.stop(id);
  }
}

export const sshTunnelManager = new SshTunnelManager();
