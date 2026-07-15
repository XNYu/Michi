import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findCodexBinary, preflightCodexAuth, warnIfCodexVersionBelowMinimum } from './codexBinary';
import type { CodexIncoming, CodexRpcId } from './codexProtocol';

export class CodexRpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexRpcTimeoutError';
  }
}

export class CodexDaemonExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexDaemonExitedError';
  }
}

const RPC_TIMEOUT_MS = parseInt(process.env.MICHI_CODEX_RPC_TIMEOUT_MS ?? '30000', 10);
const INIT_TIMEOUT_MS = parseInt(process.env.MICHI_CODEX_INIT_TIMEOUT_MS ?? '30000', 10);

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
) => void;

export interface CodexAppServerClientDeps {
  /** Test seam: returns a ChildProcess-like. Default spawns the real binary. */
  spawnFn?: () => ChildProcessWithoutNullStreams;
  /** Optional isolated environment for the app-server child. */
  spawnEnv?: NodeJS.ProcessEnv;
  rpcTimeoutMs?: number;
  initTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * Singleton owner of the `codex app-server` daemon. JSONL JSON-RPC over
 * stdio. Spawned hermetically with `-c 'mcp_servers={}'` so the user's
 * personal MCP fleet never starts for Michi threads (spec §2); everything
 * else (auth, custom model providers) still loads from ~/.codex, and the
 * child inherits the backend's full process.env (provider env_keys).
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly threadHandlers = new Map<string, Set<NotificationHandler>>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readonly exitHandlers = new Set<() => void>();
  private lineBuf = '';
  private readonly rpcTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly spawnFn: () => ChildProcessWithoutNullStreams;
  private shuttingDown = false;

  constructor(deps: CodexAppServerClientDeps = {}) {
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    this.initTimeoutMs = deps.initTimeoutMs ?? INIT_TIMEOUT_MS;
    const spawnEnv = deps.spawnEnv ? { ...deps.spawnEnv } : { ...process.env };
    this.spawnFn =
      deps.spawnFn ??
      (() => {
        preflightCodexAuth();
        warnIfCodexVersionBelowMinimum();
        return spawn(findCodexBinary(), ['app-server', '-c', 'mcp_servers={}'], {
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const child = this.spawnFn();
    this.child = child;
    this.lineBuf = '';

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn('[codex app-server stderr]', text.slice(0, 500));
    });
    child.on('exit', (code) => this.onExited(code));
    child.on('error', (err) => {
      console.error('[CodexAppServerClient] spawn error:', err);
      this.onExited(null);
    });

    await this.requestWithTimeout(
      'initialize',
      {
        clientInfo: { name: 'michi', title: 'Michi', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
      this.initTimeoutMs,
    ).catch((err) => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      this.child = null;
      throw err;
    });

    // Send 'initialized' notification (no id) per protocol handshake
    this.writeLine({ jsonrpc: '2.0', method: 'initialized' });
  }

  private onStdout(text: string): void {
    this.lineBuf += text;
    let nl: number;
    while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, nl).trim();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (!line) continue;
      let obj: CodexIncoming;
      try {
        obj = JSON.parse(line) as CodexIncoming;
      } catch {
        continue; // tolerate non-JSON noise (e.g. banner lines)
      }
      this.dispatch(obj);
    }
  }

  private dispatch(obj: CodexIncoming): void {
    // Response to one of our requests (numeric ids we minted)
    if (obj.id !== undefined && obj.method === undefined) {
      const entry = typeof obj.id === 'number' ? this.pending.get(obj.id) : undefined;
      if (!entry) return;
      this.pending.delete(obj.id as number);
      clearTimeout(entry.timer);
      if (obj.error) {
        entry.reject(
          new Error(
            `codex ${entry.method} failed: ${obj.error.message} (code ${obj.error.code})`,
          ),
        );
      } else {
        entry.resolve(obj.result);
      }
      return;
    }

    // Server→client REQUEST (has both id and method) — approval flow
    if (obj.id !== undefined && typeof obj.method === 'string') {
      const rpcId = obj.id as CodexRpcId;
      const respond = (result: unknown) => this.writeLine({ jsonrpc: '2.0', id: rpcId, result });
      if (this.serverRequestHandler) {
        this.serverRequestHandler(
          obj.method,
          (obj.params as Record<string, unknown>) ?? {},
          respond,
        );
      } else {
        // No handler registered — fail safe, decline whatever was asked.
        respond({ decision: 'decline' });
      }
      return;
    }

    // Notification (has method, no id)
    if (typeof obj.method === 'string') {
      const params = (obj.params as Record<string, unknown>) ?? {};
      const threadId =
        typeof params['threadId'] === 'string' ? (params['threadId'] as string) : null;
      if (threadId) {
        for (const h of this.threadHandlers.get(threadId) ?? []) h(obj.method, params);
      }
      // Notifications without threadId (account/*, warnings) are intentionally dropped.
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.requestWithTimeout(method, params, this.rpcTimeoutMs);
  }

  private requestWithTimeout(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(
        new CodexDaemonExitedError('codex app-server is not running'),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexRpcTimeoutError(
            `codex ${method} got no response within ${timeoutMs}ms — check provider env vars / daemon stderr`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.writeLine({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeLine(obj: unknown): void {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      console.warn('[CodexAppServerClient] stdin write failed:', err);
    }
  }

  onNotification(threadId: string, handler: NotificationHandler): () => void {
    let set = this.threadHandlers.get(threadId);
    if (!set) {
      set = new Set();
      this.threadHandlers.set(threadId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.threadHandlers.delete(threadId);
    };
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onExit(cb: () => void): () => void {
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }

  private onExited(code: number | null): void {
    if (!this.child) return;
    this.child = null;
    const err = new CodexDaemonExitedError(
      `codex app-server exited (code ${code ?? 'unknown'})`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (!this.shuttingDown) {
      for (const cb of this.exitHandlers) {
        try {
          cb();
        } catch (cbErr) {
          console.warn('[CodexAppServerClient] exit handler threw:', cbErr);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    });
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexDaemonExitedError('shutdown'));
    }
    this.pending.clear();
  }
}
