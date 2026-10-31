import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { BackendConnectionRecord } from './backendConnections';

// ProxyCommand transports (such as WSSH) can take over ten seconds to
// establish a cold connection after the desktop backend hands over to launchd.
export const SSH_CONNECT_TIMEOUT_SECONDS = 30;
const FORWARD_READY_TIMEOUT_MS = (SSH_CONNECT_TIMEOUT_SECONDS + 5) * 1000;

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

interface TunnelIntent {
  connection: BackendConnectionRecord;
  attempts: number;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  probe?: AbortController;
}

interface SshTunnelManagerDeps {
  spawnSsh?: SpawnSsh;
  allocatePort?: () => Promise<number>;
  waitUntilReady?: (port: number, process: ChildProcess) => Promise<void>;
  sshBinary?: string;
  probeTransport?: (apiUrl: string, signal: AbortSignal) => Promise<boolean>;
  probeIntervalMs?: number;
  probeFailureThreshold?: number;
  maxRecoveryAttempts?: number;
  recoveryDelayMs?: number;
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
    '-C',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'StrictHostKeyChecking=yes',
    // The supervised child must own its forward, even when ssh_config enables
    // multiplexing. Continue inheriting routing, ProxyCommand and identities.
    '-o', 'ControlPath=none',
    '-o', 'ControlMaster=no',
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
  const deadline = Date.now() + FORWARD_READY_TIMEOUT_MS;
  for (;;) {
    if (process.exitCode !== null || process.signalCode || process.killed) throw new Error(`SSH exited (${process.exitCode ?? process.signalCode ?? 'stopped'})`);
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

async function probeTransport(apiUrl: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]), redirect: 'manual',
    });
    // Even an auth/service error proves that the forward carries bytes. The
    // caller still has to verify Michi identity, credentials and readiness.
    await response.body?.cancel();
    return true;
  } catch { return false; }
}

export class SshTunnelManager {
  private readonly states = new Map<string, TunnelState>();
  private readonly statuses = new Map<string, SshTunnelStatus>();
  private readonly spawnSsh: SpawnSsh;
  private readonly allocatePort: () => Promise<number>;
  private readonly waitUntilReady: (port: number, process: ChildProcess) => Promise<void>;
  private readonly sshBinary: string;
  private readonly intents = new Map<string, TunnelIntent>();
  private readonly probeTransport: NonNullable<SshTunnelManagerDeps['probeTransport']>;
  private readonly probeIntervalMs: number;
  private readonly probeFailureThreshold: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryDelayMs: number;

  constructor(deps: SshTunnelManagerDeps = {}) {
    this.spawnSsh = deps.spawnSsh ?? defaultSpawn;
    this.allocatePort = deps.allocatePort ?? allocateLoopbackPort;
    this.waitUntilReady = deps.waitUntilReady ?? waitForLoopbackPort;
    this.sshBinary = deps.sshBinary ?? (process.env.MICHI_SSH_BIN?.trim() || 'ssh');
    this.probeTransport = deps.probeTransport ?? probeTransport;
    this.probeIntervalMs = deps.probeIntervalMs ?? 15_000;
    this.probeFailureThreshold = deps.probeFailureThreshold ?? 3;
    this.maxRecoveryAttempts = deps.maxRecoveryAttempts ?? 6;
    this.recoveryDelayMs = deps.recoveryDelayMs ?? 1_000;
  }

  isSupervising(connectionId: string): boolean {
    const intent = this.intents.get(connectionId);
    return !!intent && (!!intent.timer || this.status(connectionId).phase === 'connecting'
      || this.status(connectionId).phase === 'connected' || intent.attempts < this.maxRecoveryAttempts);
  }

  /** One early, coalesced health check after a failed request or host wake. */
  checkNow(connectionId?: string): void {
    for (const [id, intent] of this.intents) {
      if (connectionId && connectionId !== id) continue;
      if (this.status(id).phase === 'connected') void this.check(id, intent);
    }
  }

  private schedule(id: string, intent: TunnelIntent, delay: number, run: () => void): void {
    clearTimeout(intent.timer);
    intent.timer = setTimeout(() => {
      intent.timer = undefined;
      if (this.intents.get(id) === intent) run();
    }, delay);
    intent.timer.unref?.();
  }

  private async check(id: string, intent: TunnelIntent): Promise<void> {
    const state = this.states.get(id);
    if (intent.probe || !state?.localPort || this.status(id).phase !== 'connected') return;
    const controller = new AbortController();
    intent.probe = controller;
    let alive = false;
    try { alive = await this.probeTransport(`http://127.0.0.1:${state.localPort}/api`, controller.signal); }
    catch { /* probes cannot escape the supervisor */ }
    finally { if (intent.probe === controller) intent.probe = undefined; }
    if (controller.signal.aborted || this.intents.get(id) !== intent || this.states.get(id) !== state) return;
    if (alive) {
      intent.failures = 0;
      intent.attempts = 0; // A local bind alone never resets the retry budget.
    } else if (++intent.failures >= this.probeFailureThreshold) {
      this.detach(id);
      this.statuses.set(id, { phase: 'error', error: 'SSH forwarding stopped responding' });
      this.retry(id, intent);
      return;
    }
    this.schedule(id, intent, alive ? this.probeIntervalMs : Math.min(2_000, this.probeIntervalMs), () => { void this.check(id, intent); });
  }

  private retry(id: string, intent: TunnelIntent): void {
    if (this.intents.get(id) !== intent || intent.timer || intent.attempts >= this.maxRecoveryAttempts) return;
    const delay = Math.min(30_000, this.recoveryDelayMs * 2 ** intent.attempts++);
    this.schedule(id, intent, delay, () => {
      intent.failures = 0;
      void this.open(intent.connection, intent).catch(() => {});
    });
  }

  status(connectionId: string): SshTunnelStatus {
    return this.statuses.get(connectionId) ?? { phase: 'disconnected' };
  }

  async apiUrl(connection: BackendConnectionRecord, onDiagnostic?: (source: string, message: string) => void): Promise<string> {
    if (connection.transport === 'direct') return connection.apiUrl;
    const configKey = connectionConfigKey(connection);
    let intent = this.intents.get(connection.id);
    if (intent && connectionConfigKey(intent.connection) !== configKey) this.stop(connection.id);
    intent = this.intents.get(connection.id);
    if (!intent) {
      intent = { connection: { ...connection }, attempts: 0, failures: 0 };
      this.intents.set(connection.id, intent);
    }
    const existing = this.states.get(connection.id);
    if (
      existing?.configKey === configKey
      && (!existing.process || existing.process.exitCode === null)
    ) {
      return existing.ready;
    }
    if (intent.timer && this.status(connection.id).phase === 'error') {
      throw new Error(this.status(connection.id).error ?? 'SSH reconnecting');
    }
    if (intent.attempts >= this.maxRecoveryAttempts) throw new Error(this.status(connection.id).error ?? 'SSH recovery exhausted');
    if (existing) this.detach(connection.id);
    return this.open(connection, intent, onDiagnostic);
  }

  private async open(connection: BackendConnectionRecord, intent: TunnelIntent,
    onDiagnostic?: (source: string, message: string) => void): Promise<string> {
    if (this.intents.get(connection.id) !== intent) throw new Error('SSH tunnel was stopped');
    clearTimeout(intent.timer);
    intent.timer = undefined;

    this.statuses.set(connection.id, { phase: 'connecting' });
    const state: TunnelState = {
      configKey: connectionConfigKey(connection),
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
        const args = buildSshTunnelArgs(connection, localPort);
        onDiagnostic?.('tunnel command', this.sshBinary + ' ' + args.join(' '));
        const child = this.spawnSsh(this.sshBinary, args);
        let diagnosticStderr = '';
        if (onDiagnostic) child.stderr?.on('data', chunk => { diagnosticStderr = (diagnosticStderr + String(chunk)).slice(-2_000_000); });
        const recordDiagnostic = () => onDiagnostic?.('tunnel stderr (last 2 MB)', diagnosticStderr || '[empty]');
        if (onDiagnostic) child.once('error', error => onDiagnostic('tunnel spawn', error.stack ?? error.message));
        if (onDiagnostic) child.once('close', (code, signal) => { recordDiagnostic(); onDiagnostic('tunnel exit', 'code=' + code + ' signal=' + signal); });
        state.process = child;
        child.stderr?.on('data', (chunk) => {
          state.stderr = `${state.stderr}${String(chunk)}`.slice(-4_000);
        });
        child.once('exit', (code, signal) => {
          if (this.states.get(connection.id) !== state) return;
          this.detach(connection.id);
          const detail = state.stderr.trim() || `SSH exited (${code ?? signal ?? 'unknown'})`;
          this.statuses.set(connection.id, { phase: 'error', error: detail });
          this.retry(connection.id, intent);
        });
        const childFailure = new Promise<never>((_resolve, reject) => {
          child.once('error', (err) => reject(err));
          child.once('exit', (code, signal) => {
            reject(new Error(`SSH exited (${code ?? signal ?? 'unknown'})`));
          });
        });
        try { await Promise.race([this.waitUntilReady(localPort, child), childFailure]); }
        finally { recordDiagnostic(); }
        if (this.states.get(connection.id) !== state) {
          throw new Error('SSH tunnel was stopped');
        }
        this.statuses.set(connection.id, { phase: 'connected' });
        this.schedule(connection.id, intent, this.probeIntervalMs, () => { void this.check(connection.id, intent); });
        return `http://127.0.0.1:${localPort}/api`;
      } catch (err) {
        const detail = state.stderr.trim();
        if (this.states.get(connection.id) === state) {
          this.states.delete(connection.id);
          this.statuses.set(connection.id, {
            phase: 'error',
            error: detail || (err as Error).message,
          });
          this.retry(connection.id, intent);
        }
        if (state.process?.exitCode === null) state.process.kill('SIGTERM');
        throw new Error(detail || (err as Error).message);
      }
    })();
    return state.ready;
  }

  stop(connectionId: string, expectedApiUrl?: string): void {
    const state = this.states.get(connectionId);
    // A failed probe belongs to one tunnel. A concurrent reconnect may have
    // already replaced it while that probe was in flight.
    if (expectedApiUrl && (!state?.localPort || expectedApiUrl !== `http://127.0.0.1:${state.localPort}/api`)) return;
    const intent = this.intents.get(connectionId);
    this.intents.delete(connectionId);
    clearTimeout(intent?.timer);
    intent?.probe?.abort();
    this.detach(connectionId);
    this.statuses.set(connectionId, { phase: 'disconnected' });
  }

  private detach(connectionId: string): void {
    const state = this.states.get(connectionId);
    this.states.delete(connectionId);
    const intent = this.intents.get(connectionId);
    clearTimeout(intent?.timer);
    if (intent) { intent.timer = undefined; intent.probe?.abort(); intent.probe = undefined; }
    if (state?.process?.exitCode === null) state.process.kill('SIGTERM');
  }

  shutdown(): void {
    for (const id of Array.from(this.intents.keys())) this.stop(id);
  }
}

export const sshTunnelManager = new SshTunnelManager();
